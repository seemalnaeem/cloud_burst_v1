---
name: backend-agent
description: Owns backend/app/ except geo/. FastAPI routers, schemas, CARI / hotspot / susceptibility models, services. Use for API contracts and the science layer.
tools: Read, Write, Edit, Glob, Grep, Bash
model: sonnet
---

# Backend agent

Owns [backend/app/](../../backend/app/) except `app/geo/`, which belongs to `geoprocessing-agent`.
FastAPI on 3091, Python 3.11, image ships GDAL 3.8, rasterio, geopandas, asyncpg.

## Three models, different thresholds, never reconcile them

| Model | Mechanic | Output |
|---|---|---|
| CARI | 13 vars graded 0-6, weighted (8 primary x1.0, 5 secondary x0.75), max 70.5 | percent, 7 classes |
| Hotspot | 13 conditions AND'ed | binary mask |
| Susceptibility | count of 13 stricter conditions where mean of binary raster >= 0.5 | 0-13, 5 classes |

Every number is in [shared/contracts/](../../shared/contracts/) via `app/shared/contracts.py`.
Typing `70.5`, `0.75` or `-0.02` into a Python file is a defect.

## Facts that produce wrong numbers silently

- Precipitation is **cumulative**; difference consecutive leads, mask non-positive.
- Vertical velocity reduces with **min** (negative = updraft). Elevation and slope with **max**.
- CARI order is `asc` except VV700/VV500 which are `desc`.
- Primary-extreme override raises a class, never lowers.
- `district_name` is an exact-string join key. Never normalize in place.
- Slope is derived from the **5 km** DEM, not native. See [[slope-is-computed-at-5km]].
- At lead 0 use the 0-to-3 delta. See [[legacy-precip-lead-zero]].
- Where old code and old comments disagreed, code wins. Contracts already encode code values.

## Layout

```
main.py  config.py
routers/   thin: validate, call service, return schema. No numpy.
services/  orchestration: resolve cycle, fetch, compute, cache
models/    cari, hotspot, susceptibility  (pure functions over reduced values)
shared/    contracts, errors, logging, timeutil, cache, validation
db/        asyncpg pool, repositories
geo/       import only, owned elsewhere
```

## Rules

- Async throughout; heavy raster work via `run_in_threadpool`, bounded by `MAX_CONCURRENT_JOBS`.
- Forecast time math lives once, in `shared/timeutil.py`. The lead grid is 3h to 144 then 6h to 360,
  cycles skip grid points, negative leads mean past cycles.
- Return scores keyed by `district_name`, never geometry. The old equivalent hit 190 MB.
- Unconfigured upstream returns **501** naming the setting.
- No em-dashes.

## Done means

```bash
docker compose exec cbd-api python3 -m pytest -q && ruff check app
```