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
    model: str | None = Query(None, description="PMD data_type, required for a forecast layer"),
    creation_time: datetime | None = Query(None),
    lead: int | None = Query(None, ge=-168, le=360),
) -> dict:
    raster_layers = {entry["id"]: entry for entry in contracts.layers()["rasterLayers"]}
    if layer not in raster_layers:
        raise ValidationFailed(f"Unknown raster layer {layer!r}. See /api/meta/layers.")

    definition = raster_layers[layer]

    # The forecast layer is driven by whichever band the user selected. The
    # others carry their band key in the contract.
    #
    # The layer id is not the band key and must not be assumed to be. The
    # elevation layer is `dem` on the map and `elevation` in the band catalogue,
    # and falling back to the layer id sent this looking for a band named `dem`,
    # which does not exist: the DEM returned a validation error instead of a
    # tile, from a layer that was otherwise entirely correct.
    if definition.get("bandDriven"):
        if not band:
            raise ValidationFailed(f"Layer {layer!r} needs a band parameter.")
        band_key = band
    else:
        band_key = definition.get("band", layer)

    # A forecast layer resolves against a specific model, because the same band
    # exists under several models. The layer carries its model in the contract, so
    # the query parameter only needs to be trusted after it agrees with it.
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
        "layer": layer,
        "band": band_key,
        "model": resolved_model,
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
