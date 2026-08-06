"""CARI scoring tests.

Golden tests: fixed inputs, expected grades, expected class. When a threshold
changes these change with it in the same commit, and the commit message says
why.
"""

from __future__ import annotations

import pytest

from app.models import cari


def test_grade_ascending_picks_first_threshold_not_exceeded():
    thresholds = [10, 20, 40, 60, 80, 100]
    assert cari.grade(5, thresholds, "asc") == 0
    assert cari.grade(10, thresholds, "asc") == 0
    assert cari.grade(11, thresholds, "asc") == 1
    assert cari.grade(100, thresholds, "asc") == 5
    assert cari.grade(150, thresholds, "asc") == 6


def test_grade_descending_rewards_more_negative_values():
    """Vertical velocity. Negative means updraft, so a strongly negative value
    should grade high, not low."""
    thresholds = [0, -0.1, -0.3, -0.8, -1.5, -3.0]
    assert cari.grade(0.5, thresholds, "desc") == 0
    assert cari.grade(-0.05, thresholds, "desc") == 1
    assert cari.grade(-0.5, thresholds, "desc") == 3
    assert cari.grade(-5.0, thresholds, "desc") == 6


def test_missing_value_grades_zero():
    assert cari.grade(None, [1, 2, 3, 4, 5, 6], "asc") == 0
    assert cari.grade(None, [0, -1, -2, -3, -4, -5], "desc") == 0


def test_matrix_selection_by_province():
    assert cari.terrain_class("Khyber Pakhtunkhwa", "Swat") == "terrain"
    assert cari.terrain_class("KPK", "Swat") == "terrain"
    assert cari.terrain_class("Gilgit Baltistan", "Hunza") == "terrain"
    assert cari.terrain_class("Azad Kashmir", "Neelam Valley") == "terrain"
    assert cari.terrain_class("Sindh", "Karachi Central") == "lowlands"
    assert cari.terrain_class("Balochistan", "Quetta") == "lowlands"


def test_punjab_splits_by_district():
    for district in ("Rawalpindi", "Jhelum", "Attock", "Chakwal", "Murree"):
        assert cari.terrain_class("Punjab", district) == "terrain"
    assert cari.terrain_class("Punjab", "Lahore") == "lowlands"
    assert cari.terrain_class("Punjab", "Multan") == "lowlands"


def test_iiojk_always_scores_against_terrain():
    assert cari.terrain_class("Indian_Illegally_Occupied_Jammu_Kashmir", "IIOJK District 72785") == "terrain"


def test_all_zero_input_gives_a_low_score():
    values = {v["key"]: None for v in cari.variable_specs()}
    result = cari.score(values, "lowlands")
    assert result.cas == 0
    assert result.cari == 0
    assert result.class_idx == 0
    assert result.risk_level == "Very Low"


def test_cari_percent_stays_in_range_for_extreme_input():
    """Every variable at its most extreme should give 100 percent, not more."""
    values = {
        "RF": 500, "CAPE": 9000, "TCWV": 200, "RH700": 100, "VV700": -50,
        "ELEV": 8000, "WS": 300, "DP": 40, "RH500": 100, "VV500": -50,
        "T2M": 60, "T850": 50, "SLOPE": 89,
    }
    result = cari.score(values, "terrain")
    assert result.cari == pytest.approx(100.0)
    assert result.class_idx == 6
    assert result.risk_level == "Extreme"


def test_cas_max_is_seventy_point_five():
    values = {v["key"]: None for v in cari.variable_specs()}
    assert cari.score(values, "terrain").cas_max == pytest.approx(70.5)


def test_humidity_is_clamped_before_grading():
    """The model produces supersaturation above 100, which would otherwise
    grade the same as 100 but is worth clamping so the reported value is
    physical."""
    base = {v["key"]: None for v in cari.variable_specs()}
    result = cari.score({**base, "RH700": 140}, "terrain")
    assert result.scores["RH700"] == 6


def test_terrain_and_lowlands_disagree_on_the_same_input():
    """CAPE of 1200 is a grade 3 on terrain thresholds and grade 2 on lowlands.
    If this stops being true, a matrix was edited."""
    base = {v["key"]: None for v in cari.variable_specs()}
    values = {**base, "CAPE": 1200}
    assert cari.score(values, "terrain").scores["CAPE"] == 3
    assert cari.score(values, "lowlands").scores["CAPE"] == 2


def test_override_raises_the_class_and_never_lowers_it():
    """Six primary variables at grade 5 or above floors the class at Very High
    even when the raw percentage falls short."""
    base = {v["key"]: None for v in cari.variable_specs()}
    values = {
        **base,
        "RF": 90,      # grade 5
        "CAPE": 2200,  # grade 5 on terrain
        "TCWV": 52,    # grade 5
        "RH700": 96,   # grade 5
        "VV700": -2.0, # grade 5
        "ELEV": 2500,  # grade 5
    }
    result = cari.score(values, "terrain")

    assert result.override_applied is True
    assert result.class_idx >= 5

    without = cari.score({**base, "RF": 90}, "terrain")
    assert without.override_applied is False


def test_reducers_are_exposed_and_correct():
    r = cari.reducers()
    assert r["VV700"] == "min"
    assert r["VV500"] == "min"
    assert r["ELEV"] == "max"
    assert len(r) == 13


def test_unknown_matrix_is_rejected():
    values = {v["key"]: None for v in cari.variable_specs()}
    with pytest.raises(ValueError, match="Unknown matrix"):
        cari.score(values, "mountains")
