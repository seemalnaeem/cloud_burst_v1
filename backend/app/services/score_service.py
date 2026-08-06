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


async def _resolve(forecast_hours: int) -> timeutil.ResolvedCycle:
    cycle = await repositories.latest_cycle()
    if cycle is None:
        raise NotConfigured(
            "wx.cycles",
            "forecast scoring, no cycle has been ingested yet",
        )

    cycles = [c["creation_time"] for c in await repositories.available_cycles()]
    return timeutil.resolve_cycle(
        forecast_hours,
        cycle["creation_time"],
        cycles,
        list(cycle["published_leads"] or []),
    )


async def _raster_paths(
    variables: list[dict],
    creation_time: datetime,
    lead_hours: int,
) -> dict[str, str]:
    """Map variable key to a COG path.

    A missing raster is an error, not a None. Scoring against a partial input
    set produces a number that looks fine and is wrong.
    """
    paths: dict[str, str] = {}
    missing: list[str] = []

    for spec in variables:
        path = await repositories.raster_path(spec["band"], creation_time, lead_hours)
        if path is None:
            missing.append(spec["band"])
        else:
            paths[spec["key"]] = path

    if missing:
        raise NotConfigured(
            "wx.raster_catalog",
            f"scoring, these bands are not catalogued for this cycle and lead: {sorted(missing)}",
        )

    return paths


async def cari_for_district(
    district: str,
    forecast_hours: int,
    matrix: str | None,
) -> dict[str, Any]:
    cycle = await _resolve(forecast_hours)
    info = await repositories.district_geometry(district)
    chosen = matrix or cari_model.terrain_class(info["province"], district)

    cached = await repositories.cached_cari(
        cycle.creation_time, cycle.lead_hours, district, chosen
    )
    if cached:
        logger.debug("cari_cache_hit", district=district, matrix=chosen)
        return _envelope(cycle, district, chosen, cached, from_cache=True)

    specs = cari_model.variable_specs()
    paths = await _raster_paths(specs, cycle.creation_time, cycle.lead_hours)

    reducers = cari_model.reducers()
    clamps = {s["key"]: tuple(s["clamp"]) for s in specs if "clamp" in s}

    async with _Job():
        values = await run_in_threadpool(
            zonal.zonal_many, paths, info["geometry"], reducers, clamps
        )

    result = cari_model.score(values, chosen)
    await repositories.store_cari(cycle.creation_time, cycle.lead_hours, district, result)

    return {
        "district": district,
        "province": info["province"],
        "creationTime": cycle.creation_time,
        "leadHours": cycle.lead_hours,
        "isHistorical": cycle.is_historical,
        "matrix": result.matrix,
        "matrixAuto": matrix is None,
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
    cycle = await _resolve(forecast_hours)
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
    cycle = await _resolve(forecast_hours)
    conditions = susc_model.conditions()
    districts = await repositories.list_districts()

    band_paths: dict[str, str] = {}
    missing: list[str] = []
    for band in sorted(susc_model.required_bands()):
        path = await repositories.raster_path(band, cycle.creation_time, cycle.lead_hours)
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
        cycle = await _resolve(forecast_hours)
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
