"""Zonal statistics: collapse a raster to one number per polygon.

The reducer is always passed in, never defaulted. Vertical velocity reduces
with min because negative means updraft, elevation and slope with max so a
district is judged on its worst cell, and susceptibility uses mean over a binary
raster to get the fraction of area passing.

Getting the reducer wrong is a silent failure. The number looks plausible and
every downstream score is off. See .claude/memory/reducer-semantics.md.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
import rasterio
from rasterio.errors import WindowError
from rasterio.features import geometry_mask, geometry_window
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


def zonal_reduce_windowed(
    raster_path: str,
    features: list[tuple[Any, dict]],
    reducer: str,
    clamp: tuple[float, float] | None = None,
) -> dict[Any, float | None]:
    """Reduce one raster over many polygons with windowed reads, concurrently.

    For rasters too large to hold in RAM: the native DEM behind elevation and
    slope is 47807 x 66368, billions of pixels, several gigabytes a band. Reading
    that whole band to clip small district windows would swamp memory, so each
    polygon's window is read through rio_mask, byte for byte zonal_stat.

    The reads dominate and release the GIL, so features are split across a handful
    of workers that run in parallel. A rasterio dataset is not safe for concurrent
    reads, so each worker opens its own handle: a few opens of the big COG, not
    one per feature. Meant for the static terrain, scored once and then cached.
    """
    if reducer not in REDUCERS:
        raise ValueError(f"Unknown reducer {reducer!r}, expected one of {sorted(REDUCERS)}")

    # Capped: too many concurrent handles on a several-gigabyte COG spikes memory,
    # and the bind mount serves one I/O channel, so past a point workers only
    # contend. Sixteen is where the old per-feature pass topped out.
    fn = REDUCERS[reducer]
    workers = max(1, min(16, len(features), (os.cpu_count() or 4)))
    chunks: list[list] = [features[i::workers] for i in range(workers)]

    def _chunk(chunk: list) -> dict[Any, float | None]:
        res: dict[Any, float | None] = {}
        with rasterio.open(raster_path) as src:
            for fid, geom in chunk:
                values = _clip(src, geom)
                if values.size == 0:
                    res[fid] = None
                    continue
                if clamp is not None:
                    values = np.clip(values, clamp[0], clamp[1])
                res[fid] = float(fn(values))
        return res

    out: dict[Any, float | None] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for res in pool.map(_chunk, chunks):
            out.update(res)
    return out


def _feature_window_mask(src: rasterio.DatasetReader, geometry: dict):
    """The crop window and outside-mask for a polygon on a raster's grid.

    Exactly what raster_geometry_mask(crop=True) computes: the same
    geometry_window and geometry_mask, so slicing the band by the window and
    dropping the masked pixels selects the identical set _clip does. Returned as
    (row_off, col_off, height, width, outside_bool), or None if the polygon does
    not overlap the grid. Depends only on the grid (transform and dimensions), so
    it is shared across every raster on that grid.
    """
    try:
        window = geometry_window(src, [geometry])
    except WindowError:
        return None
    r0, c0 = int(window.row_off), int(window.col_off)
    h, w = int(window.height), int(window.width)
    if h <= 0 or w <= 0:
        return None
    transform = src.window_transform(window)
    outside = geometry_mask(
        [geometry], transform=transform, invert=False, out_shape=(h, w), all_touched=False
    )
    return (r0, c0, h, w, outside)


def _reduce_with_mask(arr, nodata, win, reducer, clamp) -> float | None:
    """Reduce one polygon out of an in-RAM band using a precomputed window/mask."""
    r0, c0, h, w, outside = win
    sub = arr[r0:r0 + h, c0:c0 + w].astype("float64")
    data = sub[~outside]
    if nodata is not None:
        data = np.where(data == nodata, np.nan, data)
    data = data[~np.isnan(data)]
    if data.size == 0:
        return None
    if clamp is not None:
        data = np.clip(data, clamp[0], clamp[1])
    return float(reducer(data))


def zonal_layer(
    raster_paths: dict[str, str],
    features: list[tuple[Any, dict]],
    reducers: dict[str, str],
    clamps: dict[str, tuple[float, float]] | None = None,
) -> dict[Any, dict[str, float | None]]:
    """Reduce every raster over every polygon for a whole layer, the fast path.

    Two savings over a per feature zonal_many pass, which is what makes warming a
    whole timeline practical:

    - Open once. Each raster is opened a single time and its band read into RAM,
      so a district pass is thirteen opens, not 188 x 13; on a bind mount the
      opens, not the arithmetic, are what cost a minute.
    - Mask once per grid. The CARI inputs sit on only a few grids (PMD-WRF, GFS,
      GRAPES, static terrain). The rasterized mask for a polygon depends only on
      the grid, so it is computed once per grid and reused across every raster on
      it, instead of rasterizing the same polygon thirteen times.

    features is a list of (id, geometry). Returns {id: {var: value|None}}, byte
    for byte what zonal_many returns per feature, because the window, mask and
    nodata handling reproduce rasterio.mask.mask(crop=True) followed by _clip.
    """
    clamps = clamps or {}
    for key in raster_paths:
        if reducers.get(key) is None:
            raise ValueError(f"No reducer given for {key!r}. Reducers are never defaulted.")

    keys = list(raster_paths)
    workers = min(len(keys), (os.cpu_count() or 4)) or 1

    srcs: dict[str, rasterio.DatasetReader] = {}
    arrays: dict[str, np.ndarray] = {}
    nodatas: dict[str, float | None] = {}
    signature: dict[str, tuple] = {}
    rep_src: dict[tuple, rasterio.DatasetReader] = {}

    def _open(key: str):
        src = rasterio.open(raster_paths[key])
        return key, src, src.read(1)

    try:
        # Open and read concurrently: the opens are the bind-mount cost and the
        # reads release the GIL, so this is where threading pays.
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for key, src, arr in pool.map(_open, keys):
                srcs[key] = src
                arrays[key] = arr
                nodatas[key] = src.nodata
                sig = (tuple(src.transform)[:6], src.width, src.height)
                signature[key] = sig
                rep_src.setdefault(sig, src)

        # One window/mask per grid per feature, shared by every raster on the grid.
        # Rasterizing holds the GIL, so this stays single threaded, but the CARI
        # inputs share only a few grids, so it runs a handful of times per feature.
        masks: dict[tuple, dict[Any, Any]] = {}
        for sig, src in rep_src.items():
            masks[sig] = {fid: _feature_window_mask(src, geom) for fid, geom in features}

        # Reduce each raster concurrently: the slice, boolean index and nan-aware
        # reduction are numpy over the polygon window and release the GIL, so the
        # thirteen rasters genuinely run in parallel here.
        def _reduce(key: str):
            arr, nodata = arrays[key], nodatas[key]
            reducer, clamp = REDUCERS[reducers[key]], clamps.get(key)
            grid_masks = masks[signature[key]]
            col = {}
            for fid, _ in features:
                win = grid_masks[fid]
                col[fid] = None if win is None else _reduce_with_mask(arr, nodata, win, reducer, clamp)
            return key, col

        out: dict[Any, dict[str, float | None]] = {fid: {} for fid, _ in features}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for key, col in pool.map(_reduce, keys):
                for fid, val in col.items():
                    out[fid][key] = val
        return out
    finally:
        for src in srcs.values():
            src.close()
