"""Forecast cycle and lead time arithmetic.

This lives in exactly one module because it is subtler than it looks and two
endpoints implementing it separately is how they end up disagreeing about which
forecast hour they are showing.

The rules, all from shared/contracts/time.json:

  - Leads run on a 3 hour grid from 0 to 144 hours, then a 6 hour grid to 360.
  - A cycle publishes incrementally and may skip a grid point, so never assume
    the grid is complete. Always snap to a lead that was actually published.
  - Negative leads reach backwards into past cycles, not into a past forecast
    hour of the current cycle.
  - Precipitation rate differences against the previous PUBLISHED lead, not the
    previous grid lead. The old system had two implementations of this and one
    could hit a null on a skipped lead.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from app.shared import contracts

_TIME = contracts.time_model()
_TZ_OFFSET = timedelta(hours=_TIME["timezone"]["offsetHours"])
PKT = timezone(_TZ_OFFSET, _TIME["timezone"]["label"])


def lead_grid() -> list[int]:
    """The full theoretical lead grid. A fallback, not a source of truth."""
    out: list[int] = []
    for seg in _TIME["leadGrid"]:
        step = seg["stepHours"]
        start = seg["fromHour"] if not out else out[-1] + step
        out.extend(range(start, seg["toHour"] + 1, step))
    return sorted(set(out))


def step_for_lead(hours: int) -> int:
    """Grid step in effect at a given lead."""
    for seg in _TIME["leadGrid"]:
        if seg["fromHour"] <= hours < seg["toHour"]:
            return seg["stepHours"]
    return _TIME["leadGrid"][-1]["stepHours"]


def snap_to_grid(hours: int) -> int:
    """Round a requested lead onto the theoretical grid."""
    step = step_for_lead(abs(hours))
    return int(round(hours / step) * step)


def snap_to_published(hours: int, published: list[int]) -> int:
    """Snap to the nearest lead the cycle actually published.

    This is the one that matters. The grid says 3 hourly, the cycle might have
    skipped 021, and asking for a lead that does not exist returns nothing with
    no obvious cause.
    """
    if not published:
        raise ValueError("No published leads to snap against")
    ordered = sorted(published)
    idx = bisect_left(ordered, hours)
    if idx == 0:
        return ordered[0]
    if idx >= len(ordered):
        return ordered[-1]
    before, after = ordered[idx - 1], ordered[idx]
    return before if (hours - before) <= (after - hours) else after


def previous_published(hours: int, published: list[int]) -> int:
    """The published lead immediately before this one.

    Used by the precipitation rate derivation. At lead zero there is no
    previous, so the contract says treat previous as 0 and use the first
    available positive lead as current.
    """
    ordered = sorted(l for l in published if l < hours)
    if ordered:
        return ordered[-1]
    return 0


def interval_hours(current: int, previous: int) -> int:
    """Hours between two leads, floored at the contract minimum.

    Never zero, because it is a divisor.
    """
    minimum = _TIME["precipRate"]["minIntervalHours"]
    return max(minimum, current - previous)


@dataclass(frozen=True)
class ResolvedCycle:
    creation_time: datetime
    lead_hours: int
    is_historical: bool


def resolve_cycle(
    requested_hours: int,
    latest_creation_time: datetime,
    available_cycles: list[datetime],
    published_leads: list[int],
) -> ResolvedCycle:
    """Turn a requested lead into a concrete cycle plus lead.

    A positive lead is a forecast from the latest cycle. A negative lead is
    history, and history means an older cycle rather than a negative forecast
    hour, because a forecast model has no negative hours.
    """
    if requested_hours >= 0:
        return ResolvedCycle(
            creation_time=latest_creation_time,
            lead_hours=snap_to_published(snap_to_grid(requested_hours), published_leads),
            is_historical=False,
        )

    history = _TIME["history"]
    clamped = max(requested_hours, history["minLeadHours"])
    step = history["stepHours"]
    snapped = int(round(clamped / step) * step)
    target = latest_creation_time + timedelta(hours=snapped)

    candidates = [c for c in available_cycles if c <= target]
    if not candidates:
        raise ValueError(f"No cycle available at or before {target.isoformat()}")

    return ResolvedCycle(
        creation_time=max(candidates),
        lead_hours=0,
        is_historical=True,
    )


def pkt_now() -> datetime:
    return datetime.now(tz=PKT)


def alert_target(latest_creation_time: datetime, published_leads: list[int]) -> tuple[date, int]:
    """Target date and lead for the alert feed.

    Tomorrow midday local time, expressed as a lead from the latest cycle and
    snapped to something the cycle published.
    """
    cari = contracts.cari()["alerts"]
    tomorrow = (pkt_now() + timedelta(days=1)).date()
    target = datetime.combine(
        tomorrow, datetime.min.time(), tzinfo=PKT
    ) + timedelta(hours=cari["targetLocalHour"])

    delta_h = (target - latest_creation_time.astimezone(PKT)).total_seconds() / 3600.0
    lead = snap_to_published(snap_to_grid(int(round(delta_h))), published_leads)
    return tomorrow, lead
