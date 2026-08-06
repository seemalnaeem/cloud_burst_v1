#!/usr/bin/env python3
"""Ingest the four administrative boundary layers into PostGIS.

Runs inside cbd-api, which carries GDAL, ogr2ogr and psql.

    docker compose exec cbd-api python3 /app/ingest/ingest_admin.py
    docker compose exec cbd-api python3 /app/ingest/ingest_admin.py --dry-run

Staging happens layer by layer through ogr2ogr, then db/ingest/promote_admin.sql
promotes all four in a single transaction. Splitting the promotion out keeps the
decisions about names, keys and corrections in reviewable SQL rather than buried
in string building here.

Why the source measure columns are dropped rather than carried across: they are
in degrees. Shape_Area for a Sindh district and one for a Gilgit district are
not on the same scale, because a degree of longitude is 96 km at Karachi and
88 km at Gilgit. geo.rebuild_measures() replaces them with geodesic values.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time

DATA_DIR = os.environ.get("ADMIN_DIR", "/data/vector/admin_final")
PROMOTE_SQL = "/app/db_ingest/promote_admin.sql"

# Source file, staging table, the fields we keep, and the floor below which the
# file is assumed to be truncated or the wrong file entirely.
LAYERS = [
    {
        "name": "national",
        "file": "National_Boundary.shp",
        "staging": "stg.national_raw",
        "keep": ["OBJECTID", "Admin01_Na"],
        "minimum": 1,
    },
    {
        "name": "provinces",
        "file": "Provincial_Boundary.shp",
        "staging": "stg.provinces_raw",
        "keep": ["OBJECTID", "Province"],
        "minimum": 8,
    },
    {
        "name": "districts",
        "file": "District_Boundary.shp",
        "staging": "stg.districts_raw",
        "keep": ["id", "objectid", "division", "province", "country",
                 "population", "districts"],
        "minimum": 180,
    },
    {
        "name": "tehsils",
        "file": "Tehsil_Boundary.shp",
        "staging": "stg.tehsils_raw",
        "keep": ["gid", "objectid", "province", "district", "tehsil"],
        "minimum": 500,
    },
]

# Dropped on purpose, reported so the reason is visible in the run log.
DROPPED = {
    "Shape_Leng": "perimeter in degrees",
    "Shape_Area": "area in square degrees",
    "shape_leng": "perimeter in degrees",
    "shape_area": "area in square degrees",
    "shape_le_1": "duplicate of shape_leng",
    "Area_Sq_Km": "area in an unstated projection",
    "area_sq_km": "area in an unstated projection",
}


def pg_env() -> dict:
    """Connection settings for ogr2ogr and psql, from DATABASE_URL."""
    url = os.environ["DATABASE_URL"].replace("postgresql://", "")
    creds, hostpart = url.split("@", 1)
    user, password = creds.split(":", 1)
    hostport, dbname = hostpart.split("/", 1)
    host, port = hostport.split(":", 1)
    return {
        "PGHOST": host, "PGPORT": port, "PGDATABASE": dbname,
        "PGUSER": user, "PGPASSWORD": password,
    }


def run(cmd: list[str], env: dict) -> str:
    merged = {**os.environ, **env}
    proc = subprocess.run(cmd, env=merged, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout + "\n" + proc.stderr + "\n")
        raise SystemExit(f"Command failed: {' '.join(cmd[:3])}...")
    return proc.stdout


def psql(sql: str, env: dict, quiet: bool = True) -> str:
    args = ["psql", "-v", "ON_ERROR_STOP=1", "-c", sql]
    if quiet:
        args[1:1] = ["-tA"]
    return run(args, env)


def stage(layer: dict, env: dict, dry_run: bool) -> None:
    path = os.path.join(DATA_DIR, layer["file"])
    if not os.path.exists(path):
        raise SystemExit(f"Missing source file: {path}")

    info = run(["ogrinfo", "-so", "-al", path], {})
    count = _field(info, "Feature Count:")
    print(f"  file      {layer['file']}")
    print(f"  features  {count}")
    print(f"  crs       {_crs(info)}")

    if int(count) < layer["minimum"]:
        raise SystemExit(
            f"  {layer['name']}: {count} features, expected at least "
            f"{layer['minimum']}. Refusing to replace a full layer with a partial one."
        )

    present = [line.split(":")[0].strip() for line in info.splitlines() if ": " in line]
    dropping = [f for f in DROPPED if f in present]
    if dropping:
        print("  dropping  " + ", ".join(f"{f} ({DROPPED[f]})" for f in dropping))

    if dry_run:
        print("  staged    no, dry run")
        return

    dsn = (f"PG:host={env['PGHOST']} port={env['PGPORT']} dbname={env['PGDATABASE']} "
           f"user={env['PGUSER']} password={env['PGPASSWORD']}")

    select = ",".join(layer["keep"])
    cmd = [
        "ogr2ogr",
        "-f", "PostgreSQL", dsn, path,
        "-nln", layer["staging"],
        "-select", select,          # the dropped columns never reach the database
        "-overwrite",
        "-nlt", "MULTIPOLYGON",
        "-t_srs", "EPSG:4326",
        "-lco", "GEOMETRY_NAME=geom",
        "-lco", "FID=src_fid",
        "-lco", "SPATIAL_INDEX=NONE",   # staging is read once, an index costs more than it saves
        "-makevalid",
        "-skipfailures",
        "--config", "SHAPE_ENCODING", "UTF-8",
        "--config", "PG_USE_COPY", "YES",
    ]
    started = time.time()
    run(cmd, env)
    staged = psql(f"SELECT count(*) FROM {layer['staging']}", env).strip()
    print(f"  staged    {staged} rows into {layer['staging']} in {time.time() - started:.1f}s")

    if int(staged) != int(count):
        raise SystemExit(
            f"  {layer['name']}: staged {staged} of {count} features. "
            "A dropped feature is a district that vanishes from every result with no error."
        )


def _field(info: str, label: str) -> str:
    for line in info.splitlines():
        if line.startswith(label):
            return line.split(":", 1)[1].strip()
    return "?"


def _crs(info: str) -> str:
    for line in info.splitlines():
        if line.strip().startswith('GEOGCRS[') or line.strip().startswith('PROJCRS['):
            return line.strip().split('"')[1]
    return "unknown"


def report(env: dict) -> None:
    queries = [
        ("Rows per layer", """
            SELECT 'national' AS layer, count(*)::text AS rows FROM geo.national
            UNION ALL SELECT 'provinces', count(*)::text FROM geo.provinces
            UNION ALL SELECT 'districts', count(*)::text FROM geo.districts
            UNION ALL SELECT 'tehsils',   count(*)::text FROM geo.tehsils
        """),
        ("Districts per province", """
            SELECT p.province_code || '  ' || rpad(p.province, 40) ||
                   lpad(count(d.*)::text, 4) || ' districts, ' ||
                   to_char(sum(d.area_km2), 'FM999G999G990') || ' km2'
            FROM geo.provinces p LEFT JOIN geo.districts d USING (province_code)
            GROUP BY p.province_code, p.province ORDER BY p.province_code
        """),
        # Percent inside the parent is the check on the reconciliation. A method
        # that resolves every row but averages 30 percent containment has
        # attached tehsils to the wrong districts.
        ("Tehsil parent resolution", """
            SELECT rpad(t.link_method, 10) || lpad(count(*)::text, 5) ||
                   '   mean ' ||
                   lpad(round(avg(ST_Area(ST_Intersection(t.geom, d.geom))
                        / NULLIF(ST_Area(t.geom), 0) * 100)::numeric, 1)::text, 6) ||
                   '% inside parent, worst ' ||
                   round(min(ST_Area(ST_Intersection(t.geom, d.geom))
                        / NULLIF(ST_Area(t.geom), 0) * 100)::numeric, 1)::text || '%'
            FROM geo.tehsils t LEFT JOIN geo.districts d USING (district_code)
            GROUP BY t.link_method ORDER BY count(*) DESC
        """),
        ("Unresolved tehsils", """
            SELECT province_code || '  ' || district_src || '  ' || tehsil
            FROM geo.tehsils WHERE district_code IS NULL
            ORDER BY province_code, district_src, tehsil
        """),
        # Proof that the trim actually happened, checked on the stored values
        # rather than on the statement that was supposed to do it. Also catches
        # the embedded CR LF pairs, since btrim treats them as whitespace.
        ("Untrimmed or control characters left in any name", """
            SELECT col || ': ' || count(*) FROM (
              SELECT 'districts.district_name' AS col FROM geo.districts
                WHERE district_name <> btrim(district_name) OR district_name ~ '[\\r\\n\\t]'
              UNION ALL
              SELECT 'districts.division' FROM geo.districts
                WHERE division <> btrim(division) OR division ~ '[\\r\\n\\t]'
              UNION ALL
              SELECT 'districts.province' FROM geo.districts
                WHERE province <> btrim(province) OR province ~ '[\\r\\n\\t]'
              UNION ALL
              SELECT 'tehsils.tehsil' FROM geo.tehsils
                WHERE tehsil <> btrim(tehsil) OR tehsil ~ '[\\r\\n\\t]'
              UNION ALL
              SELECT 'tehsils.district_src' FROM geo.tehsils
                WHERE district_src <> btrim(district_src) OR district_src ~ '[\\r\\n\\t]'
              UNION ALL
              SELECT 'provinces.province' FROM geo.provinces
                WHERE province <> btrim(province) OR province ~ '[\\r\\n\\t]'
            ) v GROUP BY col
        """),
        ("Integrity", "SELECT rpad(check_name, 32) || rpad(status, 6) || detail FROM meta.check_integrity()"),
    ]
    for title, sql in queries:
        print(f"\n{title}")
        print("-" * len(title))
        out = psql(sql, env).strip()
        print("  " + out.replace("\n", "\n  ") if out else "  none")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Inspect the files and report, load nothing")
    parser.add_argument("--skip-staging", action="store_true",
                        help="Promote what is already staged, for iterating on the SQL")
    args = parser.parse_args()

    env = pg_env()
    started = time.time()

    if not args.skip_staging:
        for layer in LAYERS:
            print(f"\n[{layer['name']}]")
            stage(layer, env, args.dry_run)

    if args.dry_run:
        print("\nDry run. Nothing was written.")
        return 0

    print("\n[promote]")
    out = run(["psql", "-v", "ON_ERROR_STOP=1", "-f", PROMOTE_SQL], env)
    for line in out.splitlines():
        if line.strip() and not line.startswith(("SET", "BEGIN", "COMMIT", "DO")):
            print("  " + line.strip())

    report(env)
    print(f"\nTotal {time.time() - started:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
