"""Raster path resolution.

The gateway asks "which COG backs this layer, band, cycle and lead" and gets a
path. The browser never sends a path, which is what keeps the raster tile route
from becoming an arbitrary file reader.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Literal

import rasterio
from fastapi import APIRouter, Query
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.db import repositories
from app.services import forecast_service, raster_score_service
from app.shared import contracts
from app.shared.errors import NotConfigured, ValidationFailed

router = APIRouter()


@router.get("/compute")
async def compute(
    layer: str = Query(..., description="A computed raster layer id: cari_raster or hotspots"),
    forecast_hours: int = Query(0, ge=-168, le=360, description="Lead hours; snapped to the WRFPRS grid"),
) -> dict:
    """Prepare a computed raster for a lead, generating it on demand.

    The per pixel CAR Index and the hotspot mask are graded on every forecast cell,
    which is far too slow to do inside a tile request, so they are generated once
    per cycle and lead and catalogued. This returns "ready" when the COG exists and
    "computing" while a background pass builds it, the same poll-until-ready shape
    the choropleth uses. The returned creationTime and leadHours are what the tiles
    should resolve against, since the lead is snapped to what WRFPRS publishes.
    """
    return await raster_score_service.compute(layer, forecast_hours)


@router.get("/timeseries")
async def timeseries(
    layer: str = Query(..., description="A temporal forecast raster layer id, e.g. wrfprs_tpe"),
    kind: Literal["district", "tehsil", "iiojk"] = Query("district"),
    key: str = Query(..., description="district_name, tehsil_code, or IIOJK district_code"),
    reducer: str = Query("mean", description="How the raster collapses over the polygon: mean, max, min, sum, median"),
) -> dict:
    """The value of one temporal layer per published lead over a region boundary.

    This is what the forecast chart plots: pick a boundary and a forecast layer,
    get the trend across the run. The reduction happens server side over the same
    geometry the map draws, so the chart and the map agree.
    """
    return await forecast_service.forecast_timeseries(layer, kind, key, reducer)


async def _resolve_raster(
    layer: str,
    band: str | None,
    model: str | None,
    creation_time: datetime | None,
    lead: int | None,
) -> dict:
    """Map a layer (and optionally a band, model, cycle and lead) to a COG path.

    The one place that turns request parameters into a filesystem path, shared by
    the tile resolve and the point query so they can never disagree about which
    file backs a layer. The browser passes a layer id, never a path, which is what
    keeps these endpoints from becoming an arbitrary file reader.
    """
    raster_layers = {entry["id"]: entry for entry in contracts.layers()["rasterLayers"]}
    if layer not in raster_layers:
        raise ValidationFailed(f"Unknown raster layer {layer!r}. See /api/meta/layers.")

    definition = raster_layers[layer]

    # The forecast layer is driven by whichever band the user selected. The
    # others carry their band key in the contract. The layer id is not the band
    # key and must not be assumed to be: the DEM is `dem` on the map and
    # `elevation` in the band catalogue.
    if definition.get("bandDriven"):
        if not band:
            raise ValidationFailed(f"Layer {layer!r} needs a band parameter.")
        band_key = band
    else:
        band_key = definition.get("band", layer)

    # A forecast layer resolves against a specific model, because the same band
    # exists under several models. The layer carries its model in the contract.
    resolved_model = model or definition.get("model")

    try:
        spec = contracts.band(band_key)
    except KeyError as exc:
        raise ValidationFailed(f"Unknown band {band_key!r}. See /api/meta/bands.") from exc

    if creation_time is None and not spec.get("static"):
        cycle = await repositories.latest_cycle(resolved_model)
        if cycle is None:
            raise NotConfigured(
                "wx.cycles",
                f"the {layer} layer, no forecast cycle is ingested"
                + (f" for model {resolved_model}" if resolved_model else ""),
            )
        creation_time = cycle["creation_time"]

    path = await repositories.raster_path(band_key, resolved_model, creation_time, lead)
    if path is None:
        raise NotConfigured(
            "wx.raster_catalog",
            f"the {layer} layer, band {band_key} is not catalogued for that cycle and lead",
        )

    return {
        "definition": definition,
        "band_key": band_key,
        "spec": spec,
        "model": resolved_model,
        "creation_time": creation_time,
        "path": path,
    }


@router.get("/resolve")
async def resolve(
    layer: str = Query(..., description="Raster layer id from layers.json"),
    band: str | None = Query(None, description="Band key, required for the forecast layer"),
    model: str | None = Query(None, description="PMD data_type, required for a forecast layer"),
    creation_time: datetime | None = Query(None),
    lead: int | None = Query(None, ge=-168, le=360),
) -> dict:
    r = await _resolve_raster(layer, band, model, creation_time, lead)
    spec = r["spec"]
    return {
        "layer": layer,
        "band": r["band_key"],
        "model": r["model"],
        "path": r["path"],
        "creationTime": r["creation_time"],
        "leadHours": lead,
        # The gateway uses these for the tile rescale, so they come from the
        # same contract the legend reads. That is what keeps the two in step.
        "min": spec.get("min"),
        "max": spec.get("max"),
        "unit": spec.get("unit"),
        "palette": spec.get("palette"),
        "categorical": bool(spec.get("categorical")),
    }


def _sample_point(path: str, lon: float, lat: float) -> float | None:
    """The single pixel value under a coordinate, or None off the data."""
    with rasterio.open(path) as ds:
        for row in ds.sample([(lon, lat)]):
            val = float(row[0])
            nd = ds.nodata
            if not math.isfinite(val) or (nd is not None and val == nd):
                return None
            return val
    return None


@router.get("/point")
async def raster_point(
    layer: str = Query(..., description="Raster layer id from layers.json"),
    lon: float = Query(..., ge=-180, le=180),
    lat: float = Query(..., ge=-90, le=90),
    band: str | None = Query(None),
    model: str | None = Query(None),
    creation_time: datetime | None = Query(None),
    lead: int | None = Query(None, ge=-168, le=360),
) -> dict:
    """The value of one raster layer at a coordinate, for the identify tool.

    Resolves the same COG the tiles come from and reads the single pixel under the
    point, so the number in the popup is exactly the pixel drawn on the map.
    """
    r = await _resolve_raster(layer, band, model, creation_time, lead)
    spec = r["spec"]
    value = await run_in_threadpool(_sample_point, r["path"], lon, lat)
    return {
        "layer": layer,
        "label": r["definition"].get("label"),
        "levelLabel": r["definition"].get("levelLabel"),
        "modelLabel": r["definition"].get("modelLabel"),
        "band": r["band_key"],
        "bandLabel": spec.get("label"),
        "legendTitle": spec.get("legendTitle"),
        "unit": spec.get("unit"),
        "model": r["model"],
        "creationTime": r["creation_time"],
        "leadHours": lead,
        "lon": lon,
        "lat": lat,
        "value": value,
    }


def _sample_windfield(u_path: str, v_path: str, step: int, max_points: int) -> list[dict]:
    """Read the u and v COGs and reduce them to a coarse grid of wind vectors.

    Runs off the event loop. The rasters are already clipped to Pakistan and
    coarse (0.25 degrees), so this reads the whole array and walks every `step`
    cells rather than doing per point windowed reads.
    """
    with rasterio.open(u_path) as du, rasterio.open(v_path) as dv:
        u = du.read(1)
        v = dv.read(1)
        transform = du.transform
        u_nd = du.nodata
        v_nd = dv.nodata

    rows, cols = u.shape
    # Widen the step if the grid would exceed the point budget, so the payload
    # stays bounded whatever the raster resolution.
    approx = (rows / step) * (cols / step)
    if approx > max_points:
        step = int(step * math.sqrt(approx / max_points)) + 1

    feats: list[dict] = []
    for r in range(step // 2, rows, step):
        for c in range(step // 2, cols, step):
            uu = float(u[r, c])
            vv = float(v[r, c])
            if not math.isfinite(uu) or not math.isfinite(vv):
                continue
            if (u_nd is not None and uu == u_nd) or (v_nd is not None and vv == v_nd):
                continue
            speed_ms = math.hypot(uu, vv)
            if speed_ms < 0.1:
                continue
            lon, lat = transform * (c + 0.5, r + 0.5)
            speed_kmh = speed_ms * 3.6
            # Meteorological direction: the compass bearing the wind blows FROM.
            direction = (270.0 - math.degrees(math.atan2(vv, uu))) % 360.0
            kt = speed_ms * 1.943844
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4)]},
                "properties": {
                    "speed": round(speed_kmh, 1),
                    "dir": round(direction),
                    "kt5": max(0, min(100, int(round(kt / 5.0) * 5))),
                },
            })
    return feats


@router.get("/windfield")
async def windfield(
    model: str = Query(..., description="PMD/GFS data_type carrying the wind vectors"),
    creation_time: datetime | None = Query(None),
    lead: int | None = Query(None, ge=-168, le=360),
    step: int = Query(3, ge=1, le=12, description="Grid stride in cells"),
) -> dict:
    """A coarse wind-vector grid for the barb overlay.

    Reads the internal u and v components (wind_u_pl850, wind_v_pl850), not the
    wind-speed raster, because barbs need direction. Returns GeoJSON points with
    speed, the compass bearing the wind blows from, and a 5-knot bucket the client
    picks a barb glyph by.
    """
    if creation_time is None:
        cycle = await repositories.latest_cycle(model)
        if cycle is None:
            raise NotConfigured("wx.cycles", f"the wind field, no cycle for model {model}")
        creation_time = cycle["creation_time"]

    u_path = await repositories.raster_path("wind_u_pl850", model, creation_time, lead)
    v_path = await repositories.raster_path("wind_v_pl850", model, creation_time, lead)
    if not u_path or not v_path:
        raise NotConfigured(
            "wx.raster_catalog",
            f"the wind field, u/v at 850 hPa are not catalogued for model {model} at that cycle and lead",
        )

    feats = await run_in_threadpool(_sample_windfield, u_path, v_path, step, 1500)
    return {
        "type": "FeatureCollection",
        "model": model,
        "creationTime": creation_time,
        "leadHours": lead,
        "features": feats,
    }


@router.get("/catalog")
async def catalog() -> dict:
    """What is actually available right now.

    Two answers, and the difference between them matters. `files` is what sits
    in the COG directory. `bands` is what the database will actually resolve, and
    only the second one can serve a tile: a file nobody catalogued is invisible
    to every route here.

    The portal reads this to decide which raster layers to offer. A layer whose
    band is missing is shown but disabled, so an uningested source reads as
    pending rather than as a broken toggle.
    """
    return {
        "cogDir": str(settings.cog_dir),
        "exists": settings.cog_dir.exists(),
        "files": sorted(p.name for p in settings.cog_dir.glob("*.tif")) if settings.cog_dir.exists() else [],
        "bands": await repositories.catalogued_bands(),
    }
