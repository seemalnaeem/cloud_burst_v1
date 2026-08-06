"""District lookup.

Geometry for rendering comes from vector tiles, not from here. These endpoints
serve attributes and extents, which are small.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.db import repositories

router = APIRouter()


@router.get("")
async def list_districts(province: str | None = Query(None)) -> dict:
    rows = await repositories.list_districts(province)
    return {"count": len(rows), "districts": rows}


@router.get("/suggest")
async def suggest(q: str = Query(..., min_length=2), limit: int = Query(5, ge=1, le=20)) -> dict:
    """Fuzzy name matching.

    Backed by a trigram index. Used for the search box and for resolving
    district names out of scraped advisory text, where spellings vary.
    """
    return {"query": q, "matches": await repositories.suggest(q, limit)}


@router.get("/{district_name}")
async def get_district(district_name: str) -> dict:
    """One district.

    Raises 404 with suggestions when the name is not an exact match. The
    suggestion matters because this name is a join key and the usual cause of a
    miss is a spelling difference rather than a missing district.
    """
    district = await repositories.get_district(district_name)
    district["extent"] = await repositories.district_extent(district_name)
    return district
