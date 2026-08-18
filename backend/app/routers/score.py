"""Scoring endpoints for the three models.

Routers stay thin: validate, delegate, return. The work is in
app/services/score_service.py and the numbers are in shared/contracts.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query

from app.models import cari as cari_model
from app.models import hotspot as hotspot_model
from app.models import susceptibility as susc_model
from app.services import score_service

router = APIRouter()

Matrix = Literal["terrain", "lowlands"]


@router.get("/cari")
async def cari(
    district: str = Query(..., description="Exact district_name, the join key"),
    forecast_hours: int = Query(0, ge=-168, le=360),
    matrix: Matrix | None = Query(
        None,
        description=(
            "Override the automatic terrain or lowlands selection. The response "
            "always reports which matrix was actually used."
        ),
    ),
) -> dict:
    """CARI for one district.

    The response carries the matrix used, because when a score looks surprising
    that is the first thing anyone needs to know.
    """
    return await score_service.cari_for_district(district, forecast_hours, matrix)


@router.get("/cari/tehsil")
async def cari_tehsil(
    tehsil_code: str = Query(..., description="Exact tehsil_code, the unique key"),
    forecast_hours: int = Query(0, ge=-168, le=360),
    matrix: Matrix | None = Query(None),
) -> dict:
    """CARI for one tehsil, scored over its own geometry.

    The tehsil takes its threshold matrix from its parent district. Same detail
    envelope as the district card, so the Analysis card renders either from one
    shape.
    """
    return await score_service.cari_for_tehsil(tehsil_code, forecast_hours, matrix)


@router.get("/cari/all")
async def cari_all(
    forecast_hours: int = Query(0, ge=-168, le=360),
    matrix: Matrix | None = Query(None),
) -> dict:
    """CARI for every district.

    Scores only, keyed by district_name. Geometry comes from vector tiles. The
    old design embedded polygons here and produced a 190 MB response.
    """
    return await score_service.cari_all(forecast_hours, matrix)


@router.get("/cari/choropleth")
async def cari_choropleth(
    kind: Literal["district", "tehsil"] = Query(
        "district", description="Which layer to score for thematic mapping"
    ),
    forecast_hours: int = Query(0, ge=-168, le=360),
    matrix: Matrix | None = Query(None),
) -> dict:
    """CARI class per feature for a whole layer, for the Analysis choropleth.

    One class and percentage per feature, keyed by the map join field. The first
    call scores every feature and caches the array; later calls for the same
    cycle and lead are a single read. The tehsil layer is a large first pass.
    """
    return await score_service.cari_choropleth(kind, forecast_hours, matrix)


@router.get("/cari/warm")
async def cari_warm(
    kind: Literal["district", "tehsil"] = Query(
        "district", description="Which layer's timeline to warm"
    ),
) -> dict:
    """Warm the whole timeline for a layer, so every slider position is instant.

    Idempotent progress endpoint: it reports how many published leads are already
    cached and, while any remain, ensures a background pass is filling the rest
    one lead at a time. The frontend calls it on entering Analysis and polls it.
    """
    return await score_service.warm_timeline(kind)


@router.get("/susceptibility")
async def susceptibility(forecast_hours: int = Query(0, ge=-168, le=360)) -> dict:
    """Susceptibility score per district, 0 to 13.

    Stricter than the hotspot mask on every shared variable, by design.
    """
    return await score_service.susceptibility(forecast_hours)


@router.get("/susceptibility/prioritized")
async def prioritized(top: int = Query(20, ge=1, le=200)) -> dict:
    """Districts ranked by peak susceptibility across the contract leads."""
    return await score_service.prioritized(top)


@router.get("/hotspots/verify")
async def hotspots_verify(
    forecast_hours: int = Query(0, ge=-168, le=360),
    district: str | None = Query(None),
) -> dict:
    """Pixel count per hotspot condition, plus the final AND.

    When the mask comes back empty this says which single condition emptied it,
    which is nearly always more useful than the mask itself.
    """
    return await score_service.hotspot_verify(forecast_hours, district)


@router.get("/definitions")
async def definitions() -> dict:
    """What each model measures, straight from the contracts.

    Exposed so the UI can render condition lists and threshold tables without
    retyping a single number.
    """
    return {
        "cari": {
            "variables": cari_model.variable_specs(),
            "reducers": cari_model.reducers(),
        },
        "hotspot": {
            "conditions": hotspot_model.conditions(),
            "combine": "AND",
        },
        "susceptibility": {
            "conditions": susc_model.conditions(),
            "areaFractionThreshold": 0.5,
            "leads": susc_model.prioritization_leads(),
        },
    }
