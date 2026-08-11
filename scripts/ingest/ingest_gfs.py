#!/usr/bin/env python3
"""Ingest NOAA GFS wind and vertical velocity as temporal raster layers.

    docker compose exec cbd-api python3 /app/ingest/ingest_gfs.py --probe
    docker compose exec cbd-api python3 /app/ingest/ingest_gfs.py
    docker compose exec cbd-api python3 /app/ingest/ingest_gfs.py --max-leads 8

Why this exists: PMD serves humidity and temperature at pressure levels, but not
wind or vertical velocity as grids (it ships those only as geobuf contour
vectors under GPH). The two missing CARI dynamics inputs, wind speed at 850 hPa
and vertical velocity at 700 and 500 hPa, come cleanly from GFS, so this fills
them and gives the map a wind and a vertical-velocity layer under a NOAA GFS
model group, alongside the four PMD models.

An anonymous source, no credential. GFS pgrb2.0p25 files on the public S3 bucket
each carry a `.idx` sidecar listing every message and its byte offset, so we
download only the four messages we need per lead with HTTP range requests, a few
megabytes instead of the half gigabyte full file. The NOMADS filter service is
not used: it only keeps a rolling window and rejects the archive dates the bucket
still holds.

Per lead: range-GET UGRD/VGRD at 850 and VVEL at 700/500, derive wind speed as
the magnitude of u and v in km/h, keep vertical velocity in Pa/s, clip each to
the national boundary, COG it, catalogue it against the GFS cycle and lead.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/ingest")

warnings.filterwarnings("ignore")

import httpx  # noqa: E402
import numpy as np  # noqa: E402

from _pg import pg_env, psql  # noqa: E402
from ingest_terrain import CUTLINE, clip_to_boundary, export_cutline  # noqa: E402

from osgeo import gdal  # noqa: E402

from app.config import settings  # noqa: E402
from app.geo.gdal_tools import to_cog, validate_cog  # noqa: E402
from app.shared import contracts  # noqa: E402

gdal.UseExceptions()

S3 = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
MODEL = "GFS"
LEADS = list(range(0, 241, 3))  # 3-hourly to +240 h, aligned with the PMD grid


def log(m: str) -> None:
    print(m, flush=True)


def build_plan() -> list[dict]:
    """The GFS bands to produce, read from the contract, with their GRIB recipe.

    Contract driven for which bands exist; the recipe (how to turn GRIB messages
    into each band) is GFS specific and lives here.
    """
    plan = []
    for layer in contracts.layers().get("rasterLayers", []):
        if layer.get("source") != "gfs":
            continue
        level = int(layer["level"])
        if layer["element"] == "WIND":
            recipe = {"op": "magnitude", "messages": [("UGRD", level), ("VGRD", level)], "scale": 3.6}
        elif layer["element"] == "VVEL":
            recipe = {"op": "passthrough", "messages": [("VVEL", level)], "scale": 1.0}
        else:
            continue
        plan.append({"band": layer["band"], "level": level, **recipe})

    # Internal u and v at 850, not map layers. They back the barb overlay, which
    # needs the vectors to recover direction, not just the wind speed magnitude.
    # Their messages are already fetched for the wind-speed band, so this adds no
    # extra download. Only produced when the wind layer itself is in the contract.
    if any(b["band"] == "wind_speed_pl850" for b in plan):
        plan.append({"band": "wind_u_pl850", "level": 850, "op": "passthrough", "messages": [("UGRD", 850)], "scale": 1.0})
        plan.append({"band": "wind_v_pl850", "level": 850, "op": "passthrough", "messages": [("VGRD", 850)], "scale": 1.0})
    return plan


def s3_list(prefix: str) -> list[str]:
    r = httpx.get(f"{S3}/?list-type=2&prefix={prefix}&delimiter=/", timeout=30)
    r.raise_for_status()
    return re.findall(r"<Prefix>([^<]+)</Prefix>", r.text)


def latest_cycle() -> tuple[str, str]:
    """Newest (YYYYMMDD, HH) on the bucket that has an f000 file."""
    days = sorted(p for p in s3_list("gfs.") if re.search(r"gfs\.\d{8}/$", p))
    for day in reversed(days):
        date8 = re.search(r"(\d{8})", day).group(1)
        hours = sorted(re.search(r"/(\d{2})/$", h).group(1) for h in s3_list(day) if re.search(r"/\d{2}/$", h))
        for hh in reversed(hours):
            f000 = f"{day}{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f000"
            if httpx.head(f"{S3}/{f000}", timeout=30).status_code == 200:
                return date8, hh
    raise SystemExit("no complete GFS cycle found on the bucket")


def idx_ranges(grib_key: str, wanted: set[tuple[str, int]]) -> dict[tuple[str, int], tuple[int, int | None]]:
    """Byte ranges for the wanted (element, level_mb) messages, from the .idx."""
    lines = httpx.get(f"{S3}/{grib_key}.idx", timeout=60).text.splitlines()
    out: dict[tuple[str, int], tuple[int, int | None]] = {}
    for i, ln in enumerate(lines):
        parts = ln.split(":")
        if len(parts) < 5:
            continue
        var, lev = parts[3], parts[4]
        m = re.match(r"(\d+) mb$", lev)
        if not m:
            continue
        key = (var, int(m.group(1)))
        if key in wanted:
            start = int(parts[1])
            end = int(lines[i + 1].split(":")[1]) - 1 if i + 1 < len(lines) else None
            out[key] = (start, end)
    return out


def fetch_messages(grib_key: str, ranges: dict) -> Path:
    """Range-GET each message and concatenate into one local GRIB."""
    buf = b""
    for (start, end) in ranges.values():
        rng = f"bytes={start}-{end}" if end is not None else f"bytes={start}-"
        rr = httpx.get(f"{S3}/{grib_key}", headers={"Range": rng}, timeout=120)
        rr.raise_for_status()
        buf += rr.content
    dst = settings.tmp_dir / "gfs_sub.grib2"
    dst.write_bytes(buf)
    return dst


def band_index(ds, element: str, level_mb: int) -> int | None:
    """GDAL band whose GRIB element and isobaric level match. Levels are in Pa in
    the short name, so 850 hPa is 85000-ISBL."""
    target = f"{level_mb * 100}-ISBL"
    for i in range(1, ds.RasterCount + 1):
        md = ds.GetRasterBand(i).GetMetadata()
        if md.get("GRIB_ELEMENT") == element and md.get("GRIB_SHORT_NAME") == target:
            return i
    return None


def write_single(ref, array: np.ndarray, dst: Path) -> None:
    """Write one Float32 band georeferenced like the reference dataset."""
    drv = gdal.GetDriverByName("GTiff")
    out = drv.Create(str(dst), ref.RasterXSize, ref.RasterYSize, 1, gdal.GDT_Float32)
    out.SetGeoTransform(ref.GetGeoTransform())
    out.SetProjection(ref.GetProjection())
    band = out.GetRasterBand(1)
    band.SetNoDataValue(-9999.0)
    band.WriteArray(array.astype(np.float32))
    out.FlushCache()
    out = None


def register_cycle(env: dict, cycle: datetime, leads: list[int]) -> None:
    iso = cycle.isoformat()
    arr = "{" + ",".join(str(x) for x in sorted(set(leads))) + "}"
    psql(
        "INSERT INTO wx.cycles (model, creation_time, published_leads) "
        f"VALUES ('{MODEL}', '{iso}', '{arr}') "
        "ON CONFLICT (model, creation_time) DO UPDATE SET published_leads = EXCLUDED.published_leads",
        env,
    )


def catalogue(env: dict, band_key: str, cycle: datetime, lead: int, path: Path, spec: dict) -> None:
    iso = cycle.isoformat()
    mn, mx = spec.get("min"), spec.get("max")
    psql(
        "INSERT INTO wx.raster_catalog "
        "(band_key, model, creation_time, lead_hours, path, unit, min_value, max_value, is_static) "
        f"VALUES ('{band_key}', '{MODEL}', '{iso}', {lead}, '{path}', '{spec.get('unit','')}', "
        f"{mn if mn is not None else 'NULL'}, {mx if mx is not None else 'NULL'}, false) "
        "ON CONFLICT (band_key, COALESCE(model, ''), COALESCE(creation_time, 'epoch'::timestamptz), "
        "COALESCE(lead_hours, -9999)) "
        "DO UPDATE SET path = EXCLUDED.path, unit = EXCLUDED.unit, "
        "min_value = EXCLUDED.min_value, max_value = EXCLUDED.max_value, created_at = now()",
        env,
    )


def main() -> int:
    plan = build_plan()

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-leads", type=int, default=None, help="Cap timesteps, for a quick run")
    parser.add_argument("--probe", action="store_true", help="Report the cycle and plan, then exit")
    args = parser.parse_args()

    if not plan:
        log("No gfs layers in the contract. Nothing to do.")
        return 1

    date8, hh = latest_cycle()
    cycle_dt = datetime.strptime(date8 + hh, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    leads = LEADS[: args.max_leads] if args.max_leads else LEADS

    # Union of GRIB messages needed across all bands, fetched once per lead.
    wanted = {msg for b in plan for msg in b["messages"]}

    log(f"[GFS] cycle {date8} {hh}Z, {len(plan)} bands, {len(leads)} leads")
    log(f"      messages per lead: {sorted(wanted)}")
    if args.probe:
        for b in plan:
            log(f"  {b['band']:26} <- {b['op']:11} {b['messages']}")
        return 0

    env = pg_env()
    settings.tmp_dir.mkdir(parents=True, exist_ok=True)
    settings.cog_dir.mkdir(parents=True, exist_ok=True)
    if not Path(CUTLINE).exists():
        export_cutline(env, CUTLINE)

    register_cycle(env, cycle_dt, leads)
    started = time.time()
    done_leads: list[int] = []
    total = 0

    for lead in leads:
        grib_key = f"gfs.{date8}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f{lead:03d}"
        try:
            ranges = idx_ranges(grib_key, wanted)
        except Exception as exc:
            log(f"  lead {lead:3}: idx fetch failed ({exc}), skipping")
            continue
        missing = wanted - set(ranges)
        if missing:
            log(f"  lead {lead:3}: missing messages {sorted(missing)}, skipping")
            continue

        sub = fetch_messages(grib_key, ranges)
        ds = gdal.Open(str(sub))

        for b in plan:
            band_key = b["band"]
            # One band failing, most often a transient bind-mount permission blip
            # on /data/tmp under heavy IO, must not abort the whole run. Skip the
            # band and carry on; the next run fills the gap, this script being
            # idempotent on (band, model, cycle, lead).
            try:
                spec = contracts.band(band_key)
                raw = settings.tmp_dir / f"gfs_{band_key}_{lead}.tif"
                clipped = settings.tmp_dir / f"gfs_clip_{band_key}_{lead}.tif"
                target = settings.cog_dir / f"{MODEL}_{band_key}_{date8}{hh}_t{lead:03d}.tif"

                idxs = [band_index(ds, el, lv) for el, lv in b["messages"]]
                if any(i is None for i in idxs):
                    log(f"  lead {lead:3} {band_key}: band not found in subset, skipping")
                    continue

                if b["op"] == "magnitude":
                    u = ds.GetRasterBand(idxs[0]).ReadAsArray().astype(np.float64)
                    v = ds.GetRasterBand(idxs[1]).ReadAsArray().astype(np.float64)
                    arr = np.sqrt(u * u + v * v) * b["scale"]
                else:
                    arr = ds.GetRasterBand(idxs[0]).ReadAsArray().astype(np.float64) * b["scale"]

                write_single(ds, arr, raw)
                clip_to_boundary(raw, clipped, CUTLINE, -9999)
                to_cog(clipped, target, tmp_dir=settings.tmp_dir, float_data=True)
                raw.unlink(missing_ok=True)
                clipped.unlink(missing_ok=True)

                if not validate_cog(target):
                    log(f"  lead {lead:3} {band_key}: COG validation failed, skipping")
                    continue

                catalogue(env, band_key, cycle_dt, lead, target, spec)
                total += 1
            except Exception as exc:
                log(f"  lead {lead:3} {band_key}: {type(exc).__name__} {exc}, skipping")
                continue

        ds = None
        sub.unlink(missing_ok=True)
        done_leads.append(lead)
        if len(done_leads) % 12 == 0:
            log(f"  ...{len(done_leads)}/{len(leads)} leads, {total} rasters, {time.time()-started:.0f}s")

    register_cycle(env, cycle_dt, done_leads)
    log(f"[GFS] {total} rasters across {len(done_leads)} leads in {time.time()-started:.0f}s")
    return 0 if total else 1


if __name__ == "__main__":
    raise SystemExit(main())
