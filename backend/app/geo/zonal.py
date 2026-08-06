"""Zonal statistics: collapse a raster to one number per polygon.

The reducer is always passed in, never defaulted. Vertical velocity reduces
with min because negative means updraft, elevation and slope with max so a
district is judged on its worst cell, and susceptibility uses mean over a binary
raster to get the fraction of area passing.

Getting the reducer wrong is a silent failure. The number looks plausible and
every downstream score is off. See .claude/memory/reducer-semantics.md.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import rasterio
from rasterio.mask import mask as rio_mask

REDUCERS = {
    "max": np.nanmax,
    "min": np.nanmin,
    "mean": np.nanmean,
    "sum": np.nansum,
    "median": np.nanmedian,
}


def _clip(src: rasterio.DatasetReader, geometry: dict) -> np.ndarray:
    """Clip to a polygon and return the valid values as a flat array."""
    arr, _ = rio_mask(src, [geometry], crop=True, filled=True, nodata=src.nodata)
    data = arr[0].astype("float64")

    if src.nodata is not None:
        data = np.where(data == src.nodata, np.nan, data)

    return data[~np.isnan(data)]


def zonal_stat(
    raster_path: str,
    geometry: dict,
    reducer: str,
    clamp: tuple[float, float] | None = None,
) -> float | None:
    """One value for one polygon.

    Returns None when the polygon covers no valid pixels, which happens at the
    edge of a forecast domain and is normal. Callers grade None as 0.
    """
    if reducer not in REDUCERS:
        raise ValueError(f"Unknown reducer {reducer!r}, expected one of {sorted(REDUCERS)}")

    with rasterio.open(raster_path) as src:
        values = _clip(src, geometry)

    if values.size == 0:
        return None

    if clamp is not None:
        values = np.clip(values, clamp[0], clamp[1])

    return float(REDUCERS[reducer](values))


def zonal_fraction(
    raster_path: str,
    geometry: dict,
    op: str,
    threshold: float,
) -> float | None:
    """Share of polygon area where a condition holds, between 0 and 1.

    This is what susceptibility needs. Mathematically it is the mean of the
    binary condition raster, computed here without materializing a separate
    raster per condition.
    """
    ops = {
        "gt": lambda a: a > threshold,
        "gte": lambda a: a >= threshold,
        "lt": lambda a: a < threshold,
        "lte": lambda a: a <= threshold,
        "eq": lambda a: a == threshold,
    }
    if op not in ops:
        raise ValueError(f"Unknown operator {op!r}")

    with rasterio.open(raster_path) as src:
        values = _clip(src, geometry)

    if values.size == 0:
        return None

    return float(ops[op](values).mean())


def zonal_many(
    raster_paths: dict[str, str],
    geometry: dict,
    reducers: dict[str, str],
    clamps: dict[str, tuple[float, float]] | None = None,
) -> dict[str, float | None]:
    """Reduce several rasters over the same polygon in one call.

    Keys are variable keys, not band keys, so the result drops straight into
    the CARI scorer.
    """
    clamps = clamps or {}
    out: dict[str, Any] = {}

    for key, path in raster_paths.items():
        reducer = reducers.get(key)
        if reducer is None:
            raise ValueError(f"No reducer given for {key!r}. Reducers are never defaulted.")
        out[key] = zonal_stat(path, geometry, reducer, clamps.get(key))

    return out
