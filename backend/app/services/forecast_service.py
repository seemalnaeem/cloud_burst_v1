"""Forecast time series for a region.

Reduces one temporal forecast raster to a single value per published lead over a
selected boundary, so the frontend can chart how a variable evolves through the
run for a district, tehsil or IIOJK district. It reuses the same zonal machinery
the scoring path does, and resolves paths through wx.raster_catalog so a caller
never passes a filesystem path.
"""

from __future__ import annotations

import asyncio

from app.db import repositories
from app.geo import zonal
from app.shared import contracts
from app.shared.errors import NotConfigured, ValidationFailed

# Bound the fan-out over leads so a run with ninety of them does not open ninety
# rasters or acquire ninety pool connections at once.
_SEM = asyncio.Semaphore(4)


def _raster_layer(layer_id: str) -> dict | None:
    for layer in contracts.layers().get("rasterLayers", []):
        if layer.get("id") == layer_id:
            return layer
    return None


async def forecast_timeseries(layer_id: str, kind: str, key: str, reducer: str = "mean") -> dict:
    """One value per lead for a temporal layer over a region boundary.

    reducer is how the raster collapses to a number over the polygon: mean for a
    representative value, max for a peak. The band's own clamp is applied so a
    humidity series cannot leave 0..100.
    """
    if reducer not in zonal.REDUCERS:
        raise ValidationFailed(f"Unknown reducer {reducer!r}, expected one of {sorted(zonal.REDUCERS)}")

    layer = _raster_layer(layer_id)
    if layer is None or not layer.get("temporal"):
        raise ValidationFailed(f"{layer_id!r} is not a temporal forecast layer")

    band_key = layer["band"]
    model = layer.get("model")
    band = contracts.band(band_key)
    clamp = tuple(band["clamp"]) if band.get("clamp") else None

    region = await repositories.region_geometry(kind, key)
    if region is None:
        raise ValidationFailed(f"No {kind} for key {key!r}")

    cycle = await repositories.latest_cycle(model)
    if cycle is None:
        raise NotConfigured("wx.cycles", f"a forecast cycle for model {model}")
    creation_time = cycle["creation_time"]
    leads = sorted(cycle["published_leads"] or [])

    async def one(lead: int) -> dict:
        async with _SEM:
            path = await repositories.raster_path(band_key, model, creation_time, lead)
            if not path:
                return {"lead": lead, "value": None}
            value = await asyncio.to_thread(zonal.zonal_stat, path, region["geometry"], reducer, clamp)
            return {"lead": lead, "value": value}

    points = await asyncio.gather(*[one(lead) for lead in leads])

    return {
        "layer": layer_id,
        "label": layer.get("label"),
        "band": band_key,
        "unit": band.get("unit"),
        "category": band.get("category"),
        "model": model,
        "modelLabel": layer.get("modelLabel"),
        "level": layer.get("level"),
        "levelLabel": layer.get("levelLabel"),
        "palette": band.get("palette"),
        "reducer": reducer,
        "region": {"kind": kind, "key": key, "name": region["name"]},
        "creationTime": creation_time.isoformat(),
        "points": list(points),
    }
