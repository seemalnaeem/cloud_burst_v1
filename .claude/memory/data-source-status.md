---
name: data-source-status
description: Live tracker of which vector, raster and external sources are wired versus still pending from the project owner.
metadata:
  type: project
---

Sources arrive incrementally; until confirmed, a route returns 501. All anonymous
([[no-authenticated-sources]]). Update this file whenever a source arrives.

## As of 2026-08-10

| Source | Replacement | Status |
|---|---|---|
| Forecast, surface fields | PMD portal (authenticated) | **ingesting** 2026-08-10, see below |
| Forecast bands (13 CARI variables) | NOAA GFS 0.25 deg | still needed for pressure levels PMD lacks |
| Forecast alternate | ECMWF Open Data | secondary, parameter list unconfirmed |
| DEM and slope | owner's `data/raster/pakistan_dem.tif`, no Copernicus needed | **loaded** 2026-08-10 |
| National, provinces, districts, tehsils | owner's `data/vector/admin_final` | **loaded** 2026-08-06 |
| IIOJK districts | inside the district layer, `province_code = 'IJK'` | **loaded**, 22 rows, no separate file needed |
| Historical events (21 rows plus photos) | local CSV plus images | pending |
| Rivers, glacial lakes | owner's local catalog | pending |
| PMD radar, PMD advisories | unchanged, already anonymous | proxy designed, base URL blank |

Loaded counts: 2 national (dissolved from 4), 8 provinces, 188 districts, 553 tehsils. Reload with
`docker compose exec cbd-api python3 /app/ingest/ingest_admin.py`, which is idempotent.

## Terrain, loaded 2026-08-10

Source was 1 arc second (about 30 m) WGS 84, 68385 x 48221, already clipped to the national boundary
so 55 percent of the grid is nodata. Not a valid COG as delivered: its pyramid levels were laid out
in the wrong order. Rebuilt with `ingest_terrain.py`, which is idempotent and takes about 11 minutes.

| Band | File | Size | Measured | Purpose |
|---|---|---|---|---|
| `elevation` | `/data/cog/elevation.tif` | 1.19 GB | -107 to 8526 m | the `dem` layer, per pixel CARI |
| `slope` | `/data/cog/slope.tif` | 6.20 GB | 0 to 83.6 deg | the `slope` layer |
| `elevation_5km` | `/data/cog/elevation_5km.tif` | 70 KB | -2 to 6915 m | scoring |
| `slope_5km` | `/data/cog/slope_5km.tif` | 197 KB | 0 to 16.4 deg | scoring |

The last two rows are the reason the split exists, and the numbers make the case better than the
argument does: native slope reaches 83.6 degrees with a mean of 10.6, the 5 km slope reaches 16.4
with a mean of 1.3. Both boolean models test slope at 15 degrees. Score against the wrong one and
almost every mountain district changes. See [[slope-is-computed-at-5km]].

## PMD forecast, multi-model since 2026-08-11

The one authenticated source ([[no-authenticated-sources]]). `scripts/ingest/ingest_pmd.py` is now
contract-driven: it reads every `source: "pmd"` raster layer out of `shared/contracts/layers.json`,
grouped by model, and ingests each element and level. Logs in, pulls each field across every lead,
clips to the national boundary, COGs it, catalogues it by **model, cycle and lead**. `--probe` prints
availability, `--model GRAPES` restricts to one. The panel groups layers by model, one model is
active at a time and drives the slider, and an element served at several pressure levels collapses to
one row with a level selector.

**Schema change (migration `db/migrations/2026-08-11_multimodel_forecast.sql`):** a cycle is keyed on
`(model, creation_time)`, not `creation_time` alone, because several models publish a run at the same
hour. `wx.raster_catalog` carries a `model` column; `band_key` carries the level for pressure fields
(`pmd_rhu_700`). Static terrain rows have model and creation_time NULL and are exempt from the FK.

