"""Historic cloudburst events: the CSV and its per-event images.

Two tables, filled together so they cannot drift apart:

  obs.events         one row per recorded event, the coordinates and the observed
                     physical values, plus district_name from a spatial overlay
                     against geo.districts (the CSV does not carry it).
  obs.event_photos   the images for each event, stored as bytes so the dataset is
                     self contained in the database and the local folders never
                     have to ship.

The source is delivered under docs/historical_data, which is gitignored. That is
not mounted into the container, so copy it in first and point --data-dir at it:

    docker cp docs/historical_data cbd-api:/tmp/historical_data
    docker exec cbd-api python3 /app/ingest/ingest_events.py --data-dir /tmp/historical_data

Idempotent: it truncates both tables and reloads from scratch, so a re-run after
a data fix leaves exactly the delivered set and nothing stale.

Row order in the CSV matches the numbered image folders (Sr. no -> "N. Name"),
which is how a row is joined to its pictures.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import os
import re
import struct
from datetime import date
from pathlib import Path

import asyncpg

SOURCE_NAME = "historical_events"
DEFAULT_DATA_DIR = "/tmp/historical_data"
CSV_NAME = "Cloudburst_Historical_Data_Updated.csv"

# CSV columns by position. The header row carries stray units and a non UTF-8
# byte in "kg/m2", so reading by index is steadier than by name.
COL = {
    "sr_no": 0, "location": 1, "occurrence": 2, "lat": 3, "lon": 4,
    "rainfall": 5, "cape": 6, "rh700": 7, "pwat": 8, "vv700": 9,
    "elevation": 10, "slope": 11,
}

_ORD = re.compile(r"(\d+)(st|nd|rd|th)", re.IGNORECASE)


def dsn() -> str:
    """asyncpg reads the same DATABASE_URL every service does. No host here."""
    return os.environ["DATABASE_URL"]


def to_float(raw: str | None) -> float | None:
    """A CSV number to a float. CAPE carries a thousands comma ("3,543.75")."""
    if raw is None:
        return None
    s = raw.strip().replace(",", "")
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_date(raw: str | None) -> date | None:
    """Parse the mixed occurrence strings into a real date where possible.

    Seen forms: "15 Aug, 2025", "22nd July, 2025", "17th July 2025",
    "1st Aug, 2024". Drop the ordinal suffix and the comma, then try an
    abbreviated and a full month name. Return None rather than guessing.
    """
    if not raw:
        return None
    s = _ORD.sub(r"\1", raw.replace(",", " "))
    s = " ".join(s.split())
    from datetime import datetime
    for fmt in ("%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def png_dimensions(data: bytes) -> tuple[int | None, int | None]:
    """Width and height from a PNG header, without pulling in an image library.

    The IHDR chunk is the first after the 8 byte signature; its width and height
    are two big endian uint32 at offsets 16 and 20. A non PNG returns (None, None).
    """
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None, None
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def folder_by_srno(data_dir: Path) -> dict[int, Path]:
    """Map a Sr. no to its image folder by the numeric prefix ("10. Gupis ...")."""
    out: dict[int, Path] = {}
    for child in sorted(data_dir.iterdir()):
        if not child.is_dir():
            continue
        m = re.match(r"\s*(\d+)\s*\.", child.name)
        if m:
            out[int(m.group(1))] = child
    return out


def read_rows(csv_path: Path) -> list[list[str]]:
    # errors="replace" so the stray byte in the PWAT header cannot abort the read;
    # only the header carries it and we key by position anyway.
    with csv_path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.reader(fh)
        rows = [r for r in reader if any(cell.strip() for cell in r)]
    return rows[1:]  # drop the header


async def district_for(conn: asyncpg.Connection, lon: float, lat: float) -> str | None:
    """The district a point falls in, by spatial overlay.

    Prefer the polygon that actually contains the point; if it sits just outside
    every boundary (a coordinate rounded off the coast or a border), fall back to
    the nearest district so a point is never left unlabelled.
    """
    pt = "ST_SetSRID(ST_MakePoint($1, $2), 4326)"
    name = await conn.fetchval(
        f"""
        SELECT district_name FROM geo.districts
        WHERE ST_Contains(geom, {pt})
        ORDER BY area_km2 ASC
        LIMIT 1
        """,
        lon, lat,
    )
    if name is not None:
        return name
    return await conn.fetchval(
        f"""
        SELECT district_name FROM geo.districts
        ORDER BY geom <-> {pt}
        LIMIT 1
        """,
        lon, lat,
    )


async def main() -> None:
    ap = argparse.ArgumentParser(description="Ingest historic cloudburst events and photos.")
    ap.add_argument("--data-dir", default=DEFAULT_DATA_DIR, help="Folder holding the CSV and the per-event image folders.")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    csv_path = data_dir / CSV_NAME
    if not csv_path.exists():
        raise SystemExit(f"CSV not found at {csv_path}. Copy docs/historical_data into the container first.")

    rows = read_rows(csv_path)
    folders = folder_by_srno(data_dir)

    conn = await asyncpg.connect(dsn())
    try:
        source_id = await conn.fetchval(
            """
            INSERT INTO meta.sources (name, kind, origin, notes)
            VALUES ($1, 'tabular', 'docs/historical_data', 'Historic cloudburst events, CSV plus per-event photos.')
            ON CONFLICT (name) DO UPDATE SET origin = EXCLUDED.origin
            RETURNING id
            """,
            SOURCE_NAME,
        )

        # Reload cleanly. CASCADE carries the truncate into obs.event_photos, and
        # RESTART IDENTITY resets both id sequences so a reload is deterministic.
        await conn.execute("TRUNCATE obs.events RESTART IDENTITY CASCADE")

        events = 0
        photos = 0
        unlabelled = 0
        for r in rows:
            def cell(key: str) -> str | None:
                idx = COL[key]
                return r[idx] if idx < len(r) else None

            sr_no = int(to_float(cell("sr_no")) or 0)
            location = (cell("location") or "").strip()
            lon = to_float(cell("lon"))
            lat = to_float(cell("lat"))
            if location == "" or lon is None or lat is None:
                continue

            district = await district_for(conn, lon, lat)
            if district is None:
                unlabelled += 1

            folder = folders.get(sr_no)
            photo_names = []
            if folder:
                photo_names = [p.name for p in sorted(folder.iterdir()) if p.suffix.lower() == ".png"]

            event_id = await conn.fetchval(
                """
                INSERT INTO obs.events (
                    sr_no, location_name, occurrence, occurred_on, district_name,
                    rainfall_mm, cape_j_kg, relative_humidity_pct, precipitable_water_mm,
                    vertical_velocity, elevation_m, slope_deg, photo_folder, photos,
                    geom, source_id
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                    ST_SetSRID(ST_MakePoint($15, $16), 4326), $17
                )
                RETURNING id
                """,
                sr_no, location, (cell("occurrence") or "").strip() or None,
                parse_date(cell("occurrence")), district,
                to_float(cell("rainfall")), to_float(cell("cape")),
                to_float(cell("rh700")), to_float(cell("pwat")),
                to_float(cell("vv700")), to_float(cell("elevation")),
                to_float(cell("slope")), folder.name if folder else None,
                photo_names or None, lon, lat, source_id,
            )
            events += 1

            for seq, name in enumerate(photo_names):
                data = (folder / name).read_bytes()
                width, height = png_dimensions(data)
                await conn.execute(
                    """
                    INSERT INTO obs.event_photos (event_id, seq, filename, mime, width, height, byte_size, image)
                    VALUES ($1, $2, $3, 'image/png', $4, $5, $6, $7)
                    """,
                    event_id, seq, name, width, height, len(data), data,
                )
                photos += 1

        await conn.execute(
            """
            INSERT INTO meta.ingest_runs (source_id, kind, feature_count, status, message)
            VALUES ($1, 'events', $2, 'ok', $3)
            """,
            source_id, events, f"{events} events, {photos} photos, {unlabelled} without a containing district",
        )

        print(f"Ingested {events} events and {photos} photos. {unlabelled} used the nearest-district fallback.")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
