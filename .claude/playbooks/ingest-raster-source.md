# Playbook: ingest a raster source

Owner: `geoprocessing-agent`. Commands in [gdal-toolbox](../skills/gdal-toolbox/SKILL.md).

**1. Fetch.** `fetch_gfs.py --lead 24 --dry-run` then without. NOMADS subsets server side, so a
500 MB global file becomes a few MB. A 404 usually means the cycle has not finished publishing.

**2. Inspect.** `gdalinfo -stats`, plus `grep GRIB_ELEMENT` or `grep SUBDATASET` for multi-band
containers. Check CRS, band identity, nodata, and whether ranges are physical: cumulative
precipitation in metres over 24 h is small, and if it reads 300 the units are mm and everything
downstream is off by a thousand. An extent past 180 E is the GRIB 0-360 convention; warp to a
-180/180 extent or the map splits down the middle.

**3. Extract and convert.** `ingest_raster.py --file <path> --band-key <key> --band-index N
--creation-time <iso> --lead N`. Categorical bands resample `nearest`, never averaged.

**4. Derive at ingest**, not per request:

| Quantity | Formula |
|---|---|
| Hourly rate | `(cur - prev) * 1000 / interval_h`, mask <= 0. At lead 0 use the 0-to-3 delta |
| Wind 850 | `sqrt(u^2 + v^2) * 3.6` |
| RH | clamp 0-100 |
| Temperature | GFS is **Kelvin**, subtract 273.15 |
| Precip type | 4 GFS flags to one code (0/1/3/5/8), frozen wins over rain |

**5. Terrain, once.** Order matters: resample the DEM to 5 km **first**, derive slope from that, then
reduce both to 28 km with a max reducer. Deriving slope at native resolution inflates every mountain
district and both boolean models test slope at 15 degrees. Exact commands in
[[slope-is-computed-at-5km]]. `gdaldem slope` needs `-s 111120`.

**6. Validate, then publish.** `rio cogeo validate /data/tmp/out.tif` and only then move into
`/data/cog`. TiTiler serves a half-written file and it looks like corruption with no error anywhere.

**7. Catalog.** Insert into `wx.raster_catalog` (band, cycle, lead, path, unit, range). The API
resolves layer names to paths through this table, so callers never pass a filesystem path. Then
fetch a tile through the gateway.

**8. Spot check.** `gdallocationinfo -valonly -wgs84 <cog> <lon> <lat>`. Precipitation rate zero or
small positive, CAPE hundreds to low thousands, temperature recognisable. A uniform field usually
means a nodata problem; all zeros usually means the wrong band index.

**9. Log** the run in `meta.ingest_runs`.