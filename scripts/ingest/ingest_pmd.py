#!/usr/bin/env python3
"""Ingest PMD forecast fields as temporal raster layers, across models and levels.

    docker compose exec cbd-api python3 /app/ingest/ingest_pmd.py --probe
    docker compose exec cbd-api python3 /app/ingest/ingest_pmd.py              # every model in the contract
    docker compose exec cbd-api python3 /app/ingest/ingest_pmd.py --model GRAPES
    docker compose exec cbd-api python3 /app/ingest/ingest_pmd.py --model wrfprs --max-leads 8

The one authenticated data source. See .claude/guardrails/security.md for why
this exists and .claude/memory/no-authenticated-sources.md for the mechanics.

What to ingest is read from shared/contracts/layers.json, not hardcoded here:
every raster layer with source "pmd" names its model (the PMD data_type), its
element, its level and the band it lands in. So adding a layer is a contract
edit and this script follows. The plan today, probed against the portal:

    GRAPES  (CMA-GFS)    CAPE PWAT DPT RHU(sfc/700/500) TEM(sfc/850) TPE HOURTPE
    WRFPRS  (PMD-WRF)    CAPE DPT TEM(sfc/850) TPE HOURTPE RHU(700/500)
    ICON    (PMD-ICON)   CAPE DPT RHU TEM TPE HOURTPE   (surface only for this run)
    D1D     (ECMWF-IFS)  TEM(sfc/850) RHU(700/500) HOURTPE

The pressure levels RHU 700/500 and TEM 850 are the CARI inputs the surface-only
feed lacked; they are fetched by passing the level parameter to
getModelForecastLatest. Wind and vertical velocity are still absent as grids:
the portal serves those only as geobuf contour vectors under the GPH element,
not as rasters, so they are not ingested here.

Per field per lead: download the tiff, clip to the national boundary, convert to
a COG, catalogue it against the model, cycle and lead. Each model's cycle goes in
wx.cycles so the timeline can discover it per model.
"""

from __future__ import annotations

import argparse
import sys
import time
import warnings
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/ingest")

warnings.filterwarnings("ignore")  # self-signed cert on the PMD host, handled below

import httpx  # noqa: E402

from _pg import pg_env, psql  # noqa: E402
from ingest_terrain import CUTLINE, clip_to_boundary, export_cutline  # noqa: E402

from osgeo import gdal  # noqa: E402

from app.config import settings  # noqa: E402
from app.geo.gdal_tools import to_cog, validate_cog  # noqa: E402
from app.shared import contracts  # noqa: E402

gdal.UseExceptions()


def is_float_raster(path: Path) -> bool:
    """Whether band 1 is floating point.

    The COG predictor differs by type, 3 for float and 2 for integer, and
    gdal_translate refuses predictor 3 on integer data outright. PMD serves CAPE
    as Float32 but PWAT and others as integers, so this is read per file.
    """
    ds = gdal.Open(str(path))
    dt = ds.GetRasterBand(1).DataType
    ds = None
    return dt in (gdal.GDT_Float32, gdal.GDT_Float64)


def scale_raster(src: Path, dst: Path, factor: float, nodata: float = -9999.0) -> None:
    """Multiply every valid pixel by factor, writing Float32.

    The portal serves its Int16 fields as tenths of the physical unit, so a raw
    temperature of 448 is 44.8 C and a raw humidity of 1000 is 100 percent. The
    band's sourceScale in bands.json is that factor; applying it here means the
    stored COG, the legend, the identify tool and the CARI inputs all read the
    unit the contract declares rather than ten times it. Nodata pixels are left
    at the nodata sentinel, never scaled, so the boundary clip keeps a clean edge.
    """
    ds = gdal.Open(str(src))
    band = ds.GetRasterBand(1)
    arr = band.ReadAsArray().astype("float32")
    nd = band.GetNoDataValue()
    mask = (arr == nd) if nd is not None else None
    arr = arr * factor
    if mask is not None:
        arr[mask] = nodata

    driver = gdal.GetDriverByName("GTiff")
    out = driver.Create(str(dst), ds.RasterXSize, ds.RasterYSize, 1, gdal.GDT_Float32)
    out.SetGeoTransform(ds.GetGeoTransform())
    out.SetProjection(ds.GetProjection())
    out_band = out.GetRasterBand(1)
    out_band.WriteArray(arr)
    out_band.SetNoDataValue(nodata)
    out_band.FlushCache()
    out = None
    ds = None


