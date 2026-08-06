"""Thin, tested wrappers over the GDAL command line and the osgeo bindings.

Everything that shells out to gdal lives here so the flags exist in one place.
The flags are not decoration, several of them are the difference between correct
output and plausible looking wrong output. See
.claude/skills/gdal-toolbox/SKILL.md.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from osgeo import gdal, ogr, osr

# Without this GDAL returns None on failure and the error surfaces three
# functions later as an unrelated AttributeError.
gdal.UseExceptions()
ogr.UseExceptions()
osr.UseExceptions()


@dataclass
class RasterInfo:
    path: str
    driver: str
    crs: str | None
    width: int
    height: int
    bands: int
    nodata: float | None
    bounds: tuple[float, float, float, float]
    is_geographic: bool


@dataclass
class VectorInfo:
    path: str
    driver: str
    layer: str
    crs: str | None
    feature_count: int
    geometry_type: str
    fields: list[str]


def inspect_raster(path: str | Path) -> RasterInfo:
    """Read metadata without loading pixels.

    Run this before every ingest. Half of all ingest bugs are a source file that
    is not what its name says it is.
    """
    ds = gdal.Open(str(path))
    gt = ds.GetGeoTransform()
    band = ds.GetRasterBand(1)

    srs = osr.SpatialReference(wkt=ds.GetProjection()) if ds.GetProjection() else None
    crs = srs.GetAuthorityCode(None) if srs else None

    west, north = gt[0], gt[3]
    east = west + gt[1] * ds.RasterXSize
    south = north + gt[5] * ds.RasterYSize

    info = RasterInfo(
        path=str(path),
        driver=ds.GetDriver().ShortName,
        crs=f"EPSG:{crs}" if crs else None,
        width=ds.RasterXSize,
        height=ds.RasterYSize,
        bands=ds.RasterCount,
        nodata=band.GetNoDataValue(),
        bounds=(west, south, east, north),
        is_geographic=bool(srs.IsGeographic()) if srs else False,
    )
    ds = None
    return info


def inspect_vector(path: str | Path, layer: str | None = None) -> VectorInfo:
    ds = ogr.Open(str(path))
    lyr = ds.GetLayerByName(layer) if layer else ds.GetLayer(0)

    srs = lyr.GetSpatialRef()
    crs = srs.GetAuthorityCode(None) if srs else None
    defn = lyr.GetLayerDefn()

    info = VectorInfo(
        path=str(path),
        driver=ds.GetDriver().GetName(),
        layer=lyr.GetName(),
        crs=f"EPSG:{crs}" if crs else None,
        feature_count=lyr.GetFeatureCount(),
        geometry_type=ogr.GeometryTypeToName(lyr.GetGeomType()),
        fields=[defn.GetFieldDefn(i).GetName() for i in range(defn.GetFieldCount())],
    )
    ds = None
    return info


def _run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"{cmd[0]} failed with exit {result.returncode}\n"
            f"command: {' '.join(cmd)}\n"
            f"stderr: {result.stderr.strip()}"
        )


def to_cog(
    src: str | Path,
    dst: str | Path,
    *,
    tmp_dir: str | Path = "/data/tmp",
    float_data: bool = True,
    compress: str = "DEFLATE",
) -> Path:
    """Convert to a Cloud Optimized GeoTIFF.

    Writes into tmp_dir and moves into place at the end. TiTiler will serve a
    half written file quite happily and the result looks like corruption in the
    browser with no error anywhere.

    Predictor 3 is for floating point, 2 for integers. Backwards makes the file
    bigger rather than smaller.
    """
    dst = Path(dst)
    staging = Path(tmp_dir) / dst.name
    staging.parent.mkdir(parents=True, exist_ok=True)

    _run([
        "gdal_translate", "-of", "COG",
        "-co", f"COMPRESS={compress}",
        "-co", f"PREDICTOR={'3' if float_data else '2'}",
        "-co", "BLOCKSIZE=512",
        "-co", "OVERVIEWS=AUTO",
        "-co", "NUM_THREADS=ALL_CPUS",
        str(src), str(staging),
    ])

    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(staging), str(dst))
    return dst


def reproject(
    src: str | Path,
    dst: str | Path,
    *,
    target_crs: str = "EPSG:4326",
    resampling: str = "bilinear",
) -> Path:
    """Warp to a target CRS.

    Resampling is a correctness decision, not a quality knob. Continuous fields
    take bilinear or cubic. Categorical fields, precipitation type being the one
    here, take nearest. Averaging category codes 1 and 5 gives 3, which means
    something else entirely.
    """
    _run([
        "gdalwarp",
        "-t_srs", target_crs,
        "-r", resampling,
        "-multi", "-wo", "NUM_THREADS=ALL_CPUS",
        "-co", "COMPRESS=DEFLATE",
        "-overwrite",
        str(src), str(dst),
    ])
    return Path(dst)


def slope_from_dem(dem: str | Path, dst: str | Path, *, geographic: bool = True) -> Path:
    """Slope in degrees.

    The -s 111120 scale factor converts degrees of latitude and longitude into
    meters. A geographic DEM without it produces slope values off by orders of
    magnitude.
    """
    cmd = ["gdaldem", "slope", "-compute_edges"]
    if geographic:
        cmd += ["-s", "111120"]
    cmd += [str(dem), str(dst)]
    _run(cmd)
    return Path(dst)


def validate_cog(path: str | Path) -> bool:
    result = subprocess.run(
        ["rio", "cogeo", "validate", str(path)], capture_output=True, text=True
    )
    return result.returncode == 0 and "is a valid cloud optimized GeoTIFF" in result.stdout


def ogr2ogr_to_postgis(
    src: str | Path,
    dsn: str,
    table: str,
    *,
    source_layer: str | None = None,
    where: str | None = None,
) -> None:
    """Load a vector file into a PostGIS staging table.

    Flags that are not optional:
      PROMOTE_TO_MULTI  sources mix Polygon and MultiPolygon, PostGIS rejects
                        the mixed batch
      LAUNDER=NO        preserves source column casing, and several of those
                        columns are join keys
      t_srs 4326        one storage CRS, no exceptions
      SPATIAL_INDEX     build the GiST index during load rather than after
    """
    if not table.endswith("_staging"):
        raise ValueError(
            f"Refusing to load into {table!r}. Load into a _staging table and "
            "promote inside a transaction, so a failed ingest cannot leave the "
            "portal with no boundaries."
        )

    cmd = [
        "ogr2ogr", "-f", "PostgreSQL", f"PG:{dsn}", str(src),
        "-nln", table,
        "-nlt", "PROMOTE_TO_MULTI",
        "-t_srs", "EPSG:4326",
        "-lco", "GEOMETRY_NAME=geom",
        "-lco", "FID=id",
        "-lco", "SPATIAL_INDEX=GIST",
        "-lco", "LAUNDER=NO",
        "-lco", "PRECISION=NO",
        "-overwrite", "-progress",
    ]
    if where:
        cmd += ["-where", where]
    if source_layer:
        cmd += [source_layer]

    _run(cmd)
