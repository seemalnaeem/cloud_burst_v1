#!/usr/bin/env python3
"""Convert a raster source to a validated COG and catalog it.

    docker compose exec cbd-api python3 /app/ingest/ingest_raster.py \
        --file /data/raw/cycle.grib2 \
        --band-key most_unstable_cape_sfc \
        --band-index 7 \
        --creation-time 2026-08-06T00:00:00Z \
        --lead 24

Follows .claude/playbooks/ingest-raster-source.md: inspect, extract, convert,
validate, then move into place and catalog.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, "/app")

from app.config import settings  # noqa: E402
from app.geo.gdal_tools import inspect_raster, to_cog, validate_cog  # noqa: E402
from app.shared import contracts  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True)
    parser.add_argument("--band-key", required=True, help="Key from bands.json")
    parser.add_argument("--band-index", type=int, default=None, help="1 based band index for GRIB")
    parser.add_argument("--subdataset", default=None, help="NetCDF variable name")
    parser.add_argument("--creation-time", default=None)
    parser.add_argument("--lead", type=int, default=None)
    parser.add_argument("--static", action="store_true", help="Terrain and other cycle independent rasters")
    parser.add_argument("--inspect-only", action="store_true")
    args = parser.parse_args()

    # The band has to exist in the contract, otherwise the tile route cannot
    # resolve its display range and palette later.
    try:
        spec = contracts.band(args.band_key)
    except KeyError:
        keys = [b["key"] for b in contracts.bands()["bands"]]
        print(f"Unknown band {args.band_key!r}. Known keys:\n  " + "\n  ".join(keys), file=sys.stderr)
        return 1

    source = args.file
    if args.subdataset:
        source = f'NETCDF:"{args.file}":{args.subdataset}'

    info = inspect_raster(source if not args.band_index else args.file)
    print(f"driver:   {info.driver}")
    print(f"crs:      {info.crs}")
    print(f"size:     {info.width} x {info.height}")
    print(f"bands:    {info.bands}")
    print(f"nodata:   {info.nodata}")
    print(f"bounds:   {info.bounds}")

    west, south, east, north = info.bounds
    if east > 180.5:
        print(
            "\nLongitude runs past 180, this is the 0 to 360 convention GRIB often uses. "
            "Warp to a -180 to 180 extent first or the map splits down the middle.",
            file=sys.stderr,
        )

    if spec.get("min") is not None:
        print(f"\ncontract display range for this band: {spec['min']} to {spec['max']} {spec.get('unit', '')}")
        print("Compare against gdalinfo -stats before trusting the tiles.")

    if args.inspect_only:
        return 0

    stem = _output_name(args)
    tmp_extract = settings.tmp_dir / f"{stem}_extract.tif"
    settings.tmp_dir.mkdir(parents=True, exist_ok=True)

    extract_cmd = ["gdal_translate"]
    if args.band_index:
        extract_cmd += ["-b", str(args.band_index)]
    # Categorical data must never be interpolated. Averaging codes 1 and 5
    # gives 3, which is a different category entirely.
    if spec.get("categorical"):
        extract_cmd += ["-r", "nearest"]
    extract_cmd += [source, str(tmp_extract)]

    print(f"\nextracting: {' '.join(extract_cmd)}")
    subprocess.run(extract_cmd, check=True)

    target = settings.cog_dir / f"{stem}.tif"
    print(f"converting to COG: {target}")
    to_cog(
        tmp_extract,
        target,
        tmp_dir=settings.tmp_dir,
        float_data=not spec.get("categorical"),
    )
    tmp_extract.unlink(missing_ok=True)

    if not validate_cog(target):
        print(f"\n{target} did not pass COG validation. Not cataloguing it.", file=sys.stderr)
        return 1

    print("\nCOG validated. Catalog it with:\n")
    print(_catalog_sql(args, target, spec))
    return 0


def _output_name(args) -> str:
    parts = [args.band_key]
    if args.creation_time:
        parts.append(args.creation_time.replace(":", "").replace("-", "").replace("T", "").rstrip("Z"))
    if args.lead is not None:
        parts.append(f"t{args.lead:03d}")
    return "_".join(parts)


def _catalog_sql(args, path: Path, spec: dict) -> str:
    creation = f"'{args.creation_time}'" if args.creation_time else "NULL"
    lead = str(args.lead) if args.lead is not None else "NULL"

    return f"""INSERT INTO wx.raster_catalog
  (band_key, creation_time, lead_hours, path, unit, min_value, max_value, is_static)
VALUES
  ('{args.band_key}', {creation}, {lead}, '{path}',
   '{spec.get("unit", "")}', {spec.get("min", "NULL")}, {spec.get("max", "NULL")},
   {str(args.static).lower()})
ON CONFLICT DO NOTHING;"""


if __name__ == "__main__":
    raise SystemExit(main())
