"""Derived bands, computed at ingest rather than per request.

Three derivations, all defined in DATA_SOURCES.md and encoded in
shared/contracts/bands.json:

  - hourly precipitation rate from a cumulative field
  - wind speed at 850 hPa from its u and v components
  - relative humidity clamped to a physical range

The old system recomputed these on every request. Doing it once at ingest is
both faster and, more importantly, means there is one implementation to be
wrong rather than several.
"""

from __future__ import annotations

import numpy as np


def precip_rate(
    current: np.ndarray,
    previous: np.ndarray,
    interval_hours: int,
) -> np.ndarray:
    """Cumulative precipitation in meters to a rate in mm per hour.

    The source band accumulates since model initialization, so a value at lead
    24 includes everything that fell before it. Using it directly as a rate
    gives a running total where an hourly figure belongs, and the rainfall grade
    saturates at its top bucket for every district.

    Non-positive differences are masked to NaN. They come from numerical noise
    between leads and rendering them produces speckle across the whole domain.
    """
    if interval_hours < 1:
        raise ValueError("interval_hours must be at least 1, it is a divisor")

    delta = (current - previous) * 1000.0 / float(interval_hours)
    return np.where(delta > 0, delta, np.nan)


def wind_speed(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Wind speed in km/hr from u and v components in m/s."""
    return np.sqrt(u * u + v * v) * 3.6


def clamp_humidity(rh: np.ndarray) -> np.ndarray:
    """Clamp relative humidity to 0 through 100.

    The model produces supersaturation above 100, which is physically
    meaningful in a cloud microphysics sense but distorts the grading, since
    every threshold list tops out at 98.
    """
    return np.clip(rh, 0.0, 100.0)


def to_celsius(kelvin: np.ndarray) -> np.ndarray:
    """Kelvin to Celsius.

    GFS ships temperature and dewpoint in Kelvin. The CARI thresholds are in
    Celsius and T850 starts at 0, so an unconverted value grades 6 on every
    district, every time, and the map looks plausible while being wrong.

    Check the source units before applying this. Converting twice is just as
    wrong and even harder to spot.
    """
    return kelvin - 273.15


# ECMWF style precipitation type codes, which is what palettes.json and the
# scoring conditions expect. GFS instead publishes four independent boolean
# flags, so they get mapped back into this code space at ingest and nothing
# downstream has to change. See OPEN_DATA_SOURCES.md section 1.1.
PRECIP_TYPE_NONE = 0
PRECIP_TYPE_RAIN = 1
PRECIP_TYPE_FREEZING_RAIN = 3
PRECIP_TYPE_SNOW = 5
PRECIP_TYPE_ICE_PELLETS = 8


def precip_type_from_flags(
    crain: np.ndarray,
    csnow: np.ndarray,
    cicep: np.ndarray,
    cfrzr: np.ndarray,
) -> np.ndarray:
    """Collapse the four GFS categorical flags into one precipitation type code.

    Order matters where more than one flag is set, which happens along
    transition zones. Frozen types win over rain, because a pixel reporting both
    rain and ice pellets is a sleet situation and calling it plain rain would
    feed the rain condition in the scoring models when it should not.

    Only code 1 feeds the rain conditions in the hotspot mask and in
    susceptibility, so this ordering has a direct effect on both scores.
    """
    out = np.full(crain.shape, PRECIP_TYPE_NONE, dtype="uint8")

    # Assigned least specific first, so a more specific type overwrites it.
    out[crain > 0] = PRECIP_TYPE_RAIN
    out[cfrzr > 0] = PRECIP_TYPE_FREEZING_RAIN
    out[cicep > 0] = PRECIP_TYPE_ICE_PELLETS
    out[csnow > 0] = PRECIP_TYPE_SNOW

    return out


def slope_scale_factor(is_geographic: bool) -> float | None:
    """Scale factor for gdaldem slope.

    A DEM in a geographic CRS has degrees on the horizontal axes and meters on
    the vertical, so gdaldem needs -s 111120 to reconcile them. Leaving it out
    gives slope values wrong by orders of magnitude, and every terrain dependent
    score with them.
    """
    return 111120.0 if is_geographic else None
