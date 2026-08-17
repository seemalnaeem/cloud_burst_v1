"""Align several rasters onto one common grid, for per pixel scoring.

The per pixel CAR Index and the hotspot mask both grade thirteen variables at
every cell, and that only means anything if every variable sits on the same grid.
The inputs do not: PMD-WRF is roughly 0.048 degrees, GRAPES 0.125, GFS 0.25 on a
foreign spheroid, and terrain is a 30 m native DEM. This module warps each source
onto a single target grid so the arrays line up cell for cell.

The target grid is the WRFPRS grid. It is the headline model, the finest of the
forecast fields, and matches the roughly 5 km scale the district scores already
work at, so most variables need no resampling at all and nothing is upsampled to a
precision the source never had.

Resampling is a correctness decision here, not a quality knob, exactly as in
gdal_tools: continuous fields take bilinear, the categorical precipitation type
takes nearest, and terrain takes max so a cell is judged on its steepest, highest
ground rather than an average that flattens every mountain. See
.claude/skills/gdal-toolbox/SKILL.md.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio import features
from rasterio.transform import from_bounds


@dataclass(frozen=True)
class Grid:
    """A target grid: bounds in EPSG:4326, and the cell count that fills them."""

    west: float
    south: float
    east: float
    north: float
    width: int
    height: int

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return (self.west, self.south, self.east, self.north)

    @property
    def transform(self):
        return from_bounds(self.west, self.south, self.east, self.north, self.width, self.height)


def grid_from_raster(path: str | Path) -> Grid:
    """Take a raster's own grid as the target, so a same-grid source is a no-op."""
    with rasterio.open(path) as src:
        b = src.bounds
        return Grid(b.left, b.bottom, b.right, b.top, src.width, src.height)


def _run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"{cmd[0]} failed with exit {result.returncode}\n"
            f"command: {' '.join(cmd)}\n"
            f"stderr: {result.stderr.strip()}"
        )


def warp_to_grid(
    src_path: str | Path,
    dst_path: str | Path,
    grid: Grid,
    *,
    resampling: str = "bilinear",
) -> Path:
    """Warp a source onto the target grid, in EPSG:4326, at exactly its cell count.

    -t_srs forces the storage CRS, which the GFS fields need because they arrive
    on a GRIB spheroid rather than WGS84. -te with -ts pins the output to the
    grid's own bounds and shape, so every warped file is pixel for pixel
    alignable with every other. gdalwarp streams the source in blocks, which is
    what lets a 3.3 gigapixel DEM downsample to a 380 by 274 grid without loading
    the whole thing.
    """
    _run([
        "gdalwarp",
        "-t_srs", "EPSG:4326",
        "-te", str(grid.west), str(grid.south), str(grid.east), str(grid.north),
        "-ts", str(grid.width), str(grid.height),
        "-r", resampling,
        "-multi", "-wo", "NUM_THREADS=ALL_CPUS",
        "-co", "COMPRESS=DEFLATE",
        "-overwrite",
        str(src_path), str(dst_path),
    ])
    return Path(dst_path)


def read_masked(path: str | Path) -> np.ndarray:
    """Read band 1 as float64 with nodata turned into NaN.

    NaN is how a missing cell reaches the scorers: the CAR Index grades it 0, and
    a hotspot comparison against NaN is False, which keeps a gap out of the mask
    rather than silently passing it. Both are the safe direction.
    """
    with rasterio.open(path) as src:
        arr = src.read(1).astype("float64")
        nd = src.nodata
    if nd is not None:
        arr = np.where(arr == nd, np.nan, arr)
    return arr


def load_aligned(
    src_path: str | Path,
    grid: Grid,
    tmp_dir: str | Path,
    *,
    resampling: str = "bilinear",
    tag: str = "aligned",
) -> np.ndarray:
    """Warp a source onto the grid and return it as a NaN-masked array."""
    tmp = Path(tmp_dir) / f"{tag}.tif"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    warp_to_grid(src_path, tmp, grid, resampling=resampling)
    try:
        return read_masked(tmp)
    finally:
        tmp.unlink(missing_ok=True)


def rasterize_flags(
    shapes: list[tuple[dict, int]],
    grid: Grid,
    *,
    fill: int = 0,
    dtype: str = "uint8",
) -> np.ndarray:
    """Burn (geometry, value) pairs onto the target grid.

    Used for the terrain-versus-lowlands matrix selection: each district burns 1
    where it scores against the terrain matrix and 0 where it scores against the
    lowlands one, so the per pixel scorer can pick the right thresholds cell by
    cell. all_touched keeps a thin border district from dropping out between grid
    lines.
    """
    if not shapes:
        return np.full((grid.height, grid.width), fill, dtype=dtype)
    return features.rasterize(
        shapes,
        out_shape=(grid.height, grid.width),
        transform=grid.transform,
        fill=fill,
        all_touched=True,
        dtype=dtype,
    )