def build_plan() -> dict[str, dict]:
    """Group the contract's PMD raster layers by model.

    Returns data_type -> {modelId, label, items:[(element, level, band)]}. This is
    the single source of truth: the panel, the tiles and this ingest all read the
    same layer definitions, so none can disagree about what a band means.
    """
    plan: dict[str, dict] = {}
    for layer in contracts.layers().get("rasterLayers", []):
        if layer.get("source") != "pmd":
            continue
        dt = layer["model"]
        entry = plan.setdefault(dt, {"modelId": layer["modelId"], "label": layer["modelLabel"], "items": []})
        entry["items"].append((layer["element"], int(layer["level"]), layer["band"]))
    return plan


def log(m: str) -> None:
    print(m, flush=True)


class Pmd:
    """A logged-in PMD session.

    The API authenticates on an HttpOnly ews_jwt cookie, not a bearer header, so
    the httpx client's cookie jar is the whole auth mechanism after login.
    """

    def __init__(self) -> None:
        if not settings.pmd_configured:
            raise SystemExit(
                "PMD_BASE, PMD_USER and PMD_PASS are not all set. This is the one "
                "authenticated source; see .claude/guardrails/security.md."
            )
        self.base = settings.pmd_base.rstrip("/")
        self.client = httpx.Client(verify=settings.pmd_verify_tls, timeout=90)

    def login(self) -> None:
        r = self.client.post(
            f"{self.base}/user/login",
            json={"username": settings.pmd_user, "password": settings.pmd_pass},
        )
        r.raise_for_status()
        if not self.client.cookies.get("ews_jwt"):
            raise SystemExit("PMD login returned no ews_jwt cookie. Check the credentials.")

    def latest(self, data_type: str, element: str, level: int = 0) -> list[dict]:
        """Forecast steps for a field. level is sent only for pressure fields, so
        surface calls stay byte for byte the request the portal makes."""
        params = {"data_type": data_type, "element": element}
        if level:
            params["level"] = level
        r = self.client.get(f"{self.base}/api/getModelForecastLatest", params=params)
        r.raise_for_status()
        return r.json().get("ds") or []

    def download(self, file_path: str, dst: Path) -> None:
        with self.client.stream("GET", f"{self.base}{file_path}") as r:
            r.raise_for_status()
            with dst.open("wb") as fh:
                for chunk in r.iter_bytes(65536):
                    fh.write(chunk)


def probe(pmd: Pmd, plan: dict[str, dict]) -> int:
    """Print how many steps each contract field returns right now. Ingests nothing."""
    log("PMD availability for the contract's forecast layers (steps in the latest cycle):\n")
    for dt, entry in plan.items():
        log(f"{dt}  ({entry['label']})")
        for element, level, band in entry["items"]:
            n = len(pmd.latest(dt, element, level))
            lvl = "sfc" if level == 0 else f"{level}hPa"
            log(f"    {element:8} {lvl:7} -> {band:14} {n:3} steps")
        log("")
    return 0


