"""Catalog endpoints.

The client calls these first. Everything else in the UI derives from the band
catalog, the layer list, the palettes and the available forecast leads, so
serving them from the contracts means the client can never disagree with the
backend about a display range or a class boundary.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.db import repositories
from app.shared import contracts, timeutil

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
async def forecast_meta() -> dict:
    """Cycle discovery. Call this first, the whole timeline derives from it.

    Returns the leads the latest cycle actually published rather than the
    theoretical grid, because a cycle publishes incrementally and may skip a
    grid point.
    """
    cycle = await repositories.latest_cycle()
    time_model = contracts.time_model()

    if cycle is None:
        return {
            "status": "no_data",
            "message": (
                "No forecast cycle has been ingested yet. See "
                ".claude/playbooks/ingest-raster-source.md."
            ),
            "model": time_model["model"],
            "leadGrid": timeutil.lead_grid(),
            "minLeadHours": time_model["history"]["minLeadHours"],
            "historyStepHours": time_model["history"]["stepHours"],
        }

    cycles = await repositories.available_cycles()

    return {
        "status": "ok",
        "model": cycle["model"],
        "creationTime": cycle["creation_time"],
        "publishedLeads": list(cycle["published_leads"] or []),
        "leadGrid": timeutil.lead_grid(),
        "minLeadHours": time_model["history"]["minLeadHours"],
        "historyStepHours": time_model["history"]["stepHours"],
        "availableCycles": [c["creation_time"] for c in cycles],
    }
