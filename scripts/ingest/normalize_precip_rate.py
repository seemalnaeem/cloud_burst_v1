#!/usr/bin/env python3
"""Convert already-ingested precipitation COGs from per-step totals to a mm/hr rate.

The ingest now stores HOURTPE as a per-hour rate (each step divided by its own
length in hours), so the models compare on one honest unit. This one-off brings
the COGs already on disk onto the same basis without re-downloading them: for each
catalogued pmd_hourtpe raster it divides by the step measured from the model's own
lead sequence, rewrites the COG in place, and marks the catalogue row unit mm/hr.

    docker compose exec cbd-api python3 /app/ingest/normalize_precip_rate.py

Idempotent: a row already at unit mm/hr is skipped, so a re-run never divides
twice. WRFPRS is a 1 h step and so already a rate; its COGs are left untouched and
only the unit is corrected. If anything looks wrong, a full re-ingest of a model
regenerates it correctly from source.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/ingest")

import warnings  # noqa: E402

warnings.filterwarnings("ignore")

from pathlib import Path  # noqa: E402

from osgeo import gdal  # noqa: E402

from _pg import pg_env, psql  # noqa: E402

from app.config import settings  # noqa: E402
from app.geo.gdal_tools import to_cog, validate_cog  # noqa: E402

gdal.UseExceptions()

BAND = "pmd_hourtpe"
NODATA = -9999.0


def steps_by_lead(leads: list[int]) -> dict[int, int | None]:
    """Step length in hours ending at each lead, from the sorted lead sequence.

    The window is the gap back to the previous lead; the first lead borrows the
    next gap. Mirrors ingest_pmd.step_hours_for, but works from catalogued leads
    rather than the portal's forecast times.
    """
    s = sorted(leads)
    out: dict[int, int | None] = {}
    for i, lead in enumerate(s):
        if i == 0:
            out[lead] = (s[1] - s[0]) if len(s) > 1 else None
        else:
            out[lead] = s[i] - s[i - 1]
    return out


def divide_cog(path: Path, step: int) -> None:
    """Divide every valid pixel of a COG by step and rewrite it in place as a COG."""
    ds = gdal.Open(str(path))
    band = ds.GetRasterBand(1)
    arr = band.ReadAsArray().astype("float32")
    nd = band.GetNoDataValue()
    gt = ds.GetGeoTransform()
    proj = ds.GetProjection()
    mask = (arr == nd) if nd is not None else None
    ds = None

    arr = arr / float(step)
    if mask is not None:
        arr[mask] = NODATA

    settings.tmp_dir.mkdir(parents=True, exist_ok=True)
    stage = settings.tmp_dir / f"{path.stem}_rate_raw.tif"
    final = settings.tmp_dir / f"{path.stem}_rate.tif"
    driver = gdal.GetDriverByName("GTiff")
    out = driver.Create(str(stage), arr.shape[1], arr.shape[0], 1, gdal.GDT_Float32)
    out.SetGeoTransform(gt)
    out.SetProjection(proj)
    ob = out.GetRasterBand(1)
    ob.WriteArray(arr)
    ob.SetNoDataValue(NODATA)
    ob.FlushCache()
    out = None

    to_cog(stage, final, tmp_dir=settings.tmp_dir, float_data=True)
    stage.unlink(missing_ok=True)
    if not validate_cog(final):
        final.unlink(missing_ok=True)
        raise RuntimeError(f"{final} failed COG validation")
    os.replace(final, path)


def main() -> int:
    env = pg_env()
    rows = psql(
        f"SELECT model, lead_hours, path, unit FROM wx.raster_catalog "
        f"WHERE band_key = '{BAND}' ORDER BY model, lead_hours",
        env,
    ).strip()
    if not rows:
        print("no pmd_hourtpe rows catalogued, nothing to do")
        return 0

    by_model: dict[str, list[tuple[int, str, str]]] = {}
    for line in rows.splitlines():
        # psql -tA uses the pipe as its unaligned field separator.
        model, lead, path, unit = (line.split("|") + ["", "", "", ""])[:4]
        by_model.setdefault(model, []).append((int(lead), path, unit))

    for model, items in by_model.items():
        steps = steps_by_lead([lead for lead, _, _ in items])
        done = skipped = already = 0
        for lead, path, unit in items:
            if unit == "mm/hr":
                already += 1
                continue
            step = steps.get(lead)
            p = Path(path)
            try:
                if step and step != 1 and p.exists():
                    divide_cog(p, step)
                    done += 1
                else:
                    # WRFPRS (1 h) is already a rate; correct only the unit. A
                    # missing file is left for a re-ingest to regenerate.
                    skipped += 1
                psql(
                    f"UPDATE wx.raster_catalog SET unit = 'mm/hr' "
                    f"WHERE band_key = '{BAND}' AND model = '{model}' AND lead_hours = {lead}",
                    env,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"  {model} lead {lead}: {type(exc).__name__} {exc}, skipping")
        print(f"{model:8} divided={done:3} unit-only={skipped:3} already={already:3} (steps seen: {sorted({s for s in steps.values() if s})})")

    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
