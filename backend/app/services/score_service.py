"""Scoring orchestration.

Fetch the cycle, resolve the rasters, run zonal statistics, score, cache,
assemble. The models themselves are pure functions over already reduced values,
which is what makes them testable.

Where a raster has not been ingested yet, these return NOT_CONFIGURED rather
than fabricating a number. See .claude/memory/data-source-status.md.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.db import repositories
from app.geo import zonal
from app.models import cari as cari_model
from app.models import hotspot as hotspot_model
from app.models import susceptibility as susc_model
from app.shared import contracts, timeutil
from app.shared.errors import Busy, NotConfigured
from app.shared.logging import logger

# Bounds heavy raster work. Over the limit callers get 503 rather than every
# request queueing and timing out together.
_jobs = asyncio.Semaphore(settings.max_concurrent_jobs)

# A separate gate for batch scoring (the choropleth). It bounds concurrency the
# same way but never rejects: a whole-layer pass deliberately queues hundreds of
# features, which is exactly what the request-facing _Job is built to refuse. It
# runs wider than the request gate because a tehsil pass is 553 features each
# clipping 13 rasters, and the reads are IO bound (rasterio releases the GIL), so
# more of them in flight fills the wait rather than starving the CPU.
_batch = asyncio.Semaphore(max(12, settings.max_concurrent_jobs))

# The choropleth simplifies each feature before zonal reduction. The forecast
# rasters are coarse (a PMD cell is a few hundredths of a degree, GFS coarser),
# so thinning a boundary by a hundredth of a degree cannot move it past a pixel,
# and it turns a 6.7-million-vertex layer into something that scores in seconds.
# The detail card, one feature at a time, still uses full resolution geometry.
_CHOROPLETH_TOLERANCE = 0.01


class _Job:
    async def __aenter__(self):
        try:
            await asyncio.wait_for(_jobs.acquire(), timeout=settings.job_acquire_timeout_s)
        except asyncio.TimeoutError as exc:
            raise Busy() from exc
        return self

    async def __aexit__(self, *exc):
        _jobs.release()
        return False


async def _variable_models() -> dict[str, tuple[str | None, str]]:
    """Resolve each CARI variable to the model it is read from, by priority.

    A variable whose sourceModel is null is static (elevation, slope) and resolves
    to no model. A forecast variable (sourceModel 'auto') resolves to the first
    model in the contract's sourcePriority that actually catalogues its band, so
    most fields come from PMD-WRF, wind and vertical velocity fall through to GFS,
    and precipitable water, which only GRAPES serves, lands on GRAPES. A specific
    model string, if a variable ever pins one, is honoured as given.

    The choice is made against what is catalogued, so a model dropping a field
    does not silently break scoring: the next model in the order picks it up.
    """
    catalogue = await repositories.catalogued_bands()
    static_bands = {c["band_key"] for c in catalogue if c["is_static"]}
    band_models: dict[str, set[str]] = {}
    for c in catalogue:
        if c["is_static"] or c["model"] is None:
            continue
        band_models.setdefault(c["band_key"], set()).add(c["model"])

    priority = cari_model.source_priority()
    out: dict[str, tuple[str | None, str]] = {}
    for spec in cari_model.variable_specs():
        band = spec.get("sourceBand") or spec["band"]
        source = spec.get("sourceModel")
        if source is None or band in static_bands:
            out[spec["key"]] = (None, band)
        elif source == "auto":
            available = band_models.get(band, set())
            out[spec["key"]] = (next((m for m in priority if m in available), None), band)
        else:  # a variable that pins its own model
            out[spec["key"]] = (source, band)
    return out


async def _headline_model() -> str:
    """The model whose cycle drives the response and the lead snapping.

    The first model in the source priority that has an ingested cycle, so the
    headline follows the same preference the variables do (PMD-WRF today).
    """
    for model in cari_model.source_priority():
        if await repositories.latest_cycle(model) is not None:
            return model
    return "GRAPES"


async def _resolve(forecast_hours: int) -> tuple[timeutil.ResolvedCycle, str]:
    """Resolve the headline scoring cycle and its model.

    The headline cycle drives the response, the score cache key and the lead
    snapping. Inputs sourced from other models are resolved per variable in
    _raster_paths against the same lead, so a common lead lines the sources up
    when the feeds are current. The lead is what matters here, not this model's
    own cycle time.
    """
    model = await _headline_model()
    cycle = await repositories.latest_cycle(model)
    if cycle is None:
        raise NotConfigured(
            "wx.cycles",
            f"forecast scoring, no cycle has been ingested for the {model} model",
        )

    cycles = [c["creation_time"] for c in await repositories.available_cycles(model)]
    return (
        timeutil.resolve_cycle(
            forecast_hours,
            cycle["creation_time"],
            cycles,
            list(cycle["published_leads"] or []),
        ),
        model,
    )


async def _raster_paths(
    variables: list[dict], lead_hours: int, models: dict[str, tuple[str | None, str]]
) -> dict[str, str]:
    """Map each variable to a COG path, reading it from its resolved source.

    A CARI run draws from several models at once: most PMD fields from PMD-WRF,
    wind and vertical velocity from GFS, precipitable water from GRAPES, elevation
    and slope from static terrain. The model per variable is resolved by priority
    in _variable_models; here each is fetched against that model's own latest
    cycle at the shared lead. A missing raster is an error, not a None: scoring
    against a partial input set produces a number that looks fine and is wrong.
    """
    paths: dict[str, str] = {}
    missing: list[str] = []
    cycle_cache: dict[str, dict | None] = {}

    for spec in variables:
        model, band = models[spec["key"]]

        creation_time = None
        lead = None
        if model:  # a forecast input; static terrain leaves both None
            if model not in cycle_cache:
                cycle_cache[model] = await repositories.latest_cycle(model)
            cyc = cycle_cache[model]
            if cyc is None:
                missing.append(f"{spec['key']} (no {model} cycle)")
                continue
            creation_time = cyc["creation_time"]
            lead = lead_hours

        path = await repositories.raster_path(band, model, creation_time, lead)
        if path is None:
            missing.append(f"{spec['key']} ({band}@{model or 'static'})")
        else:
            paths[spec["key"]] = path

    if missing:
        raise NotConfigured(
            "wx.raster_catalog",
            f"scoring, these inputs are not catalogued for this lead: {sorted(missing)}",
        )

    return paths


async def _nearest_lead_value(
    model: str | None, band: str, target_lead: int, geometry: dict, reducer: str, clamp,
    cache: dict | None = None,
) -> tuple[float | None, int | None]:
    """Reduce a variable from the nearest lead that actually has data.

    Some fields are present in the catalogue at a lead but empty across the
    whole domain, because the source leaves them out at that step (GRAPES
    precipitable water at the 12-hourly synoptic leads). Precipitable water
    changes slowly, so rather than grade a real primary input as zero the scorer
    walks the band's catalogued leads outward from the target and takes the first
    one whose raster covers valid pixels. Returns the value and the lead it came
    from, so the response can say the substitution happened.

    cache is a per-pass memo of which lead a band fell back to. Whether a lead is
    empty is a domain-wide property of the source, not of one polygon, so a whole
    layer pass resolves it once on the first feature that needs it and every other
    feature reads straight from that lead. Only a positive result is cached, so a
    border feature that happens to cover no data cannot poison the lookup.
    """
    cyc = await repositories.latest_cycle(model)
    if cyc is None:
        return None, None

    creation_time = cyc["creation_time"]
    key = (model, band, target_lead)

    if cache is not None and key in cache:
        lead = cache[key]
        path = await repositories.raster_path(band, model, creation_time, lead)
        if not path:
            return None, None
        value = await run_in_threadpool(zonal.zonal_stat, path, geometry, reducer, clamp)
        return (value, lead) if value is not None else (None, None)

    leads = await repositories.catalogued_leads(band, model, creation_time)
    candidates = sorted((lo for lo in leads if lo != target_lead), key=lambda lo: (abs(lo - target_lead), lo))

    for lead in candidates:
        path = await repositories.raster_path(band, model, creation_time, lead)
        if not path:
            continue
        value = await run_in_threadpool(zonal.zonal_stat, path, geometry, reducer, clamp)
        if value is not None:
            if cache is not None:
                cache[key] = lead
            return value, lead

    return None, None


async def _apply_lead_fallback(
    specs: list[dict], values: dict, target_lead: int, geometry: dict,
    reducers: dict, clamps: dict, models: dict[str, tuple[str | None, str]],
    cache: dict | None = None,
) -> dict[str, int]:
    """Fill any opted-in variable that came back empty at the target lead.

    Mutates values in place and returns which variables were sourced from which
    lead, so the caller can surface the substitution. cache is passed through to
    the nearest-lead resolver so a whole-layer pass probes the fallback lead once
    rather than once per feature.
    """
    fallback: dict[str, int] = {}
    for spec in specs:
        key = spec["key"]
        model, band = models[key]
        if values.get(key) is not None or not spec.get("leadFallback") or not model:
            continue
        value, used_lead = await _nearest_lead_value(
            model, band, target_lead, geometry, reducers[key], clamps.get(key), cache
        )
        if value is not None:
            values[key] = value
            fallback[key] = used_lead
    return fallback


async def _resolve_inputs(cycle) -> tuple[list[dict], dict[str, str], dict[str, str], dict, dict]:
    """Everything a scoring pass needs from the raster catalogue, resolved once.

    The models, paths, reducers and clamps are identical for every feature at a
    lead, so the choropleth resolves them a single time and scores hundreds of
    geometries against them rather than repeating the lookups per feature.
    """
    specs = cari_model.variable_specs()
    models = await _variable_models()
    paths = await _raster_paths(specs, cycle.lead_hours, models)
    reducers = cari_model.reducers()
    clamps = {s["key"]: tuple(s["clamp"]) for s in specs if "clamp" in s}
    return specs, paths, reducers, clamps, models


async def _score_geometry(cycle, inputs, geometry, matrix) -> tuple[Any, dict[str, int]]:
    """Reduce and score one geometry. Bounded by the request-facing job gate."""
    specs, paths, reducers, clamps, models = inputs
    async with _Job():
        values = await run_in_threadpool(zonal.zonal_many, paths, geometry, reducers, clamps)
        fallback = await _apply_lead_fallback(
            specs, values, cycle.lead_hours, geometry, reducers, clamps, models
        )
    return cari_model.score(values, matrix), fallback


def _card(cycle, identity: dict, matrix_auto: bool, result, fallback: dict) -> dict[str, Any]:
    """The full detail envelope, shared by the district and tehsil cards."""
    return {
        **identity,
        "creationTime": cycle.creation_time,
        "leadHours": cycle.lead_hours,
        "isHistorical": cycle.is_historical,
        "leadFallback": fallback,
        "matrix": result.matrix,
        "matrixAuto": matrix_auto,
        "values": result.values,
        "scores": result.scores,
        "primarySum": result.primary_sum,
        "secondarySum": result.secondary_sum,
        "cas": result.cas,
        "casMax": result.cas_max,
        "cari": result.cari,
        "classIdx": result.class_idx,
        "riskLevel": result.risk_level,
        "riskColor": result.risk_color,
        "overrideApplied": result.override_applied,
        "precipGated": result.precip_gated,
        "classes": contracts.cari()["classes"],
    }


async def cari_for_district(
    district: str,
    forecast_hours: int,
    matrix: str | None,
) -> dict[str, Any]:
    cycle, _model = await _resolve(forecast_hours)
    info = await repositories.district_geometry(district)
    chosen = matrix or cari_model.terrain_class(info["province"], district)

    cached = await repositories.cached_cari(
        cycle.creation_time, cycle.lead_hours, district, chosen
    )
    if cached:
        logger.debug("cari_cache_hit", district=district, matrix=chosen)
        return _envelope(cycle, district, chosen, cached, from_cache=True)

    inputs = await _resolve_inputs(cycle)
    result, fallback = await _score_geometry(cycle, inputs, info["geometry"], chosen)
    await repositories.store_cari(cycle.creation_time, cycle.lead_hours, district, result)

    return _card(
        cycle,
        {"district": district, "province": info["province"]},
        matrix is None,
        result,
        fallback,
    )


async def cari_for_tehsil(
    tehsil_code: str,
    forecast_hours: int,
    matrix: str | None,
) -> dict[str, Any]:
    """CARI for one tehsil.

    A tehsil is scored the same way a district is, over its own geometry, and
    picks its threshold matrix from its parent district.

    On the automatic path it reads score.cari_tehsil first: the whole-layer
    choropleth pass pre-warms that cache with every tehsil's full result, so a
    click on a coloured tehsil is one indexed read rather than a fresh rescore.
    An explicit matrix override is the admin path and always scores fresh.
    """
    cycle, _model = await _resolve(forecast_hours)

    if matrix is None:
        cached = await repositories.cached_cari_tehsil(
            cycle.creation_time, cycle.lead_hours, tehsil_code
        )
        if cached:
            logger.debug("cari_tehsil_cache_hit", tehsil=tehsil_code)
            return _tehsil_envelope(cycle, tehsil_code, cached)

    info = await repositories.tehsil_geometry(tehsil_code)
    chosen = matrix or cari_model.terrain_class(info["province"], info["district_src"])

    inputs = await _resolve_inputs(cycle)
    result, fallback = await _score_geometry(cycle, inputs, info["geometry"], chosen)
    if matrix is None:
        await repositories.store_cari_tehsil_batch(
            cycle.creation_time, cycle.lead_hours, [(tehsil_code, result)]
        )

    return _card(
        cycle,
        {
            "tehsil": info["tehsil"],
            "tehsilCode": tehsil_code,
            "district": info["district_src"],
            "province": info["province"],
        },
        matrix is None,
        result,
        fallback,
    )


# In-flight whole-layer computes, keyed by (kind, cycle, lead). A layer takes
# from seconds (districts) to minutes (tehsils) to score, far longer than a
# request should be held open, so the compute runs as a background task and the
# endpoint reports "computing" until the cache lands. One task per key, shared by
# every poll, so a dozen browsers asking at once trigger one pass, not a dozen.
_choropleth_tasks: dict[tuple, asyncio.Task] = {}


# Static terrain reduced per feature, cached for the life of the process. A
# district's max elevation and slope come from the native DEM, which is billions
# of pixels and by far the most expensive input, and they do not change with lead
# or cycle, so scoring them once per kind and reusing keeps them out of every
# subsequent pass. Keyed by (kind, path) so a re-ingested terrain file misses.
_static_terrain: dict[tuple, dict[Any, float | None]] = {}


async def _reduce_static(
    kind: str,
    feats: list[tuple[Any, dict]],
    static_paths: dict[str, str],
    reducers: dict[str, str],
    clamps: dict,
) -> dict[Any, dict[str, float | None]]:
    """Reduce the static terrain variables, from cache where possible.

    Windowed reads, because the DEM is far too large to hold in RAM, and memoised
    across leads and cycles because terrain does not move. The first pass that
    needs it pays the cost once; every lead after reads it straight from memory.
    """
    out: dict[Any, dict[str, float | None]] = {fid: {} for fid, _ in feats}
    for key, path in static_paths.items():
        cache_key = (kind, path)
        cached = _static_terrain.get(cache_key)
        if cached is None:
            cached = await run_in_threadpool(
                zonal.zonal_reduce_windowed, path, feats, reducers[key], clamps.get(key)
            )
            _static_terrain[cache_key] = cached
        for fid, _ in feats:
            out[fid][key] = cached.get(fid)
    return out


async def _reduce_layer(
    paths: dict[str, str],
    feats: list[tuple[Any, dict]],
    reducers: dict[str, str],
    clamps: dict,
    models: dict[str, tuple[str | None, str]],
    kind: str,
) -> dict[Any, dict[str, float | None]]:
    """Reduce every raster over every feature for a whole layer.

    Split by cost. The static terrain (elevation, slope) is a billion-pixel DEM
    that never changes, so it is reduced windowed and cached once in
    _reduce_static. The forecast inputs are small grids that change every lead, so
    they go through zonal_layer, which opens each once, reads it into RAM and
    rasterizes each polygon mask once per grid, all in a worker thread because the
    masking holds the GIL. Merged per feature; identical numbers to a per feature
    pass.
    """
    static_paths = {k: paths[k] for k in paths if models[k][0] is None}
    forecast_paths = {k: paths[k] for k in paths if models[k][0] is not None}

    static_vals = await _reduce_static(kind, feats, static_paths, reducers, clamps)
    forecast_vals = (
        await run_in_threadpool(zonal.zonal_layer, forecast_paths, feats, reducers, clamps)
        if forecast_paths
        else {fid: {} for fid, _ in feats}
    )

    out: dict[Any, dict[str, float | None]] = {}
    for fid, _ in feats:
        merged = dict(forecast_vals.get(fid, {}))
        merged.update(static_vals.get(fid, {}))
        out[fid] = merged
    return out


async def _compute_choropleth(kind: str, cycle, matrix: str | None) -> list[dict[str, Any]]:
    """Score every feature of a layer. The slow pass behind the cache.

    Two things make this fast enough to warm a whole timeline: the boundaries
    come back in one query, and the rasters are read open-once and concurrently
    in _reduce_layer instead of reopened per feature. The lead fallback stays per
    feature, bounded by the batch gate, because it is rare and its per feature
    memo semantics must match the single-feature card exactly.
    """
    specs, paths, reducers, clamps, models = await _resolve_inputs(cycle)

    if kind == "district":
        rows = await repositories.list_district_geometries(_CHOROPLETH_TOLERANCE)
        feats = [(r["district_name"], r["geometry"]) for r in rows]
        # (label, province, terrain district) per key; a district is its own terrain parent.
        meta = {r["district_name"]: (r["district_name"], r["province"], r["district_name"]) for r in rows}
    elif kind == "tehsil":
        rows = await repositories.list_tehsil_geometries(_CHOROPLETH_TOLERANCE)
        feats = [(r["tehsil_code"], r["geometry"]) for r in rows]
        meta = {r["tehsil_code"]: (r["tehsil"], r["province"], r["district_src"]) for r in rows}
    else:
        raise NotConfigured("score.cari_choropleth", f"unknown choropleth kind {kind!r}")

    values_by_feat = await _reduce_layer(paths, feats, reducers, clamps, models, kind)

    # One fallback-lead memo shared by every feature in the pass. Which lead a band
    # falls back to is domain-wide, so this turns 553 per-feature probes into one.
    fallback_cache: dict = {}

    async def finish(key: Any, geom: dict) -> dict[str, Any]:
        async with _batch:
            values = values_by_feat[key]
            await _apply_lead_fallback(
                specs, values, cycle.lead_hours, geom, reducers, clamps, models, fallback_cache
            )
            name, province, terrain_district = meta[key]
            chosen = matrix or cari_model.terrain_class(province, terrain_district)
            result = cari_model.score(values, chosen)

        # result is kept alongside the compact class entry so the caller can
        # pre-warm the per feature detail-card cache from the same pass.
        return {"key": key, "name": name, "cari": result.cari,
                "classIdx": result.class_idx, "result": result}

    return list(await asyncio.gather(*(finish(k, g) for k, g in feats)))


def _compact(features: list[dict]) -> list[dict[str, Any]]:
    """The choropleth payload: class and percentage per feature, no full result."""
    return [
        {"key": f["key"], "name": f["name"], "cari": f["cari"], "classIdx": f["classIdx"]}
        for f in features
    ]


async def _run_choropleth(kind: str, cycle) -> None:
    """Background body: compute the layer, cache the class array, and pre-warm
    the per feature detail-card cache so a click on any feature is an indexed
    read rather than a fresh rescore.
    """
    features = await _compute_choropleth(kind, cycle, None)
    await repositories.store_choropleth(
        kind, cycle.creation_time, cycle.lead_hours, _compact(features)
    )

    per_feature = [(f["key"], f["result"]) for f in features]
    if kind == "district":
        await repositories.store_cari_batch(cycle.creation_time, cycle.lead_hours, per_feature)
    else:
        await repositories.store_cari_tehsil_batch(cycle.creation_time, cycle.lead_hours, per_feature)


def _choropleth_ready(kind: str, cycle, features: list[dict]) -> dict[str, Any]:
    return {
        "kind": kind,
        "status": "ready",
        "creationTime": cycle.creation_time,
        "leadHours": cycle.lead_hours,
        "count": len(features),
        "features": features,
        "classes": contracts.cari()["classes"],
    }


async def cari_choropleth(
    kind: str,
    forecast_hours: int,
    matrix: str | None,
) -> dict[str, Any]:
    """CARI class per feature for a whole layer, for thematic mapping.

    Returns immediately. A cached layer comes back with status "ready" and its
    class array; an uncached one starts a background pass and comes back
    "computing", which the caller polls until it turns ready. One class and
    percentage per feature, keyed by the map join field: district_name for
    districts, tehsil_code for tehsils.

    An overridden matrix is the admin path: computed inline and never cached,
    since the cache assumes the automatic terrain selection.
    """
    cycle, _model = await _resolve(forecast_hours)

    if matrix is not None:
        features = _compact(await _compute_choropleth(kind, cycle, matrix))
        return _choropleth_ready(kind, cycle, features)

    key = (kind, cycle.creation_time, cycle.lead_hours)

    cached = await repositories.cached_choropleth(kind, cycle.creation_time, cycle.lead_hours)
    if cached:
        _choropleth_tasks.pop(key, None)
        return _choropleth_ready(kind, cycle, cached["payload"])

    task = _choropleth_tasks.get(key)
    if task is not None and task.done():
        # A finished task with no cache means it failed; surface it once, then
        # allow the next poll to start a fresh attempt.
        _choropleth_tasks.pop(key, None)
        if task.exception() is not None:
            raise task.exception()
        task = None

    if task is None:
        _choropleth_tasks[key] = asyncio.create_task(_run_choropleth(kind, cycle))

    return {
        "kind": kind,
        "status": "computing",
        "creationTime": cycle.creation_time,
        "leadHours": cycle.lead_hours,
        "classes": contracts.cari()["classes"],
    }


# Background timeline warm-ups, one task per kind. Where cari_choropleth computes
# the lead the user is looking at, this walks every published lead so the whole
# slider becomes a cache hit without the user stepping through it. It runs the
# leads sequentially and reuses _choropleth_tasks per lead, so it never competes
# with an on-demand compute for the same lead, only fills the ones nobody asked
# for yet.
_warm_tasks: dict[str, asyncio.Task] = {}


async def _warm_targets() -> tuple[Any, list[int]]:
    """The headline cycle and the distinct scoring leads a warm-up covers.

    The choropleth snaps any requested hour onto the 3 hour scoring grid and
    caches under the snapped lead, so the set worth warming is the distinct
    snapped leads, not the raw published list. A cycle publishes hourly (103
    leads) while scoring lands on the grid (35 leads); counting the hourly list
    pinned the progress readout at 35/103 forever, since the 68 off-grid hours
    can never be cached under their own number. Warming these snapped leads makes
    every slider position, on or off the grid, a cache hit.
    """
    model = await _headline_model()
    cyc = await repositories.latest_cycle(model)
    if cyc is None:
        return None, []
    published = sorted({int(lead) for lead in (cyc["published_leads"] or [])})
    leads = sorted({
        timeutil.snap_to_published(timeutil.snap_to_grid(lead), published)
        for lead in published
    })
    return cyc["creation_time"], leads


async def _warm_body(kind: str) -> None:
    """Compute every uncached lead for a kind, one at a time.

    Sequential on purpose: each lead already fans thirteen rasters out
    concurrently, so running leads in parallel would only thrash the same disk.
    A lead already being computed on demand is awaited through the shared task
    rather than recomputed, and a lead that fails is logged and skipped so one
    bad step does not stall the rest of the timeline.
    """
    creation_time, leads = await _warm_targets()
    if not creation_time:
        return

    for lead in leads:
        try:
            if await repositories.cached_choropleth(kind, creation_time, lead):
                continue
            cycle, _model = await _resolve(lead)
            key = (kind, cycle.creation_time, cycle.lead_hours)
            task = _choropleth_tasks.get(key)
            if task is None or (task.done() and task.exception() is not None):
                task = _choropleth_tasks[key] = asyncio.create_task(_run_choropleth(kind, cycle))
            await task
        except Exception as exc:  # noqa: BLE001 - one lead failing must not stop the rest
            logger.warning("warm_lead_failed", kind=kind, lead=lead, error=str(exc))


async def warm_status(kind: str) -> dict[str, Any]:
    """How much of the timeline is cached for a kind, for the progress readout."""
    creation_time, leads = await _warm_targets()
    if not creation_time:
        return {"kind": kind, "total": 0, "ready": 0, "leads": []}

    done = await repositories.cached_choropleth_leads(kind, creation_time)
    per = [{"leadHours": lead, "status": "ready" if lead in done else "pending"} for lead in leads]
    return {"kind": kind, "total": len(leads), "ready": len(done & set(leads)), "leads": per}


async def warm_timeline(kind: str) -> dict[str, Any]:
    """Report timeline progress and ensure the background warm-up is running.

    Idempotent: the frontend calls this on entering Analysis and then polls it.
    It starts the warm task only while leads remain, so once the whole slider is
    cached the poll settles to a plain status read.
    """
    status = await warm_status(kind)
    if status["ready"] < status["total"]:
        task = _warm_tasks.get(kind)
        if task is None or task.done():
            _warm_tasks[kind] = asyncio.create_task(_warm_body(kind))
    return status


def _envelope(cycle, district, matrix, cached, from_cache=False) -> dict[str, Any]:
    classes = contracts.cari()["classes"]
    cls = classes[cached["class_idx"]]
    return {
        "district": district,
        "creationTime": cycle.creation_time,
        "leadHours": cycle.lead_hours,
        "isHistorical": cycle.is_historical,
        "matrix": matrix,
        "scores": cached["scores"],
        "cas": cached["cas"],
        "casMax": contracts.cari()["casMax"],
        "cari": cached["cari"],
        "classIdx": cached["class_idx"],
        "riskLevel": cls["name"],
        "riskColor": cls["color"],
        "overrideApplied": cached["override_applied"],
        "classes": classes,
        "fromCache": from_cache,
    }


def _tehsil_envelope(cycle, tehsil_code, cached) -> dict[str, Any]:
    """The cached tehsil card, the tehsil analog of _envelope.

    The Analysis card reads tehsil and district labels from the clicked vector
    feature, not from this response, so the cached envelope carries the score and
    class rather than re-fetching identity, which keeps the hit a single read.
    """
    classes = contracts.cari()["classes"]
    cls = classes[cached["class_idx"]]
    return {
        "tehsilCode": tehsil_code,
        "creationTime": cycle.creation_time,
        "leadHours": cycle.lead_hours,
        "isHistorical": cycle.is_historical,
        "matrix": cached["matrix"],
        "scores": cached["scores"],
        "cas": cached["cas"],
        "casMax": contracts.cari()["casMax"],
        "cari": cached["cari"],
        "classIdx": cached["class_idx"],
        "riskLevel": cls["name"],
        "riskColor": cls["color"],
        "overrideApplied": cached["override_applied"],
        "classes": classes,
        "fromCache": True,
    }


async def cari_all(forecast_hours: int, matrix: str | None) -> dict[str, Any]:
    """Every district, scores only.

    Deliberately no geometry in this response. The browser already holds the
    boundaries from vector tiles, and resending them here is what made the old
    equivalent 190 MB.
    """
    cycle, _model = await _resolve(forecast_hours)
    districts = await repositories.list_districts()

    results = []
    counts = [0] * len(contracts.cari()["classes"])

    for row in districts:
        name = row["district_name"]
        chosen = matrix or cari_model.terrain_class(row["province"], name)
        cached = await repositories.cached_cari(
            cycle.creation_time, cycle.lead_hours, name, chosen
        )
        if not cached:
            continue
        counts[cached["class_idx"]] += 1
        results.append(
            {
                "districtName": name,
                "province": row["province"],
                "matrix": chosen,
                "cari": cached["cari"],
                "classIdx": cached["class_idx"],
            }
        )

    return {
        "creationTime": cycle.creation_time,
        "leadHours": cycle.lead_hours,
        "count": len(results),
        "classCounts": counts,
        "classes": contracts.cari()["classes"],
        "districts": results,
        "note": (
            "Scores only. District geometry comes from the vector tile endpoint, "
            "join on districtName."
        ),
    }


async def susceptibility(forecast_hours: int) -> dict[str, Any]:
    cycle, model = await _resolve(forecast_hours)
    conditions = susc_model.conditions()
    districts = await repositories.list_districts()

    band_paths: dict[str, str] = {}
    missing: list[str] = []
    for band in sorted(susc_model.required_bands()):
        path = await repositories.raster_path(band, model, cycle.creation_time, cycle.lead_hours)
        if path is None:
            missing.append(band)
        else:
            band_paths[band] = path

    if missing:
        raise NotConfigured(
            "wx.raster_catalog",
            f"susceptibility, these bands are not catalogued: {sorted(missing)}",
        )

    out = []
    async with _Job():
        for row in districts:
            name = row["district_name"]
            geom = (await repositories.district_geometry(name))["geometry"]

            fractions = {}
            for cond in conditions:
                fractions[cond["key"]] = await run_in_threadpool(
                    zonal.zonal_fraction,
                    band_paths[cond["band"]],
                    geom,
                    cond["op"],
                    cond["value"],
                )

            scored = susc_model.score_from_fractions(fractions)
            out.append({"districtName": name, **scored})

    return {
        "creationTime": cycle.creation_time,
        "leadHours": cycle.lead_hours,
        "count": len(out),
        "districts": out,
        "classes": contracts.susceptibility()["classes"],
    }


async def prioritized(top: int) -> dict[str, Any]:
    """Rank districts by peak susceptibility across the contract leads."""
    leads = susc_model.prioritization_leads()
    peak: dict[str, dict[str, Any]] = {}

    for lead in leads:
        result = await susceptibility(lead)
        for row in result["districts"]:
            name = row["districtName"]
            if name not in peak or row["score"] > peak[name]["score"]:
                peak[name] = {**row, "peakLead": lead}

    ranked = sorted(peak.values(), key=lambda r: (-r["score"], r["districtName"]))[:top]
    return {"leads": leads, "count": len(ranked), "districts": ranked}


async def hotspot_verify(forecast_hours: int, district: str | None) -> dict[str, Any]:
    """Per condition pixel counts.

    Returns the condition list even when no raster is available, so the UI can
    render the criteria without waiting for an ingest.
    """
    conditions = hotspot_model.conditions()
    try:
        cycle, _model = await _resolve(forecast_hours)
    except NotConfigured:
        return {
            "status": "no_data",
            "conditions": conditions,
            "message": "No forecast cycle ingested, conditions listed for reference only.",
        }

    return {
        "status": "ok",
        "creationTime": cycle.creation_time,
        "leadHours": cycle.lead_hours,
        "district": district,
        "conditions": conditions,
        "counts": {},
        "message": (
            "Pixel counts require the hotspot band set to be catalogued for this "
            "cycle and lead."
        ),
    }


async def alerts() -> dict[str, Any]:
    cycle_row = await repositories.latest_cycle()
    if cycle_row is None:
        raise NotConfigured("wx.cycles", "alerts, no forecast cycle has been ingested")

    target_date, lead = timeutil.alert_target(
        cycle_row["creation_time"], list(cycle_row["published_leads"] or [])
    )
    rows = await repositories.alerts_for(target_date)

    return {
        "generatedAt": timeutil.pkt_now(),
        "creationTime": cycle_row["creation_time"],
        "targetDate": target_date,
        "targetLeadHours": lead,
        "minClassIdx": contracts.cari()["alerts"]["minClassIdx"],
        "count": len(rows),
        "alerts": rows,
    }
