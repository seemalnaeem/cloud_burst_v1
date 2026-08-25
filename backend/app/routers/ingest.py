"""Manual ingest trigger and live progress.

The daily scheduler refreshes the forecast on its own, but if a run is missed or
the portal published late, the header's "Update data" control lets an operator
start one by hand and watch it. Both share one run at a time through
ingest_run_service, so the manual trigger cannot stampede a scheduled run.

A manual run re-registers the cycle and re-catalogues every band from scratch, so
the layers briefly vanish while it works. That is fine once a day, but pointless
and disruptive if the data is already today's, so a run is refused while the data
is still fresh. Freshness is measured against the daily schedule: once we have data
newer than the most recent scheduled slot, there is nothing to fetch until the next
one, and the control says so instead of offering a re-fetch.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter

from app.config import settings
from app.db import repositories
from app.services import ingest_run_service
from app.shared.timeutil import PKT

router = APIRouter()


def _most_recent_slot(now_pkt: datetime) -> datetime:
    """The latest daily ingest slot at or before now, in PKT.

    The scheduler runs once a day at ingest_schedule_hour_pkt; data fetched after
    that hour today is current, so the slot is today's hour if we are past it, else
    yesterday's.
    """
    slot = now_pkt.replace(
        hour=settings.ingest_schedule_hour_pkt, minute=0, second=0, microsecond=0
    )
    if now_pkt < slot:
        slot -= timedelta(days=1)
    return slot


async def _freshness() -> dict:
    """Whether the data is stale enough to justify a re-fetch, plus when it last
    refreshed and when the next scheduled refresh is due, for the header control."""
    last = await repositories.last_ingest_time()
    now_pkt = datetime.now(PKT)
    slot = _most_recent_slot(now_pkt)
    next_slot = slot + timedelta(days=1)
    # Stale when we have nothing, or nothing newer than the most recent slot.
    stale = last is None or last.astimezone(PKT) < slot
    return {
        "lastRefresh": last.isoformat() if last is not None else None,
        "stale": stale,
        "scheduleHourPkt": settings.ingest_schedule_hour_pkt,
        "nextScheduled": next_slot.isoformat(),
    }


@router.get("/status")
async def status() -> dict:
    """The current (or last) ingest run: whether it is running, which field it is
    on, how far through, and whether a fresh run is even warranted."""
    base = ingest_run_service.status()
    if base.get("configured") is False:
        return {**base, "stale": False, "lastRefresh": None}
    return {**base, **await _freshness()}


@router.post("/run")
async def run() -> dict:
    """Start a manual full ingest. Refused while one is already running, and also
    while the data is still fresh, since a re-fetch would only churn the layers for
    nothing. Returns the status either way so the caller can react."""
    base = ingest_run_service.status()
    fresh = await _freshness() if base.get("configured") is not False else {"stale": True}

    if base.get("running"):
        return {**base, **fresh, "started": False, "refused": "running"}
    if not fresh.get("stale"):
        return {**base, **fresh, "started": False, "refused": "fresh"}

    started = ingest_run_service.start("manual")
    return {**ingest_run_service.status(), **fresh, "started": started}
