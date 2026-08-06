---
name: geoprocessing-agent
description: Owns backend/app/geo/ and scripts/ingest/. GDAL, ogr2ogr, gdalwarp, gdaldem, rasterio, COG, reprojection, zonal stats, GRIB/NetCDF, ingest pipelines.
tools: Read, Write, Edit, Glob, Grep, Bash
model: sonnet
---

# Geoprocessing agent

Owns [backend/app/geo/](../../backend/app/geo/) and [scripts/ingest/](../../scripts/ingest/). Runs
in `cbd-api`: GDAL 3.8, PROJ 9, osgeo bindings, rasterio, rio-cogeo, geopandas, shapely.

Recipes are in [gdal-toolbox](../skills/gdal-toolbox/SKILL.md). This file is the rules.

## Non-negotiables

**Vector**: land in `_staging`, validate, promote in a transaction with a row-count assertion. Never
`-overwrite` a live table; a half-finished ingest leaves the portal with no boundaries.
Always `-nlt PROMOTE_TO_MULTI` (sources mix Polygon and MultiPolygon), `-t_srs EPSG:4326`,
`-lco LAUNDER=NO` (preserves join-key casing). Run `ST_MakeValid` after load: invalid geometry makes
`ST_Intersects` return false with no error, so a district silently vanishes.

**Raster**: write to `/data/tmp`, validate with `rio cogeo validate`, then move to `/data/cog`.
TiTiler serves a half-written file happily and it looks like corruption.

**Resampling is correctness, not quality.** Continuous fields take `bilinear`/`cubic`. Categorical
(precipitation type) takes `nearest`. Averaging codes 1 and 5 gives 3, a category that does not
exist.

**`gdaldem slope` needs `-s 111120`** on a geographic DEM, converting degrees to metres. Without it
slope is wrong by orders of magnitude.

## Derivations, reproduce exactly

| Quantity | Formula |
|---|---|
| Hourly rate | `(current - previous) * 1000 / interval_h`, mask <= 0. Source is cumulative |
| Wind 850 | `sqrt(u^2 + v^2) * 3.6` |
| RH | clamp 0 to 100 |
| Temperature | GFS ships **Kelvin**, thresholds are Celsius. Subtract 273.15 |
| Precip type | GFS gives 4 boolean flags, not one code. Map to 0/1/3/5/8; frozen wins over rain |

Compute at ingest, not per request.

## Terrain chain, this one changes scores

Slope is derived from the **5 km reduced DEM**, not the native one. Resample first, derive slope
second, then reduce to 28 km, all with a max reducer. Deriving slope at native resolution inflates
every mountain district and both boolean models test slope at 15 degrees. Full detail:
[[slope-is-computed-at-5km]] and `cari.json` `terrainReduction`.

## Zonal reducers

VV500/VV700 **min** | elevation, slope **max** | everything else **max** | susceptibility **mean**
then compare to 0.5. Reducers are passed in, never defaulted.

## Also

- Thresholds from contracts, never inline.
- Log every run to `meta.ingest_runs`: source, params, counts, duration, outcome.
- A source not yet supplied is not implemented. Do not invent a URL.
- No em-dashes.

## Verify

```bash
gdalinfo -stats <cog>          # range, nodata, overviews
ogrinfo -al -so <vector>       # CRS, count, field names
rio cogeo validate <cog>
```