"""Catalog endpoints.

The client calls these first. Everything else in the UI derives from the band
catalog, the layer list, the palettes and the available forecast leads, so
serving them from the contracts means the client can never disagree with the
backend about a display range or a class boundary.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.db import repositories
from app.shared import contracts, timeutil
from app.shared.errors import NotConfigured, ValidationFailed

router = APIRouter()


@router.get("/bands")
async def bands() -> dict:
    """Band catalog with display ranges and palette names.

    min and max here drive both the tile rescale and the legend ticks, which is
    what stops a legend and its map from disagreeing.
    """
    return contracts.bands()


@router.get("/layers")
async def layers() -> dict:
    """Vector and raster layer definitions. The map is built from this."""
    return contracts.layers()


@router.get("/layer-extent")
async def layer_extent(layer: str = Query(..., description="Layer id from layers.json")) -> dict:
    """The geographic extent of a layer, for the zoom-to-layer control.

    Every layer id is checked against the contract first, so this cannot be
    turned into a probe for arbitrary tables. Computed from the actual geometry,
    so IIOJK frames the north and a future events layer frames its points rather
    than everything defaulting to the whole country.
    """
    cfg = contracts.layers()
    known = {entry["id"] for entry in cfg.get("layers", [])} | {
        entry["id"] for entry in cfg.get("rasterLayers", [])
    }
    if layer not in known:
        raise ValidationFailed(f"Unknown layer {layer!r}. See /api/meta/layers.")

    extent = await repositories.layer_extent(layer)
    if extent is None:
        raise NotConfigured(layer, f"the {layer} layer has no features to frame yet")
    return {"layer": layer, "extent": extent}


@router.get("/basemaps")
async def basemaps() -> dict:
    """Basemap catalogue and available projections.

    Carries no credential. The Mapbox token is supplied to the browser through
    the runtime config, so this stays cacheable and safe to serve to anyone.
    """
    return contracts.basemaps()


@router.get("/palettes")
async def palettes() -> dict:
    """Data visualization palettes.

    Not the same thing as UI theme colors. These describe data and stay
    identical in light and dark.
    """
    return contracts.palettes()


@router.get("/models")
async def models() -> dict:
    """The three scoring models, so the UI can render thresholds and legends
    without hardcoding any of them.

    They share variables and use different thresholds on purpose. Do not
    present them as one system.
    """
    return {
        "cari": contracts.cari(),
        "hotspot": contracts.hotspot(),
        "susceptibility": contracts.susceptibility(),
    }


@router.get("/forecast")
async def forecast_meta(
    model: str | None = Query(None, description="PMD data_type; omit for the newest model overall"),
) -> dict:
    """Cycle discovery, per model. Call this first, the whole timeline derives
    from it, and call it again when the active model changes.

    Every model that has a cycle is listed in `availableModels`, so the panel can
    offer a selector. The chosen model (the one requested, or the newest overall)
    drives `creationTime` and `publishedLeads`, which are the leads that cycle
    actually published rather than the theoretical grid.
    """
    time_model = contracts.time_model()
    models = await repositories.forecast_models()
    available = [
        {
            "model": m["model"],
            "creationTime": m["creation_time"],
            "leadCount": len(m["published_leads"] or []),
        }
        for m in models
    ]

    if not models:
        return {
            "status": "no_data",
            "message": (
                "No forecast cycle has been ingested yet. See "
                ".claude/playbooks/ingest-raster-source.md."
            ),
            "model": None,
            "availableModels": [],
            "leadGrid": timeutil.lead_grid(),
            "minLeadHours": time_model["history"]["minLeadHours"],
            "historyStepHours": time_model["history"]["stepHours"],
        }

    chosen = next((m for m in models if m["model"] == model), None) if model else None
    if chosen is None:
        chosen = max(models, key=lambda m: m["creation_time"])

    cycles = await repositories.available_cycles(chosen["model"])

    return {
        "status": "ok",
        "model": chosen["model"],
        "availableModels": available,
        "creationTime": chosen["creation_time"],
        "publishedLeads": list(chosen["published_leads"] or []),
        "leadGrid": timeutil.lead_grid(),
        "minLeadHours": time_model["history"]["minLeadHours"],
        "historyStepHours": time_model["history"]["stepHours"],
        "availableCycles": [c["creation_time"] for c in cycles],
    }
