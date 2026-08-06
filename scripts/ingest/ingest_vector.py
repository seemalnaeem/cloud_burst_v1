#!/usr/bin/env python3
"""Ingest a vector source into PostGIS.

Runs inside cbd-api, which has GDAL and the osgeo bindings.

    docker compose exec cbd-api python3 /app/ingest/ingest_vector.py \
        --file /data/raw/pak_districts.geojson \
        --target districts \
        --min-features 100

Follows .claude/playbooks/ingest-vector-source.md: inspect, stage, validate,
promote in a transaction, generalize, verify the join key.
"""

from __future__ import annotations

import argparse
import sys
import time

sys.path.insert(0, "/app")

from app.config import settings  # noqa: E402
from app.geo.gdal_tools import inspect_vector, ogr2ogr_to_postgis  # noqa: E402

# The four administrative layers are NOT handled here. They have their own
# script, scripts/ingest/ingest_admin.py, because they need province name
# reconciliation across three different spellings, per record corrections, code
# generation and a tehsil to district match that no generic column mapping can
# express. Pointing this script at them would load them with the wrong field
# names and no keys.
ADMIN_TARGETS = {"districts", "provinces", "tehsils", "national", "iiojk"}

# Column mapping per target. Source names keep their original casing because
# several of them are join keys, so they are quoted here exactly as they appear.
# ogr2ogr lower cases identifiers on load, so a mixed case source column arrives
# in staging already folded.
TARGETS: dict[str, dict] = {
    # Awaiting delivery: historic events, rivers, glacial lakes. Add each one
    # here once its source file exists, following the shape used by the admin
    # ingest: inspect, stage, validate, promote in a transaction.
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--layer", default=None, help="Source layer name for multi layer files")
    parser.add_argument("--min-features", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true", help="Inspect only, do not load")
    args = parser.parse_args()

    if args.target in ADMIN_TARGETS:
        print(
            f"'{args.target}' is an administrative layer. Use:\n\n"
            "    docker compose exec cbd-api python3 /app/ingest/ingest_admin.py\n\n"
            "which loads national, provinces, districts and tehsils together, because "
            "each one depends on the one above it.",
            file=sys.stderr,
        )
        return 1

    if args.target not in TARGETS:
        known = ", ".join(sorted(TARGETS)) or "none configured yet"
        print(f"Unknown target '{args.target}'. Known targets: {known}", file=sys.stderr)
        return 1

    spec = TARGETS[args.target]
    started = time.time()

    # 1. Inspect. Half of all ingest failures are a file that is not what its
    # name says it is.
    info = inspect_vector(args.file, args.layer)
    print(f"file:      {info.path}")
    print(f"driver:    {info.driver}")
    print(f"layer:     {info.layer}")
    print(f"crs:       {info.crs}")
    print(f"features:  {info.feature_count}")
    print(f"geometry:  {info.geometry_type}")
    print(f"fields:    {', '.join(info.fields)}")

    expected = args.min_features or spec.get("expected")
    if expected and info.feature_count < expected:
        print(
            f"\nRefusing to continue. Found {info.feature_count} features, expected at least "
            f"{expected}. Replacing a full boundary set with a partial one is worse than not "
            "loading at all.",
            file=sys.stderr,
        )
        return 1

    missing = [src.strip('"') for src, _ in spec["columns"] if src.strip('"') not in info.fields]
    if missing:
        print(
            f"\nSource is missing expected fields: {missing}\n"
            "These are join keys, so a rename here breaks scoring silently. "
            "Check the source or update TARGETS in this script.",
            file=sys.stderr,
        )
        return 1

    if args.dry_run:
        print("\nDry run, nothing loaded.")
        return 0

    # 2. Stage.
    dsn = _pg_dsn()
    print(f"\nLoading into {spec['staging']}...")
    ogr2ogr_to_postgis(
        args.file,
        dsn,
        spec["staging"],
        source_layer=args.layer,
        where=spec.get("where"),
    )

    # 3. Promote and generalize. The SQL is emitted rather than executed so it
    # can be reviewed before a truncate runs against a live table.
    print("\nStaging loaded. Promote with:\n")
    print(_promote_sql(spec))
    print(f"\nInspection and staging took {time.time() - started:.1f}s")
    return 0


def _pg_dsn() -> str:
    url = settings.asyncpg_dsn.replace("postgresql://", "")
    creds, hostpart = url.split("@", 1)
    user, password = creds.split(":", 1)
    hostport, dbname = hostpart.split("/", 1)
    host, port = hostport.split(":", 1)
    return f"host={host} port={port} dbname={dbname} user={user} password={password}"


def _promote_sql(spec: dict) -> str:
    src_cols = ", ".join(src for src, _ in spec["columns"])
    dst_cols = ", ".join(dst for _, dst in spec["columns"])
    minimum = spec.get("expected", 1)

    return f"""BEGIN;

-- Repair geometry before it reaches the live table. An invalid polygon makes
-- ST_Intersects return false with no error, so a district silently vanishes
-- from every result.
UPDATE {spec['staging']} SET geom = ST_MakeValid(geom) WHERE NOT ST_IsValid(geom);
DELETE FROM {spec['staging']} WHERE geom IS NULL;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM {spec['staging']};
  IF n < {minimum} THEN
    RAISE EXCEPTION 'Staging has % rows, expected at least {minimum}. Aborting.', n;
  END IF;
END $$;

TRUNCATE {spec['table']};
INSERT INTO {spec['table']} ({dst_cols}, geom)
SELECT {src_cols}, ST_Multi(geom) FROM {spec['staging']};

COMMIT;

SELECT geo.rebuild_generalized();
SELECT * FROM meta.check_integrity();
"""


if __name__ == "__main__":
    raise SystemExit(main())
