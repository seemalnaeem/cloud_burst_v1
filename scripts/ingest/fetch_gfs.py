#!/usr/bin/env python3
"""Fetch a NOAA GFS cycle, clipped to Pakistan, with no authentication.

    docker compose exec cbd-api python3 /app/ingest/fetch_gfs.py --lead 24
    docker compose exec cbd-api python3 /app/ingest/fetch_gfs.py --lead 24 --dry-run

GFS replaces Google Earth Engine. It is fully open, needs no registration, and
carries every CARI variable natively including CAPE and precipitable water.
See OPEN_DATA_SOURCES.md section 1.

Downloads through the NOMADS filter, which subsets server side. A global GFS
file is around 500 MB, clipped to Pakistan it is a few megabytes, and this runs
across roughly 40 leads.
"""

from __future__ import annotations

import argparse
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, "/app")

from app.config import settings  # noqa: E402

# GFS parameter and level for each CARI variable. The mapping is here rather
# than in the contracts because it is specific to this source, and swapping to
# ECMWF Open Data would change it without changing any threshold.
GFS_VARIABLES = [
    ("APCP", "surface", "RF, accumulated precipitation"),
    ("CAPE", "180-0 mb above ground", "CAPE, the most unstable style layer"),
    ("PWAT", "entire atmosphere (considered as a single layer)", "TCWV"),
    ("RH", "700 mb", "RH700"),
    ("RH", "500 mb", "RH500"),
    ("VVEL", "700 mb", "VV700, Pa/s, negative is upward"),
    ("VVEL", "500 mb", "VV500"),
    ("TMP", "2 m above ground", "T2M, KELVIN"),
    ("TMP", "850 mb", "T850, KELVIN"),
    ("DPT", "2 m above ground", "DP, KELVIN"),
    ("UGRD", "850 mb", "wind u component"),
    ("VGRD", "850 mb", "wind v component"),
    ("CRAIN", "surface", "categorical rain flag, becomes precip type code 1"),
    ("CSNOW", "surface", "categorical snow flag, becomes code 5"),
    ("CICEP", "surface", "categorical ice pellets flag, becomes code 8"),
    ("CFRZR", "surface", "categorical freezing rain flag, becomes code 3"),
]

# NOMADS level parameter names, which are not the same as the human readable
# level strings above.
LEVEL_PARAMS = {
    "surface": "lev_surface",
    "2 m above ground": "lev_2_m_above_ground",
    "500 mb": "lev_500_mb",
    "700 mb": "lev_700_mb",
    "850 mb": "lev_850_mb",
    "180-0 mb above ground": "lev_180-0_mb_above_ground",
    "entire atmosphere (considered as a single layer)": "lev_entire_atmosphere_%5C%28considered_as_a_single_layer%5C%29",
}


def latest_cycle(now: datetime | None = None) -> tuple[str, str]:
    """Most recent GFS cycle that is likely to be published.

    Cycles run every 6 hours but take roughly 3.5 hours to finish publishing,
    so the newest one is usually not ready. Backing off 4 hours avoids a run of
    404s on files that exist in the directory listing but are still being
    written.
    """
    now = (now or datetime.now(timezone.utc)) - timedelta(hours=4)
    cycle_hour = (now.hour // 6) * 6
    return now.strftime("%Y%m%d"), f"{cycle_hour:02d}"


def build_url(date: str, cycle: str, lead: int) -> str:
    west, south, east, north = settings.aoi

    params = [
        ("file", f"gfs.t{cycle}z.pgrb2.0p25.f{lead:03d}"),
        ("dir", f"/gfs.{date}/{cycle}/atmos"),
        ("subregion", ""),
        ("leftlon", str(west)),
        ("rightlon", str(east)),
        ("toplat", str(north)),
        ("bottomlat", str(south)),
    ]

    query = urllib.parse.urlencode(params)

    # Level and variable flags are bare "on" switches, and the entire atmosphere
    # level is pre-encoded, so they are appended rather than urlencoded.
    for level in sorted({LEVEL_PARAMS[level] for _, level, _ in GFS_VARIABLES}):
        query += f"&{level}=on"
    for var in sorted({v for v, _, _ in GFS_VARIABLES}):
        query += f"&var_{var}=on"

    return f"{settings.upstream_gfs_filter}?{query}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lead", type=int, required=True, help="Forecast hour")
    parser.add_argument("--date", default=None, help="YYYYMMDD, defaults to the latest cycle")
    parser.add_argument("--cycle", default=None, help="00, 06, 12 or 18")
    parser.add_argument("--dry-run", action="store_true", help="Print the URL, download nothing")
    args = parser.parse_args()

    date, cycle = latest_cycle()
    date = args.date or date
    cycle = args.cycle or cycle

    url = build_url(date, cycle, args.lead)
    target = settings.raw_dir / f"gfs_{date}{cycle}_f{args.lead:03d}.grib2"

    print(f"cycle:  {date} {cycle}Z")
    print(f"lead:   {args.lead} h")
    print(f"aoi:    {settings.aoi}")
    print(f"target: {target}")
    print(f"\nurl:\n{url}\n")

    print("variables requested:")
    for var, level, note in GFS_VARIABLES:
        print(f"  {var:<6} {level:<50} {note}")

    if args.dry_run:
        print("\nDry run, nothing downloaded.")
        return 0

    settings.raw_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(f"{target}.part")

    try:
        # Download to a .part file and rename at the end. A truncated GRIB is
        # readable enough by GDAL to produce garbage rather than an error.
        req = urllib.request.Request(url, headers={"User-Agent": settings.upstream_user_agent})
        with urllib.request.urlopen(req, timeout=300) as response, tmp.open("wb") as fh:
            size = 0
            while chunk := response.read(1 << 20):
                fh.write(chunk)
                size += len(chunk)
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        print(f"\nDownload failed: {exc}", file=sys.stderr)
        print(
            "A 404 here usually means the cycle has not finished publishing. "
            "Try the previous cycle with --date and --cycle.",
            file=sys.stderr,
        )
        return 1

    # NOMADS returns a short HTML error page with a 200 status when the request
    # is malformed, so a tiny file is a failure rather than a small download.
    if size < 10_000:
        tmp.unlink(missing_ok=True)
        print(
            f"\nOnly {size} bytes returned. NOMADS answers a bad request with an HTML "
            "error page and a 200 status, so this is a failure. Check the level and "
            "variable names in the printed URL.",
            file=sys.stderr,
        )
        return 1

    tmp.rename(target)
    print(f"\nDownloaded {size / 1_048_576:.1f} MB to {target}")
    print("\nNext:")
    print(f"  gdalinfo {target} | grep -E 'Band |GRIB_ELEMENT|GRIB_SHORT_NAME'")
    print("  then ingest_raster.py per band, remembering that TMP and DPT are Kelvin")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
