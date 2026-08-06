# OPEN_DATA_SOURCES.md — no-authentication replacements

> Companion to [DATA_SOURCES.md](DATA_SOURCES.md). That document describes the system this project
> replaces, which pulled its weather and terrain from Google Earth Engine and its boundaries from a
> GeoServer. Neither is used here.
>
> **Project rule: no authenticated platform, no API key, no service account, no OAuth, no GeoServer.**
> Every source below is anonymous HTTP or anonymous S3. If a source starts asking for a login, it is
> replaced rather than worked around.

## Why the old sources are out

| Old source | Problem | Replacement |
|---|---|---|
| Google Earth Engine (ECMWF IFS, SRTM) | service account JSON, OAuth token refresh, quota, per-request compute you do not own | NOAA GFS or ECMWF Open Data, downloaded as GRIB2 and converted to COG locally |
| GeoServer at a fixed address | a separate server to run and keep alive, hard-coded address, ruled out by the project owner | boundary files ingested straight into PostGIS, served as MVT by pg_tileserv |

Both replacements move the data **into this stack**. Once ingested, the portal works with no
internet connection at all, which the old design could never do.

---

## 1. Weather forecast, replacing Earth Engine

### 1.1 Primary: NOAA GFS 0.25 degree

The recommendation. Fully open, no registration, and it carries every CARI variable natively
including CAPE and precipitable water, which not every open model publishes.

- **Cadence:** 4 cycles a day (00, 06, 12, 18 UTC), hourly to 120 h then 3 hourly to 384 h
- **Resolution:** 0.25 degree, roughly 28 km, which is close to the 28 km the old scoring assumed
- **Format:** GRIB2, read natively by GDAL
- **Auth:** none

Three access routes, in order of preference:

```bash
# a. AWS Open Data, anonymous S3. Most reliable, no rate limits.
#    Bucket: noaa-gfs-bdp-pds
aws s3 ls --no-sign-request s3://noaa-gfs-bdp-pds/gfs.20260806/00/atmos/
#    Or straight over HTTPS, no client needed:
curl -O https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20260806/00/atmos/gfs.t00z.pgrb2.0p25.f024

# b. NOMADS GRIB filter. Subsets server side, so you download megabytes not gigabytes.
#    This is the one to use for a scheduled ingest.
curl -o gfs_f024.grib2 "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?\
file=gfs.t00z.pgrb2.0p25.f024&\
lev_surface=on&lev_2_m_above_ground=on&lev_500_mb=on&lev_700_mb=on&lev_850_mb=on&\
var_APCP=on&var_CAPE=on&var_PWAT=on&var_RH=on&var_TMP=on&var_DPT=on&\
var_UGRD=on&var_VGRD=on&var_VVEL=on&var_CRAIN=on&\
subregion=&leftlon=59&rightlon=79&toplat=38&bottomlat=22&\
dir=%2Fgfs.20260806%2F00%2Fatmos"

# c. Google Cloud public mirror, also anonymous
curl -O https://storage.googleapis.com/global-forecast-system/gfs.20260806/00/atmos/gfs.t00z.pgrb2.0p25.f024
```

Note the `subregion` parameters on route b. Clipping to Pakistan at the source turns a 500 MB global
file into a few megabytes, which matters when you are pulling 13 variables across 40 leads.

**Variable mapping.** Every CARI variable, with its GFS GRIB2 name and level:

| CARI key | GFS parameter | Level | Notes |
|---|---|---|---|
| RF | `APCP` | surface | accumulated over the interval, so it still needs differencing between leads |
| CAPE | `CAPE` | `180-0 mb above ground` | this is the most-unstable style CAPE, closest to the old MUCAPE. Surface CAPE also exists and is a different number, pick one and record which |
| TCWV | `PWAT` | entire atmosphere | published directly, no derivation |
| RH700 | `RH` | 700 mb | |
| VV700 | `VVEL` | 700 mb | Pa/s, negative is upward, same convention as before |
| ELEV | see section 2 | | static |
| WS | `UGRD`, `VGRD` | 850 mb | derive with `sqrt(u^2+v^2)*3.6` |
| DP | `DPT` | 2 m above ground | |
| RH500 | `RH` | 500 mb | |
| VV500 | `VVEL` | 500 mb | |
| T2M | `TMP` | 2 m above ground | **Kelvin.** GFS ships Kelvin, the old thresholds are Celsius |
| T850 | `TMP` | 850 mb | **Kelvin** |
| SLOPE | see section 2 | | static |
| precip type | `CRAIN`, `CSNOW`, `CICEP`, `CFRZR` | surface | four separate 0/1 flags, not one code. See the note below |

Two conversions that are not optional:

