---
name: gdal-toolbox
description: GDAL, OGR and ogr2ogr recipes. Use when converting, reprojecting, inspecting or tiling vector and raster data, creating COGs, loading PostGIS, handling GRIB or NetCDF, computing slope. Triggers on gdal, ogr2ogr, gdalwarp, gdal_translate, gdaldem, rasterio, COG, reproject, GRIB, NetCDF, shapefile.
---

# GDAL toolbox

Runs in `cbd-api`: GDAL 3.8, PROJ 9, osgeo bindings, rasterio, rio-cogeo, geopandas.

## Inspect first, always

Half of all ingest bugs are a file that is not what its name says.

```bash
ogrinfo -al -so file.geojson         # CRS, count, field names and types
gdalinfo -stats file.tif             # CRS, size, bands, nodata, min/max
gdalinfo file.nc | grep SUBDATASET
gdalinfo file.grib2 | grep -E 'Band |GRIB_ELEMENT'
```

Check: CRS as expected, nodata declared, ranges physical, field names matching the join keys.

## Vector into PostGIS

```bash
ogr2ogr -f PostgreSQL \
  PG:"host=cbd-db port=5545 dbname=cari user=cbd_user password=$POSTGRES_PASSWORD" \
  /data/raw/districts.geojson \
  -nln geo.districts_staging -nlt PROMOTE_TO_MULTI -t_srs EPSG:4326 \
  -lco GEOMETRY_NAME=geom -lco FID=id -lco SPATIAL_INDEX=GIST \
  -lco LAUNDER=NO -lco PRECISION=NO -overwrite -progress
```

| Flag | Why |
|---|---|
| `-nln *_staging` | promote in a transaction; never `-overwrite` a live table |
| `-nlt PROMOTE_TO_MULTI` | sources mix Polygon and MultiPolygon, PostGIS rejects mixed |
| `-lco LAUNDER=NO` | preserves join-key casing (`Districts`, `TEHSIL`) |
| `-lco PRECISION=NO` | avoids overflow on odd source field widths |

Also useful: `-where "ADM0_NAME = 'Jammu and Kashmir'"` to filter during load, `-simplify 0.01` to
generalize (degrees, so 0.01 is ~1.1 km).

## Raster to COG

```bash
gdal_translate -of COG -co COMPRESS=DEFLATE -co PREDICTOR=3 \
  -co BLOCKSIZE=512 -co OVERVIEWS=AUTO -co NUM_THREADS=ALL_CPUS \
  in.tif /data/tmp/out.tif && mv /data/tmp/out.tif /data/cog/out.tif
rio cogeo validate /data/cog/out.tif
```

`PREDICTOR=3` float, `2` integer; backwards makes files bigger. Write to `/data/tmp` and move last:
TiTiler serves a half-written file and it looks like corruption.

## Resampling is correctness, not quality

Continuous fields (precipitation, temperature, CAPE, elevation): `bilinear` or `cubic`. Categorical
(precipitation type): **`nearest`**. Overviews: `average`, or `max` for a mask where any hit matters.

Averaging codes 1 and 5 gives 3, a category that does not exist. This produces a plausible wrong map.

## Terrain

```bash
gdaldem slope -compute_edges -s 111120 dem.tif slope.tif    # degrees
```

`-s 111120` converts degrees to metres for a geographic DEM; without it slope is wrong by orders of
magnitude. `-compute_edges` stops tile borders returning nodata.

**For scoring, slope derives from the 5 km DEM, not native.** Resample first, derive second.
[[slope-is-computed-at-5km]]

## Clip and band math

```bash
gdalwarp -cutline districts.geojson -crop_to_cutline -dstnodata -9999 in.tif out.tif

# cumulative precip to hourly rate: metres to mm over 3 h
gdal_calc.py -A t024.tif -B t021.tif --outfile=rate.tif \
  --calc="((A-B)*1000/3)*((A-B)>0)" --NoDataValue=0
```

Anything more complex goes to rasterio in `backend/app/geo/` where it can be tested.

## Python

```python
from osgeo import gdal
gdal.UseExceptions()   # first line, always
```

Without it GDAL returns `None` on failure and the error surfaces later as an unrelated
`AttributeError`.

## Common failures

| Symptom | Cause |
|---|---|
| `PROJ: proj_create_from_database` | `PROJ_LIB` unset |
| Everything nodata after a warp | source nodata undeclared, add `-srcnodata` |
| Mixed geometry rejected | missing `-nlt PROMOTE_TO_MULTI` |
| Field names lowercased | missing `-lco LAUNDER=NO`, breaks join keys |
| Slope absurdly large | missing `-s 111120` |
| COG validation fails | rebuild with `-co OVERVIEWS=AUTO` |
| `ST_Intersects` silently empty | invalid geometry, run `ST_MakeValid` |
| Map split at the antimeridian | GRIB 0-360 longitude, warp to a -180/180 extent |
| Categories that should not exist | averaged a categorical raster, use `nearest` |