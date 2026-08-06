"""Alert feed.

Every district whose CARI class reaches the contract minimum, for tomorrow
midday local time. Driven by full CARI rather than the hotspot mask.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.services import score_service

router = APIRouter()


@router.get("/alerts")
async def alerts() -> dict:
    """Tomorrow's High and above districts.

    Sorted by class descending then name. The target lead is tomorrow midday
    PKT, rounded to the lead grid and snapped to a lead the cycle actually
    published.
    """
    return await score_service.alerts()
