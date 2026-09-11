"""Forecast time model tests.

The lead grid and cycle resolution are subtle enough that two endpoints
implementing them separately would disagree. These lock the behavior.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.shared import timeutil


def test_lead_grid_switches_step_at_144_hours():
    grid = timeutil.lead_grid()
    assert 0 in grid
    assert 3 in grid
    assert 144 in grid
    assert 150 in grid
    assert 147 not in grid, "past 144 hours the step becomes 6"
    assert grid[-1] == 360


def test_step_depends_on_lead():
    assert timeutil.step_for_lead(0) == 3
    assert timeutil.step_for_lead(120) == 3
    assert timeutil.step_for_lead(200) == 6


def test_snap_to_published_prefers_the_nearest_actual_lead():
    """A cycle publishes incrementally and can skip a grid point. Asking for a
    lead that does not exist otherwise returns nothing with no obvious cause."""
    published = [0, 3, 6, 12, 15]
    assert timeutil.snap_to_published(9, published) == 6
    assert timeutil.snap_to_published(10, published) == 12
    assert timeutil.snap_to_published(0, published) == 0
    assert timeutil.snap_to_published(99, published) == 15


def test_previous_published_lead():
    published = [0, 3, 6, 12]
    assert timeutil.previous_published(12, published) == 6
    assert timeutil.previous_published(3, published) == 0
    assert timeutil.previous_published(0, published) == 0


def test_interval_is_never_zero():
    """It is a divisor in the precipitation rate derivation."""
    assert timeutil.interval_hours(3, 3) >= 1
    assert timeutil.interval_hours(12, 6) == 6


def test_positive_lead_uses_the_latest_cycle():
    latest = datetime(2026, 8, 6, tzinfo=timezone.utc)
    resolved = timeutil.resolve_cycle(24, latest, [latest], [0, 3, 6, 12, 24])
    assert resolved.creation_time == latest
    assert resolved.lead_hours == 24
    assert resolved.is_historical is False


def test_negative_lead_reaches_into_a_past_cycle():
    """History means an older cycle, not a negative forecast hour. A forecast
    model has no negative hours."""
    latest = datetime(2026, 8, 6, 12, tzinfo=timezone.utc)
    cycles = [latest - timedelta(hours=h) for h in (0, 6, 12, 18, 24)]

    resolved = timeutil.resolve_cycle(-12, latest, cycles, [0, 3, 6])

    assert resolved.is_historical is True
    assert resolved.creation_time <= latest - timedelta(hours=12)
    assert resolved.lead_hours == 0


def test_history_clamps_at_the_contract_limit():
    latest = datetime(2026, 8, 6, tzinfo=timezone.utc)
    cycles = [latest - timedelta(hours=h) for h in range(0, 200, 6)]
    resolved = timeutil.resolve_cycle(-500, latest, cycles, [0])
    assert resolved.creation_time >= latest - timedelta(hours=168)


def test_no_cycle_available_raises():
    latest = datetime(2026, 8, 6, tzinfo=timezone.utc)
    with pytest.raises(ValueError, match="No cycle available"):
        timeutil.resolve_cycle(-24, latest, [latest], [0])


def test_forecast_days_lists_covered_pkt_days(monkeypatch):
    """A 05:00 PKT cycle with hourly leads to 78h, asked on 11 Sep, offers today
    and the next two days (11, 12, 13 Sept). The days start at today because the
    forecast still has hours of the current day to run."""
    monkeypatch.setattr(timeutil, "pkt_now", lambda: datetime(2026, 9, 11, 12, tzinfo=timeutil.PKT))
    creation = datetime(2026, 9, 10, 0, tzinfo=timezone.utc)  # 05:00 PKT
    published = list(range(0, 79))

    days = timeutil.forecast_days(creation, published, max_days=3)

    assert [d["date"] for d in days] == ["2026-09-11", "2026-09-12", "2026-09-13"]
    assert [d["index"] for d in days] == [0, 1, 2]
    assert days[0]["start_lead"] == 19 and days[0]["end_lead"] == 43
    assert days[1]["start_lead"] == 43
    assert days[2]["start_lead"] == 67
    for d in days:
        assert d["leads"], "a listed day must carry the leads inside it"
        assert all(d["start_lead"] < lead <= d["end_lead"] for lead in d["leads"])


def test_forecast_days_empty_without_published_leads(monkeypatch):
    monkeypatch.setattr(timeutil, "pkt_now", lambda: datetime(2026, 9, 11, 12, tzinfo=timeutil.PKT))
    creation = datetime(2026, 9, 10, 0, tzinfo=timezone.utc)
    assert timeutil.forecast_days(creation, [], max_days=3) == []
