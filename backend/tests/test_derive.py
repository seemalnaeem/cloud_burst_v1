"""Derived band tests.

These cover the conversions that produce a plausible looking wrong map rather
than an exception, which is the dangerous kind of failure.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.geo import derive
from app.models import cari


def test_precip_rate_differences_cumulative_values():
    current = np.array([[0.012]])   # meters since init
    previous = np.array([[0.003]])
    rate = derive.precip_rate(current, previous, interval_hours=3)
    # (0.012 - 0.003) * 1000 / 3 = 3 mm/hr
    assert rate[0, 0] == pytest.approx(3.0)


def test_precip_rate_masks_non_positive_deltas():
    """Numerical noise between leads produces tiny negatives. Rendering them
    speckles the whole domain."""
    current = np.array([[0.005, 0.005]])
    previous = np.array([[0.005, 0.006]])
    rate = derive.precip_rate(current, previous, interval_hours=3)
    assert np.isnan(rate).all()


def test_precip_rate_rejects_zero_interval():
    with pytest.raises(ValueError, match="divisor"):
        derive.precip_rate(np.array([[1.0]]), np.array([[0.0]]), interval_hours=0)


def test_wind_speed_converts_to_kmh():
    u = np.array([[3.0]])
    v = np.array([[4.0]])
    # magnitude 5 m/s, times 3.6
    assert derive.wind_speed(u, v)[0, 0] == pytest.approx(18.0)


def test_humidity_clamps_supersaturation():
    rh = np.array([[-5.0, 50.0, 140.0]])
    clamped = derive.clamp_humidity(rh)
    assert clamped.tolist() == [[0.0, 50.0, 100.0]]


def test_kelvin_conversion_matters_for_grading():
    """The failure this guards against: GFS ships Kelvin, the T850 thresholds
    start at 0 degC, so an unconverted value grades 6 everywhere and the map
    looks fine while being wrong."""
    kelvin = np.array([[288.15]])   # 15 degC
    celsius = derive.to_celsius(kelvin)
    assert celsius[0, 0] == pytest.approx(15.0)

    base = {v["key"]: None for v in cari.variable_specs()}

    correct = cari.score({**base, "T850": float(celsius[0, 0])}, "terrain")
    unconverted = cari.score({**base, "T850": float(kelvin[0, 0])}, "terrain")

    assert correct.scores["T850"] == 3
    assert unconverted.scores["T850"] == 6, "an unconverted Kelvin value saturates the grade"


class TestPrecipTypeFromFlags:
    """GFS gives four booleans where the palettes and scoring conditions expect
    one ECMWF style code."""

    def test_no_flags_is_no_precipitation(self):
        z = np.zeros((1, 1))
        assert derive.precip_type_from_flags(z, z, z, z)[0, 0] == 0

    def test_rain_maps_to_code_one(self):
        z = np.zeros((1, 1))
        one = np.ones((1, 1))
        result = derive.precip_type_from_flags(one, z, z, z)
        assert result[0, 0] == derive.PRECIP_TYPE_RAIN == 1

    def test_each_flag_maps_to_its_code(self):
        z = np.zeros((1, 1))
        one = np.ones((1, 1))
        assert derive.precip_type_from_flags(z, one, z, z)[0, 0] == 5   # snow
        assert derive.precip_type_from_flags(z, z, one, z)[0, 0] == 8   # ice pellets
        assert derive.precip_type_from_flags(z, z, z, one)[0, 0] == 3   # freezing rain

    def test_frozen_types_win_over_rain_in_transition_zones(self):
        """Both flags set is a sleet situation. Calling it plain rain would feed
        the rain condition in the hotspot mask and in susceptibility, and only
        code 1 does that."""
        one = np.ones((1, 1))
        z = np.zeros((1, 1))
        assert derive.precip_type_from_flags(one, one, z, z)[0, 0] == 5
        assert derive.precip_type_from_flags(one, z, one, z)[0, 0] == 8
        assert derive.precip_type_from_flags(one, z, z, one)[0, 0] == 3

    def test_output_codes_exist_in_the_palette(self):
        from app.shared import contracts

        palette = contracts.palettes()["precipType"]
        known = {entry["code"] for entry in palette["entries"]}

        produced = {
            derive.PRECIP_TYPE_NONE,
            derive.PRECIP_TYPE_RAIN,
            derive.PRECIP_TYPE_FREEZING_RAIN,
            derive.PRECIP_TYPE_SNOW,
            derive.PRECIP_TYPE_ICE_PELLETS,
        }
        assert produced <= known, "a produced code has no color in palettes.json"