- **Temperature is Kelvin.** Subtract 273.15 before scoring. `T850` thresholds start at 0 degC, and
  a Kelvin value grades 6 on every district, every time. This is the single most likely way to ship
  a wrong map.
- **Precipitation type is four flags, not one code.** The old system used an ECMWF categorical code
  where 1 meant rain. GFS instead gives four independent booleans. Map them to the existing code
  space at ingest so `palettes.json` and the scoring conditions do not have to change:
  `CRAIN=1` becomes code 1, `CSNOW=1` becomes 5, `CICEP=1` becomes 8, `CFRZR=1` becomes 3, and none
  set becomes 0. That mapping belongs in `backend/app/geo/derive.py` with a test.

Also worth knowing: `APCP` in GFS accumulates over the forecast interval rather than since
initialization. Check which by comparing two consecutive leads before assuming. The rate derivation
in `bands.json` differences consecutive leads either way, but the interval divisor differs.

### 1.2 Secondary: ECMWF Open Data

If you specifically want IFS, which is what the old system used, ECMWF publishes an open subset with
no registration.

- **Endpoint:** `https://data.ecmwf.int/forecasts/`
- **Client:** `pip install ecmwf-opendata`, or plain HTTPS
- **Resolution:** 0.25 degree
- **Auth:** none

```python
from ecmwf.opendata import Client

Client(source="ecmwf").retrieve(
    stream="oper", type="fc", step=24,
    param=["2t", "2d", "tp", "tcwv"],
    target="/data/raw/ifs_f024.grib2",
)
```

**Check the parameter list before committing to this.** The open subset is smaller than the full
catalogue that Earth Engine exposed. Confirm CAPE and pressure-level vertical velocity are present
for the stream you pick. If either is missing, GFS covers everything and is the safer primary.

### 1.3 Optional: ICON, from DWD

Germany's DWD publishes ICON globally with no auth at
`https://opendata.dwd.de/weather/nwp/icon/grib/`. Useful as a third opinion or a fallback when NOAA
has an outage. Same GRIB2 handling.

---

## 2. Terrain, replacing Earth Engine SRTM

SRTM through USGS EarthExplorer needs a login now, and OpenTopography needs an API key. Neither is
acceptable here. Two open alternatives, both better data than SRTM anyway.

### 2.1 Recommended: Copernicus DEM GLO-30

30 m global, newer and cleaner than SRTM, on AWS Open Data with anonymous access.

```bash
# Anonymous S3, no credentials configured anywhere
aws s3 ls --no-sign-request s3://copernicus-dem-30m/

# Or straight HTTPS per tile
curl -O https://copernicus-dem-30m.s3.amazonaws.com/\
Copernicus_DSM_COG_10_N33_00_E073_00_DEM/Copernicus_DSM_COG_10_N33_00_E073_00_DEM.tif
```

Already COG format, so no conversion needed. Pakistan spans roughly N23 to N38 and E60 to E78, so
build a VRT across those tiles and clip once:

```bash
gdalbuildvrt /data/tmp/dem.vrt /data/raw/dem_tiles/*.tif
gdalwarp -te 60 23 78 38 -t_srs EPSG:4326 -r bilinear \
  -co COMPRESS=DEFLATE /data/tmp/dem.vrt /data/tmp/dem_pak.tif
gdal_translate -of COG -co COMPRESS=DEFLATE -co PREDICTOR=2 \
  /data/tmp/dem_pak.tif /data/cog/elevation.tif
```

Then slope, with the scale factor that a geographic DEM requires:

```bash
gdaldem slope -compute_edges -s 111120 /data/cog/elevation.tif /data/tmp/slope.tif
gdal_translate -of COG -co COMPRESS=DEFLATE -co PREDICTOR=3 \
  /data/tmp/slope.tif /data/cog/slope.tif
```

One behavioural difference worth recording: Copernicus GLO-30 is a **surface** model, so it includes
tree canopy and buildings. SRTM is closer to terrain. On forested slopes the elevation will read
slightly higher than the old system produced, which nudges the elevation grade. Not wrong, just
different, and it is the kind of thing that looks like a bug six months later if nobody wrote it
down.

### 2.2 Alternatives

- **NASADEM** on AWS Open Data, a reprocessed SRTM, if you want to stay closer to the original.
- **AWS Terrain Tiles**, `s3://elevation-tiles-prod/`, anonymous, already tiled. Convenient for
  display, less so for analysis because it is quantized into an RGB encoding.

---

## 3. Boundaries, replacing GeoServer

GeoServer is out. Boundaries are downloaded once, ingested into PostGIS, and served as vector tiles
by pg_tileserv, which is already in the stack. No extra server, no fixed address, and the data is
local so it cannot go offline.

