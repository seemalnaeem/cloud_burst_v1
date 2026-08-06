"""Raster path resolution.

The gateway asks "which COG backs this layer, band, cycle and lead" and gets a
path. The browser never sends a path, which is what keeps the raster tile route
from becoming an arbitrary file reader.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Query

from app.config import settings
from app.db import repositories
from app.shared import contracts
from app.shared.errors import NotConfigured, ValidationFailed

router = APIRouter()


@router.get("/resolve")
async def resolve(
    layer: str = Query(..., description="Raster layer id from layers.json"),
    band: str | None = Query(None, description="Band key, required for the forecast layer"),
    creation_time: datetime | None = Query(None),
    lead: int | None = Query(None, ge=-168, le=360),
) -> dict:
    raster_layers = {entry["id"]: entry for entry in contracts.layers()["rasterLayers"]}
    if layer not in raster_layers:
        raise ValidationFailed(f"Unknown raster layer {layer!r}. See /api/meta/layers.")

    definition = raster_layers[layer]

    # The forecast layer is driven by whichever band the user selected. The
    # others map to a fixed band key.
    if definition.get("bandDriven"):
        if not band:
            raise ValidationFailed(f"Layer {layer!r} needs a band parameter.")
        band_key = band
    else:
        band_key = layer

    try:
        spec = contracts.band(band_key)
    except KeyError as exc:
        raise ValidationFailed(f"Unknown band {band_key!r}. See /api/meta/bands.") from exc

    if creation_time is None and not spec.get("static"):
        cycle = await repositories.latest_cycle()
        if cycle is None:
            raise NotConfigured("wx.cycles", f"the {layer} layer, no forecast cycle is ingested")
        creation_time = cycle["creation_time"]

    path = await repositories.raster_path(band_key, creation_time, lead)
    if path is None:
        raise NotConfigured(
            "wx.raster_catalog",
            f"the {layer} layer, band {band_key} is not catalogued for that cycle and lead",
        )

    return {
        "layer": layer,
        "band": band_key,
        "path": path,
        "creationTime": creation_time,
        "leadHours": lead,
        # The gateway uses these for the tile rescale, so they come from the
        # same contract the legend reads. That is what keeps the two in step.
        "min": spec.get("min"),
        "max": spec.get("max"),
        "unit": spec.get("unit"),
        "palette": spec.get("palette"),
        "categorical": bool(spec.get("categorical")),
    }


@router.get("/catalog")
async def catalog() -> dict:
    """What is actually on disk right now.

    Useful when a layer renders empty and you need to know whether the ingest
    ran at all.
    """
    return {
        "cogDir": str(settings.cog_dir),
        "exists": settings.cog_dir.exists(),
        "files": sorted(p.name for p in settings.cog_dir.glob("*.tif")) if settings.cog_dir.exists() else [],
    }
