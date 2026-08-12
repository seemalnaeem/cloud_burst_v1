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
# features, which is exactly what the request-facing _Job is built to refuse.
_batch = asyncio.Semaphore(settings.max_concurrent_jobs)

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
    model: str | None, band: str, target_lead: int, geometry: dict, reducer: str, clamp
) -> tuple[float | None, int | None]:
    """Reduce a variable from the nearest lead that actually has data.

    Some fields are present in the catalogue at a lead but empty across the
    whole domain, because the source leaves them out at that step (GRAPES
    precipitable water at the 12-hourly synoptic leads). Precipitable water
    changes slowly, so rather than grade a real primary input as zero the scorer
    walks the band's catalogued leads outward from the target and takes the first
    one whose raster covers valid pixels. Returns the value and the lead it came
    from, so the response can say the substitution happened.
    """
    cyc = await repositories.latest_cycle(model)
    if cyc is None:
        return None, None

    creation_time = cyc["creation_time"]
    leads = await repositories.catalogued_leads(band, model, creation_time)
    candidates = sorted((lo for lo in leads if lo != target_lead), key=lambda lo: (abs(lo - target_lead), lo))

    for lead in candidates:
        path = await repositories.raster_path(band, model, creation_time, lead)
        if not path:
            continue
        value = await run_in_threadpool(zonal.zonal_stat, path, geometry, reducer, clamp)
        if value is not None:
            return value, lead

    return None, None


async def _apply_lead_fallback(
    specs: list[dict], values: dict, target_lead: int, geometry: dict,
    reducers: dict, clamps: dict, models: dict[str, tuple[str | None, str]]
) -> dict[str, int]:
    """Fill any opted-in variable that came back empty at the target lead.

    Mutates values in place and returns which variables were sourced from which
    lead, so the caller can surface the substitution.
    """
    fallback: dict[str, int] = {}
    for spec in specs:
        key = spec["key"]
        model, band = models[key]
        if values.get(key) is not None or not spec.get("leadFallback") or not model:
            continue
        value, used_lead = await _nearest_lead_value(
            model, band, target_lead, geometry, reducers[key], clamps.get(key)
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
    picks its threshold matrix from its parent district. It is computed fresh
    each time rather than cached: a single tehsil is fast, and the whole-layer
    pass that would benefit from a cache has its own in cari_choropleth.
    """
    cycle, _model = await _resolve(forecast_hours)
    info = await repositories.tehsil_geometry(tehsil_code)
    chosen = matrix or cari_model.terrain_class(info["province"], info["district_src"])

    inputs = await _resolve_inputs(cycle)
    result, fallback = await _score_geometry(cycle, inputs, info["geometry"], chosen)

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


async def _compute_choropleth(kind: str, cycle, matrix: str | None) -> list[dict[str, Any]]:
    """Score every feature of a layer. The slow pass behind the cache."""
    inputs = await _resolve_inputs(cycle)

    if kind == "district":
        rows = await repositories.list_districts()
    elif kind == "tehsil":
        rows = await repositories.list_tehsils()
    else:
        raise NotConfigured("score.cari_choropleth", f"unknown choropleth kind {kind!r}")

    async def score_row(row: dict) -> dict[str, Any]:
        async with _batch:
            if kind == "district":
                key = label = row["district_name"]
                terrain_district = key
                geom = (
                    await repositories.district_geometry(key, tolerance_deg=_CHOROPLETH_TOLERANCE)
                )["geometry"]
            else:
                key = row["tehsil_code"]
                label = row["tehsil"]
                terrain_district = row["district_src"]
                geom = (
                    await repositories.tehsil_geometry(key, tolerance_deg=_CHOROPLETH_TOLERANCE)
                )["geometry"]

            chosen = matrix or cari_model.terrain_class(row["province"], terrain_district)
            specs, paths, reducers, clamps, models = inputs
            values = await run_in_threadpool(zonal.zonal_many, paths, geom, reducers, clamps)
            await _apply_lead_fallback(specs, values, cycle.lead_hours, geom, reducers, clamps, models)
            result = cari_model.score(values, chosen)

        return {"key": key, "name": label, "cari": result.cari, "classIdx": result.class_idx}

    return list(await asyncio.gather(*(score_row(row) for row in rows)))


async def _run_choropleth(kind: str, cycle) -> None:
    """Background body: compute the layer and cache it under the auto matrix."""
    features = await _compute_choropleth(kind, cycle, None)
    await repositories.store_choropleth(kind, cycle.creation_time, cycle.lead_hours, features)


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
        features = await _compute_choropleth(kind, cycle, matrix)
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
