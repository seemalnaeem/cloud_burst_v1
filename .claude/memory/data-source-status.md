---
name: data-source-status
description: Live tracker of which vector, raster and external sources are wired versus still pending from the project owner.
metadata:
  type: project
---

Sources arrive incrementally; until confirmed, a route returns 501. All anonymous
([[no-authenticated-sources]]). Update this file whenever a source arrives.

## As of 2026-08-06

| Source | Replacement | Status |
|---|---|---|
| Forecast bands (13 CARI variables) | NOAA GFS 0.25 deg | route decided, no ingest yet |
| Forecast alternate | ECMWF Open Data | secondary, parameter list unconfirmed |
| DEM and slope | Copernicus DEM GLO-30 | route decided, no ingest yet |
| National, provinces, districts, tehsils | owner's `data/vector/admin_final` | **loaded** 2026-08-06 |
| IIOJK districts | inside the district layer, `province_code = 'IJK'` | **loaded**, 22 rows, no separate file needed |
| Historical events (21 rows plus photos) | local CSV plus images | pending |
| Rivers, glacial lakes | owner's local catalog | pending |
| PMD radar, PMD advisories | unchanged, already anonymous | proxy designed, base URL blank |

Loaded counts: 2 national (dissolved from 4), 8 provinces, 188 districts, 553 tehsils. Reload with
`docker compose exec cbd-api python3 /app/ingest/ingest_admin.py`, which is idempotent.

## Open decisions

- `score.*` still keys on `district_name`, which is ambiguous for Poonch. Either move those tables to
  `district_code` or exclude IIOJK from scoring. See [[join-key-discipline]].
- Slope at 5 km versus native resolution, unchanged. See [[slope-is-computed-at-5km]].

## While pending

- Unconfigured routes return **501** naming the missing setting. No sample data, no guessed URLs.
- No placeholder files that look real; fixtures live under `tests/fixtures`.
- Do not implement an ingest against an assumed schema. Inspect first: field names are join keys and
  guessing wastes the work.

**Why:** DATA_SOURCES.md describes the old system in detail, so it is tempting to build against it.
That system used Earth Engine and GeoServer, neither part of this build. It is authoritative for the
science, thresholds, palettes and join keys, not for what will be supplied.

What is needed and in what shape: [LAYER_REQUIREMENTS.md](../../LAYER_REQUIREMENTS.md).

Related: [[no-authenticated-sources]], [[join-key-discipline]]