### 3.1 Recommended: OCHA Common Operational Datasets, via HDX

The official administrative boundaries humanitarian agencies use for Pakistan. Open licence, no
registration, direct download.

- **Portal:** `https://data.humdata.org/dataset/cod-ab-pak`
- **Levels:** ADM0 national, ADM1 province, ADM2 district, ADM3 tehsil
- **Formats:** Shapefile, GeoJSON, GeoPackage
- **Auth:** none

This is the closest match to what the GeoServer layers held, including the tehsil level that most
open sources stop short of.

### 3.2 Alternatives

| Source | Levels | Licence | Notes |
|---|---|---|---|
| geoBoundaries (`geoboundaries.org`) | ADM0 to ADM3 | CC-BY | has an open API with no key, good for scripted refresh |
| Natural Earth | ADM0, ADM1 | public domain | too coarse for districts, fine for a basemap outline |
| OSM via Geofabrik | varies | ODbL | current, but admin levels are inconsistent and need cleaning |
| GADM | ADM0 to ADM3 | free for academic use only | check the licence before any commercial use |

### 3.3 The part that will bite you

The old join key was `pak_districts.Districts`, the exact string from the GeoServer layer, and it
linked boundaries to scores to alerts. **A new boundary source will spell some districts
differently.** Expect that, do not be surprised by it.

The count is the first signal. The old layers held 167 districts and 554 tehsils. Pakistan has been
creating districts steadily, so a current source may legitimately have more. A different count is
not automatically wrong, but it does mean somebody has to look.

Handle it deliberately:

1. Ingest to staging and compare names against whatever the previous set was.
2. Build an explicit alias table for the differences, do not silently fuzzy match.
3. Run the orphan check in `meta.check_integrity()` before promoting.
4. Record the chosen source and its date in `meta.sources`.

`geo.districts.district_key`, the generated normalized column, plus the trigram index, exist for
exactly this reconciliation. Use them to **find** candidate matches, then confirm each one by hand.
Never join on `district_key`.

### 3.4 IIOJK

The disputed districts came from a local GeoJSON in the old system, using the GAUL schema where
`ADM2_NAME` is blank and `ADM2_CODE` is the key. That file is local data, not a platform, so it
carries over unchanged. If it needs replacing, FAO GAUL is distributed openly.

---

## 4. Radar and advisories

PMD radar frames and press releases were already plain HTTP with no authentication, so they carry
over as they are. They stay behind the gateway proxy for the CORS reason described in
[.claude/playbooks/wire-external-api.md](.claude/playbooks/wire-external-api.md), and they stay
optional: blank configuration means the route returns 501 rather than guessing.

---

## 5. What this changes about the architecture

The old design computed on a remote platform and cached tile URLs. This one ingests, computes
locally, and serves its own tiles.

```
scheduled pull  ->  GRIB2 in /data/raw
                      |
                      v
                 GDAL convert, derive, clip  ->  COG in /data/cog
                      |                              |
                      v                              v
              zonal stats over PostGIS          TiTiler on 3093
              district polygons                      |
                      |                              |
                      v                              v
                 scores in PostGIS  ------>  gateway on 3090  ------>  browser
                      |
                      v
              pg_tileserv on 3092 (MVT boundaries)
```

Consequences worth knowing before you commit:

- **Storage.** 13 variables across 40 leads at 0.25 degree clipped to Pakistan is roughly 2 to 5 GB
  per cycle depending on compression. Four cycles a day. Plan a retention policy from the start,
  and note that the current prune settings only cover the gateway cache, not `/data/cog`.
- **Ingest time.** Download, convert and derive is minutes, not seconds. It belongs in a scheduled
  job, not in a request path.
- **Offline capability.** Once a cycle is ingested the portal is fully functional with no internet.
  The old design could not do that.
- **You own the numbers.** No quota, no token expiry at 3 am, no platform changing a band name
  underneath you.

---

## 6. Configuration

Every one of these is a plain URL with no credential:

```bash
UPSTREAM_GFS_BASE=https://noaa-gfs-bdp-pds.s3.amazonaws.com
UPSTREAM_GFS_FILTER=https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl
UPSTREAM_ECMWF_OPENDATA=https://data.ecmwf.int/forecasts
UPSTREAM_DEM_BASE=https://copernicus-dem-30m.s3.amazonaws.com
UPSTREAM_PMD_RADAR_BASE=
UPSTREAM_PMD_PRESS_BASE=
```

There is deliberately no variable for a key, a token, a secret or a service account anywhere in this
project. If a change appears to need one, that is the signal to find a different source rather than
to add the variable.
