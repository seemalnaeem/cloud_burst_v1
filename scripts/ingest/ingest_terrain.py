#!/usr/bin/env python3
"""Turn the delivered DEM into the terrain COGs the portal serves and scores on.

    docker compose exec cbd-api python3 /app/ingest/ingest_terrain.py
    docker compose exec cbd-api python3 /app/ingest/ingest_terrain.py --inspect-only
    docker compose exec cbd-api python3 /app/ingest/ingest_terrain.py --only elevation

Four products, two for display and two for scoring:

    elevation       native grid, Int16      the elevation layer, per pixel CARI
    slope           native grid, Float32    the slope layer
    elevation_5km   5 km grid, max reduced  scoring input
    slope_5km       5 km grid               scoring input

The two scoring grids are not a coarser copy of the display pair, they are a
different number. Slope is derived from the already reduced 5 km DEM, never from
the native one, because slope measured over a 5 km run is far gentler than the
same terrain measured over 30 m. A valley wall reading 40 degrees natively can
read under 10 at 5 km, and both boolean models test slope at 15 degrees. Deriving
it natively would fire the slope condition across every mountain district:
plausible, silent and wrong. See .claude/memory/slope-is-computed-at-5km.md.

The reduction is a max, not a mean, so a district's worst case cell drives its
terrain conditions. See .claude/memory/reducer-semantics.md.

Idempotent. Every product is written to /data/tmp, validated as a COG, and only
then moved into /data/cog, because TiTiler serves a half written file quite
happily and the result looks like corruption in the browser with no error
anywhere.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, "/app")

from _pg import pg_env, psql  # noqa: E402

from app.config import settings  # noqa: E402
from app.geo.gdal_tools import (  # noqa: E402
    _run as run_gdal,
    inspect_raster,
    resample_to,
    slope_from_dem,
    to_cog,
    validate_cog,
)
from app.shared import contracts  # noqa: E402

DEFAULT_SOURCE = "/data/raster/pakistan_dem.tif"
CUTLINE = "/data/tmp/national_boundary.geojson"

# 5 km expressed in degrees at this latitude. Recompute if the AOI moves. The
# same number appears in the memory note and in the playbook; it is here because
# this script is the thing that applies it.
FIVE_KM_DEG = 0.0449

# Anything under this and the file is not a Pakistan DEM, whatever it is called.
MIN_WIDTH = 10_000


def log(message: str) -> None:
    print(message, flush=True)


def export_cutline(env: dict, path: str) -> str:
    """Dump the national boundary to a GeoJSON cutline.

    Union of every geo.national feature, so Pakistan and the disputed territory
    are one polygon and the clip follows the same line the map draws. Written as
    a FeatureCollection because that is what ogr, and therefore gdalwarp
    -cutline, expects to open.
    """
    # gdalwarp blends the cutline through GEOS, which rejects any degenerate ring
    # with "Invalid number of points in LinearRing", and the raw union carries
    # sliver parts whose rings collapse to two points. OGR's own IsValid does not
    # flag them, so the fix is not a single ST_MakeValid: dump the union into its
    # parts, make each valid on its own, and keep only real polygons with a floor
    # on area. Rebuilding from the survivors leaves a clean multipolygon and drops
    # nothing a person would call land. A hair of simplification (about 50 m)
    # removes the remaining micro rings without moving the visible edge.
    sql = (
        "WITH snapped AS ("
        # SnapToGrid at ~22 m (0.0002 deg, near the DEM's own 30 m pixel) fuses
        # the near coincident vertices along the coastline that GEOS reports as
        # self-intersections when it blends the cutline. 22 m is below what the
        # clip can resolve on a 30 m raster anyway.
        "  SELECT ST_MakeValid(ST_SnapToGrid(ST_Union(geom), 0.0002)) AS g FROM geo.national"
        "), parts AS ("
        "  SELECT (ST_Dump(ST_CollectionExtract(g, 3))).geom AS p FROM snapped"
        # Exterior ring only, rebuilt into a shell. A clip mask has no use for
        # interior holes, and snapping can collapse a small hole below three
        # points, which GEOS then rejects as "too few points in component". Take
        # the outer land boundary of each substantial part and drop the rest.
        "), shells AS ("
        "  SELECT ST_MakePolygon(ST_ExteriorRing(p)) AS s FROM parts"
        "  WHERE ST_NPoints(ST_ExteriorRing(p)) >= 4 AND ST_Area(p::geography) > 1e6"
        ") "
        # 0.001 deg (~110 m) is the smallest simplification that produces a
        # cutline GEOS will blend without a self-intersection error, found by
        # sweeping tolerances against gdalwarp. The exact geometry and anything
        # finer fail on the Indus delta coastline. 110 m is well inside a 30 m
        # DEM's meaningful edge and the drawn vector boundary is untouched: this
        # simplification exists only in the throwaway cutline.
        "SELECT json_build_object("
        "'type','FeatureCollection','features',json_build_array("
        "json_build_object('type','Feature','properties',json_build_object(),"
        "'geometry',ST_AsGeoJSON("
        "  ST_MakeValid(ST_SimplifyPreserveTopology(ST_Collect(s), 0.001))"
        ")::json)))::text "
        "FROM shells"
    )
    geojson = psql(sql, env).strip()
    Path(path).write_text(geojson, encoding="utf-8")
    return path


def clip_to_boundary(src: str | Path, dst: str | Path, cutline: str, nodata: float) -> Path:
    """Warp a raster to the boundary polygon, cropping the extent to it.

    -crop_to_cutline snaps the output extent to the cutline, so the blocky
    rectangular halo the source carried, a coarse pre-clip that overshot the real
    border by tens of kilometres, is replaced by an edge that follows the vector
    boundary exactly. Everything outside becomes nodata.

    Run on the source once, before deriving anything, so all four products
    inherit the same clean edge rather than being clipped four times.
    """
    run_gdal([
        "gdalwarp",
        "-cutline", cutline,
        "-crop_to_cutline",
        "-dstnodata", str(nodata),
        "-multi", "-wo", "NUM_THREADS=ALL_CPUS",
        "-co", "COMPRESS=DEFLATE",
        "-co", "BIGTIFF=YES",
        "-overwrite",
        str(src), str(dst),
    ])
    return Path(dst)


def build_elevation(source: Path, target: Path) -> None:
    """Native grid, straight to COG.

    OVERVIEWS=IGNORE_EXISTING rather than AUTO. The delivered file already
    carries ten pyramid levels, but they were built by an unknown tool with an
    unknown resampling method and laid out in an order that fails COG validation,
    which is most of why it is not a valid COG today. Rebuilding them with
    AVERAGE costs one pass and gives a zoomed out DEM that reads as terrain
    rather than as noise.
    """
    to_cog(
        source,
        target,
        tmp_dir=settings.tmp_dir,
        float_data=False,          # Int16 elevation, so predictor 2
        overviews="IGNORE_EXISTING",
        resampling="AVERAGE",
    )


def build_slope(source: Path, target: Path) -> None:
    """Native slope in degrees, straight to COG.

    Written as a COG in one pass. The intermediate GeoTIFF the obvious two step
    version would produce is Float32 over 3.3 gigapixels, which is 13 GB before
    compression and read by nothing.
    """
    staging = settings.tmp_dir / target.name
    slope_from_dem(source, staging, geographic=True, cog=True)
    shutil.move(str(staging), str(target))


def build_scoring_grids(source: Path, elevation_5km: Path, slope_5km: Path) -> None:
    """The 5 km pair, in the order the models require.

    Resample first, derive slope second. Reversing these two lines is the single
    change that would silently shift every terrain score in the portal.
    """
    reduced = settings.tmp_dir / "elevation_5km_reduced.tif"
    resample_to(source, reduced, resolution=FIVE_KM_DEG, resampling="max")
    to_cog(reduced, elevation_5km, tmp_dir=settings.tmp_dir, float_data=False)

    slope_raw = settings.tmp_dir / "slope_5km_raw.tif"
    slope_from_dem(reduced, slope_raw, geographic=True)
    to_cog(slope_raw, slope_5km, tmp_dir=settings.tmp_dir, float_data=True)

    reduced.unlink(missing_ok=True)
    slope_raw.unlink(missing_ok=True)


PRODUCTS = [
    {
        "key": "elevation",
        "file": "elevation.tif",
        "what": "native grid, Int16, the elevation layer and per pixel CARI",
        "build": lambda src, dst: build_elevation(src, dst),
    },
    {
        "key": "slope",
        "file": "slope.tif",
        "what": "native grid, Float32 degrees, the slope layer",
        "build": lambda src, dst: build_slope(src, dst),
    },
    {
        "key": "elevation_5km",
        "file": "elevation_5km.tif",
        "what": "5 km max reduced, scoring input",
        "build": None,      # built as a pair, see build_scoring_grids
    },
    {
        "key": "slope_5km",
        "file": "slope_5km.tif",
        "what": "5 km, derived from the 5 km DEM, scoring input",
        "build": None,
    },
]


def statistics(path: Path) -> dict:
    """Exact min, max, mean and standard deviation.

    Approximate statistics are computed off the pyramid, which averages the
    peaks away: the delivered DEM reports a maximum of 5919 m approximately and
    8526 exactly. Worth the extra pass, because the display range in bands.json
    is judged against these numbers.

    GetStatistics(approx_ok=False, force=True) rather than a `gdalinfo -stats`
    subprocess. Both compute the same values, but this one reads the .aux.xml
    GDAL wrote the first time, where -stats recomputes from scratch. On a rerun
    that skips every product because it already exists, the difference is three
    and a half minutes of re-reading 7 GB to arrive at numbers already on disk.
    """
    info = inspect_raster(path)
    from osgeo import gdal

    ds = gdal.Open(str(path))
    band = ds.GetRasterBand(1)
    stats = band.GetStatistics(False, True)
    ds = None
    return {
        "min": stats[0], "max": stats[1], "mean": stats[2], "stddev": stats[3],
        "width": info.width, "height": info.height, "nodata": info.nodata,
    }


def catalog(env: dict, key: str, path: Path) -> None:
    """Record the band in wx.raster_catalog.

    The display range comes from the contract, not from the data, so the legend
    and the tiles read the same two numbers and cannot drift apart. The measured
    range is reported to the operator instead, which is the point at which a
    mismatch is a decision rather than a surprise.
    """
    spec = contracts.band(key)
    unit = spec.get("unit", "")
    minimum = spec.get("min")
    maximum = spec.get("max")

    psql(
        f"""
        INSERT INTO wx.raster_catalog
          (band_key, creation_time, lead_hours, path, unit, min_value, max_value, is_static)
        VALUES
          ('{key}', NULL, NULL, '{path}', '{unit}',
           {minimum if minimum is not None else 'NULL'},
           {maximum if maximum is not None else 'NULL'},
           true)
        ON CONFLICT (band_key, COALESCE(creation_time, 'epoch'::timestamptz),
                     COALESCE(lead_hours, -9999))
        DO UPDATE SET path = EXCLUDED.path,
                      unit = EXCLUDED.unit,
                      min_value = EXCLUDED.min_value,
                      max_value = EXCLUDED.max_value,
                      is_static = true,
                      created_at = now()
        """,
        env,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", default=DEFAULT_SOURCE)
    parser.add_argument("--only", action="append", default=None,
                        help="Build one product by key. Repeatable.")
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--force", action="store_true",
                        help="Rebuild products that already exist")
    parser.add_argument("--no-clip", action="store_true",
                        help="Skip clipping to the national boundary (use the raw source extent)")
    args = parser.parse_args()

    source = Path(args.file)
    if not source.exists():
        log(f"No such file: {source}")
        return 1

    info = inspect_raster(source)
    log("[source]")
    log(f"  path      {source}")
    log(f"  driver    {info.driver}")
    log(f"  crs       {info.crs}")
    log(f"  size      {info.width} x {info.height}  ({info.width * info.height / 1e9:.2f} gigapixels)")
    log(f"  nodata    {info.nodata}")
    log(f"  bounds    {info.bounds}")
    log(f"  valid COG {validate_cog(source)}")

    if info.crs != "EPSG:4326":
        log(f"\n  {info.crs} is not EPSG:4326. Everything downstream assumes one storage CRS.")
        return 1

    if info.width < MIN_WIDTH:
        log(f"\n  {info.width} px wide, expected at least {MIN_WIDTH}. "
            "Refusing to replace the terrain layers with a low resolution file.")
        return 1

    if args.inspect_only:
        return 0

    settings.tmp_dir.mkdir(parents=True, exist_ok=True)
    settings.cog_dir.mkdir(parents=True, exist_ok=True)

    wanted = set(args.only) if args.only else {p["key"] for p in PRODUCTS}
    unknown = wanted - {p["key"] for p in PRODUCTS}
    if unknown:
        log(f"Unknown product(s): {', '.join(sorted(unknown))}")
        return 1

    env = pg_env()
    started = time.time()

    # Clip the source to the national boundary once, up front, so every product
    # derives from an already clean edge. Clipping changes the pixels, so it
    # forces a rebuild: a cached product from before the clip would keep the old
    # blocky halo.
    if not args.no_clip:
        log("\n[clip]")
        export_cutline(env, CUTLINE)
        clipped = settings.tmp_dir / "dem_clipped.tif"
        step = time.time()
        clip_to_boundary(source, clipped, CUTLINE, info.nodata if info.nodata is not None else -32768)
        clipped_info = inspect_raster(clipped)
        log(f"  cutline   {CUTLINE} (union of geo.national)")
        log(f"  clipped   {clipped_info.width} x {clipped_info.height}, "
            f"was {info.width} x {info.height}  in {time.time() - step:.1f}s")
        source = clipped
        args.force = True

    # What this run produced, as opposed to what happens to be on disk. The two
    # scoring grids are built by one call, so without this the second of them
    # reports "exists, skipping" about a file the same run wrote thirty seconds
    # earlier, which reads as a product that was quietly not rebuilt.
    built_here: set[str] = set()

    for product in PRODUCTS:
        key = product["key"]
        target = settings.cog_dir / product["file"]

        if key not in wanted:
            continue

        if key in built_here:
            log(f"\n[{key}] {product['what']}")
            log("  built     alongside elevation_5km")
        elif target.exists() and not args.force:
            log(f"\n[{key}] exists, skipping. Use --force to rebuild.")
        else:
            log(f"\n[{key}] {product['what']}")
            step = time.time()

            if product["build"]:
                product["build"](source, target)
                built_here.add(key)
            elif key in ("elevation_5km", "slope_5km"):
                # The pair is built together, in a fixed order, because the
                # second one reads the first one's output.
                build_scoring_grids(
                    source,
                    settings.cog_dir / "elevation_5km.tif",
                    settings.cog_dir / "slope_5km.tif",
                )
                built_here.update({"elevation_5km", "slope_5km"})

            log(f"  built     {time.time() - step:.1f}s")

        if not target.exists():
            log(f"  {target} was not produced.")
            return 1

        if not validate_cog(target):
            log(f"  {target} did not pass COG validation. Not cataloguing it.")
            return 1

        size_mb = target.stat().st_size / 1e6
        stats = statistics(target)
        spec = contracts.band(key)
        log(f"  file      {target}  {size_mb:,.0f} MB")
        log(f"  grid      {stats['width']} x {stats['height']}, nodata {stats['nodata']}")
        log(f"  measured  {stats['min']:.1f} to {stats['max']:.1f}, "
            f"mean {stats['mean']:.1f}, sd {stats['stddev']:.1f}")
        log(f"  display   {spec.get('min')} to {spec.get('max')} {spec.get('unit', '')}"
            "   (bands.json, what the legend and the tiles both use)")

        if spec.get("max") is not None and stats["max"] > spec["max"] * 1.05:
            log(f"  note      the data reaches {stats['max']:.0f} {spec.get('unit', '')}, "
                f"above the {spec['max']} display ceiling, so the top of the range "
                "renders as one flat colour. Deliberate or not, it is a contract decision.")

        catalog(env, key, target)
        log(f"  catalogued as band {key}, static")

    log("\n[catalog]")
    rows = psql(
        "SELECT rpad(band_key, 16) || rpad(coalesce(unit, ''), 6) || path "
        "FROM wx.raster_catalog WHERE is_static ORDER BY band_key",
        env,
    ).strip()
    log("  " + rows.replace("\n", "\n  ") if rows else "  none")

    log(f"\nTotal {time.time() - started:.1f}s")
    log("\nSpot check a value against a known peak or plain:")
    log("  gdallocationinfo -valonly -wgs84 /data/cog/elevation.tif 74.0 31.5   # Lahore, low")
    log("  gdallocationinfo -valonly -wgs84 /data/cog/elevation.tif 76.5 35.9   # Karakoram, high")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