**What PMD serves this account, probed 2026-08-10/11.** UI label -> data_type: CMA-GFS `GRAPES`,
PMD-WRF `WRFPRS`, PMD-ICON `ICON`, **ECMWF-IFS `D1D`** (not `ECMWF`, which is CAPE-only; D1D is the
real pressure-level product), CMA-GOWFS `GDFS`. Two new elements beyond the first wave: `HOURTPE`
(hourly precip, not cumulative) and `GPH` (geopotential height).

Clean rasters (.tif), ingested:

| model | surface | pressure (.tif) |
|---|---|---|
| GRAPES | CAPE PWAT DPT RHU TEM TPE HOURTPE | RHU 700/500, TEM 850 (also 925/200, DPT/GPH pl) |
| WRFPRS | CAPE DPT TEM TPE HOURTPE | RHU 700/500, TEM 850 (also 1000/925/200) |
| ICON | CAPE DPT RHU TEM TPE HOURTPE | only 300 hPa for RHU/TEM/GPH, no CARI levels |
| D1D (ECMWF-IFS) | TEM HOURTPE | RHU 700/500, TEM 850 (also 925/200) |

Contract scope today is surface fields + the CARI pressure levels **RHU 700/500 and TEM 850**, which
are now clean rasters. So `relative_humidity_pl700`/`_pl500` and `temperature_pl850` inputs CAN be
sourced from PMD after all (via the `level` param on `getModelForecastLatest`).

**Wind and vertical velocity are still NOT ingestable as grids.** The `WIN`/`VVM` element codes return
nothing at any level. The portal's "850 hPa Wind" and "700 hPa Wind & Vertical Velocity" layers are
backed by the **GPH `.json`**, which despite its extension and content-type is **geobuf** (protobuf
GeoJSON): a FeatureCollection of geopotential contour lines with `level-value`, `stroke`,
`stroke-width`, `title` styling. Display geometry, not a u/v or w grid. So `vertical_velocity_pl700`/
`_pl500` and `wind_speed_pl850` still have no clean source at PMD. Options if needed: (a) decode the
geobuf and render contours/barbs as a Mapbox vector overlay (display only, open format), or (b) take
those two scalar fields from NOAA GFS (already wired as `UPSTREAM_GFS_BASE`) for CARI.

Element codes are PMD's own: `RHU` not RH, `TEM`, `DPT`, `PWAT`, `TPE`, `HOURTPE`, `GPH`. Auth is the
`ews_jwt` cookie; FastAPI, `getModelForecastLatest?data_type=&element=&level=` lists times and
`file_path`s, `model?...&suffix=tif|json` returns a single file, `modelTimeList` lists cycles. Tiffs
are EPSG:4326 over a 60-150E Asia domain (clipped to Pakistan on ingest). Cycle time is UTC; the
portal shows PKT.

## Open decisions

- `score.*` still keys on `district_name`, which is ambiguous for Poonch. Either move those tables to
  `district_code` or exclude IIOJK from scoring. See [[join-key-discipline]].
- Slope at 5 km versus native resolution, unchanged. Both grids now exist, so this is a question of
  which one the scoring service reads, not of what has been built. See [[slope-is-computed-at-5km]].
- Display ceilings. `elevation` is capped at 5000 m against data reaching 8526, and `slope` at 45
  degrees against data reaching 84. Everything above renders as one flat colour, which flattens the
  Karakoram. Both numbers come from DATA_SOURCES.md section 10 and are display only, no score
  depends on them, so raising them is a one line change in `bands.json`.
- `slope.tif` is 6.2 GB, five times its own source, because gdaldem writes Float32 and slope has no
  compressible structure. Quantising to whole degrees would cut it by roughly four fifths and cost
  sub-degree precision, which matters only to the per pixel CARI raster, since scoring reads the
  5 km grid. Left accurate rather than small, pending a decision.

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