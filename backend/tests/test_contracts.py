"""Contract shape tests.

These run without a database or any raster. They catch the class of mistake
that produces wrong numbers rather than an exception, which is the dangerous
kind.
"""

from __future__ import annotations

import pytest

from app.shared import contracts


def test_contracts_are_valid():
    problems = contracts.validate()
    assert problems == [], "\n".join(problems)


def test_cas_max_matches_weights_and_counts():
    c = contracts.cari()
    primary = [v for v in c["variables"] if v["tier"] == "primary"]
    secondary = [v for v in c["variables"] if v["tier"] == "secondary"]

    assert len(primary) == 8
    assert len(secondary) == 5
    assert c["casMax"] == pytest.approx(8 * 6 * 1.0 + 5 * 6 * 0.75)
    assert c["casMax"] == pytest.approx(70.5)


def test_both_matrices_cover_every_variable():
    c = contracts.cari()
    keys = {v["key"] for v in c["variables"]}
    for name, matrix in c["matrices"].items():
        assert set(matrix["thresholds"]) == keys, f"matrix {name} is incomplete"


def test_six_variables_differ_between_matrices():
    """DATA_SOURCES.md says CAPE, TCWV, ELEV, DP, T2M and T850 differ. If that
    set changes, something was edited and the change should be deliberate."""
    c = contracts.cari()
    terrain = c["matrices"]["terrain"]["thresholds"]
    lowlands = c["matrices"]["lowlands"]["thresholds"]

    differing = {k for k in terrain if terrain[k] != lowlands[k]}
    assert differing == {"CAPE", "TCWV", "ELEV", "DP", "T2M", "T850"}


def test_vertical_velocity_reduces_with_min():
    """The single easiest thing to get wrong. Negative is updraft, so the
    strongest signal is the minimum."""
    reducers = {v["key"]: v["reducer"] for v in contracts.cari()["variables"]}
    assert reducers["VV700"] == "min"
    assert reducers["VV500"] == "min"
    assert reducers["ELEV"] == "max"
    assert reducers["SLOPE"] == "max"


def test_vertical_velocity_uses_descending_order():
    order = {v["key"]: v["order"] for v in contracts.cari()["variables"]}
    assert order["VV700"] == "desc"
    assert order["VV500"] == "desc"
    assert all(o == "asc" for k, o in order.items() if k not in {"VV700", "VV500"})


def test_susceptibility_is_stricter_than_hotspot():
    """The two models share variables at deliberately different thresholds.
    This asserts the direction of the difference so a future edit that
    accidentally equalises them fails here."""
    hot = {c.get("key"): c for c in contracts.hotspot()["conditions"]}
    sus = {c["key"]: c for c in contracts.susceptibility()["conditions"]}

    assert sus["cape_1500"]["value"] > hot["cape"]["value"]
    assert sus["rh700_80"]["value"] > hot["rh700"]["value"]
    assert sus["rh500_70"]["value"] > hot["rh500"]["value"]
    assert sus["pw_45"]["value"] > hot["pw"]["value"]
    assert sus["elev_1500m"]["value"] > hot["elev"]["value"]
    # More negative is stricter for vertical velocity.
    assert sus["vv700"]["value"] < hot["vv700"]["value"]
    assert sus["vv500"]["value"] < hot["vv500"]["value"]


def test_rain_composes_differently_between_the_two_models():
    """Hotspot ANDs type and rate into one condition. Susceptibility keeps them
    separate. Both lists have 13 entries and they are not the same 13."""
    hot = contracts.hotspot()["conditions"]
    sus = contracts.susceptibility()["conditions"]

    rain = next(c for c in hot if c.get("key") == "rain")
    assert "all" in rain and len(rain["all"]) == 2

    sus_keys = {c["key"] for c in sus}
    assert "rain_type" in sus_keys
    assert "rain_100mm" in sus_keys

    assert len(hot) == 13
    assert len(sus) == 13


def test_cari_and_susceptibility_palettes_stay_separate():
    """They share hex values with different meanings. #fdae61 is Moderately
    High in CARI and High in susceptibility."""
    pal = contracts.palettes()
    assert len(pal["cari"]["colors"]) == 7
    assert len(pal["susceptibility"]["colors"]) == 5
    assert pal["cari"]["colors"] is not pal["susceptibility"]["colors"]


def test_terrain_reduction_derives_slope_from_the_5km_dem():
    """The legacy chain computes slope FROM the 5 km reduced DEM, not from the
    native DEM. Slope over a 5 km run is far gentler than over 30 m, and both
    boolean models test slope at 15 degrees, so reproducing this wrong inflates
    every mountain district silently. See .claude/memory/slope-is-computed-at-5km.md.
    """
    reduction = contracts.cari()["terrainReduction"]
    steps = reduction["scalarPath"]["steps"]

    slope_step = next(s for s in steps if s["op"] == "slope")
    assert slope_step["source"] == "dem@5000", (
        "slope must be derived from the 5 km DEM, not from the native DEM"
    )

    # The slope derivation has to sit between the two reductions, never before
    # the first one.
    assert steps.index(slope_step) == 1
    assert steps[0]["toScaleMeters"] == 5000
    assert steps[2]["toScaleMeters"] == 28000
    assert all(s["reducer"] == "max" for s in steps if "reducer" in s)


def test_per_pixel_path_stays_native_and_separate():
    """The per pixel raster deliberately uses native terrain. Reducing it to
    28 km was the documented cause of a district rendering as one flat color,
    so the two paths must not be unified."""
    reduction = contracts.cari()["terrainReduction"]
    assert reduction["perPixelPath"]["resolution"] == "native"
    assert reduction["perPixelPath"]["slopeSource"] == "dem@native"


def test_lead_zero_precip_rule_exists_once():
    """At lead 0 precipitation is zero, so a rate needs the 0 to 3 hour delta.
    The legacy hotspot path instead produced a flat zero, which meant its rain
    condition could never fire. One rule, in one place."""
    rule = contracts.time_model()["precipRate"]["atLeadZero"]
    assert rule["previous"] == 0
    assert rule["currentFallbackHours"] == 3


def test_every_band_range_is_ordered():
    for band in contracts.bands()["bands"]:
        if "min" in band and "max" in band:
            assert band["min"] < band["max"], f"band {band['key']} has an inverted range"