def lead_from_cycle(cycle: datetime, forecast_time: str) -> int:
    """Hours from the model cycle to a step's valid time.

    The lead is measured against the model's cycle, not the field's own
    initialization. Some fields, HOURTPE and TPE especially, are carried over
    from an earlier run and so are initialized 12 or 24 hours before the model's
    main cycle. Measuring their lead from their own init put them on a shifted
    grid that did not line up with the cycle the slider scrubs, so a request for
    a normal lead found no tile and the map showed a 502. Measuring every field
    from the one cycle keeps them all on the same timeline. Steps that fall
    before the cycle come out negative and are dropped by the caller.
    """
    b = datetime.fromisoformat(forecast_time.replace("Z", "+00:00"))
    # forecast_time comes without an offset, so it parses naive; the cycle is
    # tz-aware from parse_cycle. Tag the step UTC so the two can be subtracted.
    if b.tzinfo is None:
        b = b.replace(tzinfo=timezone.utc)
    return int((b - cycle).total_seconds() // 3600)


def parse_cycle(data_time: str) -> datetime:
    return datetime.fromisoformat(data_time.replace("Z", "+00:00")).astimezone(timezone.utc)


def register_cycle(env: dict, model: str, cycle: datetime, leads: list[int]) -> None:
    iso = cycle.isoformat()
    leads_arr = "{" + ",".join(str(x) for x in sorted(set(leads))) + "}"
    psql(
        "INSERT INTO wx.cycles (model, creation_time, published_leads) "
        f"VALUES ('{model}', '{iso}', '{leads_arr}') "
        "ON CONFLICT (model, creation_time) DO UPDATE SET published_leads = EXCLUDED.published_leads",
        env,
    )


def catalogue(env: dict, model: str, band_key: str, cycle: datetime, lead: int, path: Path, spec: dict) -> None:
    iso = cycle.isoformat()
    unit = spec.get("unit", "")
    mn = spec.get("min")
    mx = spec.get("max")
    psql(
        "INSERT INTO wx.raster_catalog "
        "(band_key, model, creation_time, lead_hours, path, unit, min_value, max_value, is_static) "
        f"VALUES ('{band_key}', '{model}', '{iso}', {lead}, '{path}', '{unit}', "
        f"{mn if mn is not None else 'NULL'}, {mx if mx is not None else 'NULL'}, false) "
        "ON CONFLICT (band_key, COALESCE(model, ''), COALESCE(creation_time, 'epoch'::timestamptz), "
        "COALESCE(lead_hours, -9999)) "
        "DO UPDATE SET path = EXCLUDED.path, unit = EXCLUDED.unit, "
        "min_value = EXCLUDED.min_value, max_value = EXCLUDED.max_value, created_at = now()",
        env,
    )


def ingest_model(pmd: Pmd, env: dict, dt: str, entry: dict, max_leads: int | None) -> int:
    """Ingest every field of one model. Returns the number of steps catalogued."""
    log(f"[{dt}] {entry['label']}, {len(entry['items'])} fields")
    # Rebuild the model from scratch, so a re-run that changes how a lead is
    # computed cannot leave stale rows at the old lead. Only this model's rows go;
    # other models and the static terrain rows are untouched.
    psql(f"DELETE FROM wx.raster_catalog WHERE model = '{dt}'", env)
    cycle_dt: datetime | None = None
    all_leads: list[int] = []
    total = 0

    for element, level, band_key in entry["items"]:
        try:
            spec = contracts.band(band_key)
        except KeyError:
            log(f"  {element}/{level}: band {band_key} missing from bands.json, skipping")
            continue

        records = pmd.latest(dt, element, level)
        if not records:
            log(f"  {element:8} {('sfc' if level == 0 else str(level)+'hPa'):7} no data, skipping")
            continue

        records.sort(key=lambda r: r["forecast_time"])
        if max_leads:
            records = records[:max_leads]

        # The cycle must exist before anything is catalogued against it, because
        # the catalogue has a foreign key onto wx.cycles. Register it from the
        # first field that returns data, then refine published_leads at the end.
        if cycle_dt is None:
            cycle_dt = parse_cycle(records[0]["data_time"])
            field_leads = [x for r in records if (x := lead_from_cycle(cycle_dt, r["forecast_time"])) >= 0]
            register_cycle(env, dt, cycle_dt, field_leads)

        step = time.time()
        done = 0
        for rec in records:
            lead = lead_from_cycle(cycle_dt, rec["forecast_time"])
            # Steps valid before the model cycle are history from a carried-over
            # field; they are not on the forecast timeline, so drop them.
            if lead < 0:
                continue
            # One step failing, most often a transient bind-mount permission blip
            # on /data/tmp under heavy IO, must not abort the whole run. Skip it;
            # the next run fills the gap, this script being idempotent.
            try:
                raw = settings.tmp_dir / f"pmd_raw_{dt}_{band_key}_{lead}.tif"
                clipped = settings.tmp_dir / f"pmd_clip_{dt}_{band_key}_{lead}.tif"
                target = settings.cog_dir / f"{dt}_{band_key}_{cycle_dt:%Y%m%d%H}_t{lead:03d}.tif"

                pmd.download(rec["file_path"], raw)
                # Guard against degenerate source rasters. PMD sometimes serves a
                # field as a one-row strip rather than a grid (ICON DPT, RHU and
                # TEM came back 561x1 for this cycle); clipping that produces an
                # almost empty layer that renders as a flat rectangle over the
                # whole bounding box. Skip it so the layer stays disabled and
                # honestly pending rather than showing broken data.
                probe = gdal.Open(str(raw))
                sw, sh = probe.RasterXSize, probe.RasterYSize
                probe = None
                if sw < 2 or sh < 2:
                    raw.unlink(missing_ok=True)
                    log(f"  {element} {level} lead {lead}: degenerate source {sw}x{sh}, skipping")
                    continue
                # Bring the raw pixels into the unit the contract declares. The
                # portal encodes tenths only in its Int16 rasters (GRAPES, ECMWF
                # and GDFS): a raw temperature of 446 is 44.6 C. Its Float32
                # rasters (PMD-WRF, ICON, and CAPE everywhere) are already in
                # physical units, so scaling them would divide a correct value.
                # The data type is the tell, so sourceScale is applied only to an
                # integer source. Scaling before the clip keeps one Float32 path
                # into the COG for the fields that need it.
                scale = float(spec.get("sourceScale", 1.0))
                source = raw
                if scale != 1.0 and not is_float_raster(raw):
                    scaled = settings.tmp_dir / f"pmd_scaled_{dt}_{band_key}_{lead}.tif"
                    scale_raster(raw, scaled, scale)
                    raw.unlink(missing_ok=True)
                    source = scaled
                # Clip the Asia-wide field to the national boundary, so the
                # temporal layers share the terrain layers' clean edge and carry
                # far fewer pixels than the raw continental tile.
                clip_to_boundary(source, clipped, CUTLINE, -9999)
                to_cog(clipped, target, tmp_dir=settings.tmp_dir, float_data=is_float_raster(clipped))
                source.unlink(missing_ok=True)
                clipped.unlink(missing_ok=True)

                if not validate_cog(target):
                    log(f"  {element} {level} lead {lead}: COG validation failed, skipping")
                    continue

                catalogue(env, dt, band_key, cycle_dt, lead, target, spec)
                all_leads.append(lead)
                done += 1
            except Exception as exc:
                log(f"  {element} {level} lead {lead}: {type(exc).__name__} {exc}, skipping")
                continue

        lvl = "sfc" if level == 0 else f"{level}hPa"
        log(f"  {element:8} {lvl:7} -> {band_key:14} {done:3} steps in {time.time() - step:.0f}s")
        total += done

    if cycle_dt is not None:
        register_cycle(env, dt, cycle_dt, all_leads)
        log(f"  cycle {cycle_dt:%Y-%m-%d %H:%MZ}, {len(set(all_leads))} distinct leads\n")
    else:
        log("  nothing ingested for this model\n")
    return total


def main() -> int:
    plan = build_plan()

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=None,
                        help="Restrict to one model, by data_type (GRAPES) or contract id (grapes). Default: all.")
    parser.add_argument("--max-leads", type=int, default=None,
                        help="Cap the number of timesteps per field, for a quick run")
    parser.add_argument("--probe", action="store_true", help="Report availability and exit")
    args = parser.parse_args()

    if args.model:
        want = args.model.upper()
        plan = {dt: e for dt, e in plan.items() if dt == want or e["modelId"] == args.model.lower()}
        if not plan:
            log(f"No contract model matches {args.model!r}. Known: "
                + ", ".join(f"{dt}/{e['modelId']}" for dt, e in build_plan().items()))
            return 1

    pmd = Pmd()
    pmd.login()

    if args.probe:
        return probe(pmd, plan)

    env = pg_env()
    settings.tmp_dir.mkdir(parents=True, exist_ok=True)
    settings.cog_dir.mkdir(parents=True, exist_ok=True)
    if not Path(CUTLINE).exists():
        export_cutline(env, CUTLINE)

    started = time.time()
    grand = 0
    for dt, entry in plan.items():
        grand += ingest_model(pmd, env, dt, entry, args.max_leads)

    log(f"Total {grand} steps across {len(plan)} model(s) in {time.time() - started:.0f}s")
    return 0 if grand else 1


if __name__ == "__main__":
    raise SystemExit(main())
