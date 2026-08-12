# DATA_SOURCES.md — Cloud‑Burst Weather Portal Data Catalog

> **Purpose.** A complete, self‑contained catalog of every data source, its URL/path, the
> processing/parsing logic applied to it, and all numeric indicators, thresholds, palettes and
> legends used in the current application. Written so a fresh project can be built from this file
> alone (target stack: **PERN + FastAPI**, with **PostGIS vector tiling** and **GDAL/rasterio COG
> tiling** replacing the current WFS/WMS + Earth‑Engine‑tile approach).
>
> **Scope.** Documents the CURRENT application only:
> - Backend: `backend/app.py` (Flask, ~3,612 lines, `debug=True, port=5000, threaded=True`).
> - Frontend: `frontend/src/App.js` (React + Mapbox GL, ~6k lines).
> - Local data: `data/` (geojson, CSV, event images).
>
> Line references (`app.py:NNN`, `App.js:NNN`) are given as anchors; they may drift slightly.
> A **[⚠ Known Issues](#12-known-discrepancies--data-quality-issues)** section lists every
> code‑vs‑documentation discrepancy discovered during extraction — read it before reimplementing
> any threshold.

---

## Table of contents

1. [Architecture & data flow](#1-architecture--data-flow)
2. [Source A — Earth Engine (ECMWF forecast + SRTM terrain)](#2-source-a--earth-engine-ecmwf-forecast--srtm-terrain)
3. [Source B — GeoServer WFS boundaries](#3-source-b--geoserver-wfs-boundaries)
4. [Source C — IIOJK / Kashmir districts (local GeoJSON)](#4-source-c--iiojk--kashmir-districts-local-geojson)
5. [Source D — PMD radar imagery](#5-source-d--pmd-radar-imagery)
6. [Source E — PMD press‑release prioritized districts (scraped)](#6-source-e--pmd-press-release-prioritized-districts-scraped)
7. [Source F — Historical convective events (CSV + photos)](#7-source-f--historical-convective-events-csv--photos)
8. [Derived raster / tile layers](#8-derived-raster--tile-layers)
9. [Scientific models & thresholds (CARI, Hotspot, Susceptibility, Alerts)](#9-scientific-models--thresholds)
10. [Numeric indicators, palettes & legends reference](#10-numeric-indicators-palettes--legends-reference)
11. [Time / forecast‑cycle model](#11-time--forecast-cycle-model)
12. [Known discrepancies & data‑quality issues](#12-known-discrepancies--data-quality-issues)
13. [Server‑side cache, EE auth & concurrency](#13-server-side-cache-ee-auth--concurrency)
14. [API endpoint inventory](#14-api-endpoint-inventory)
15. [Migration notes → PostGIS + COG](#15-migration-notes--postgis--cog)

---

## 1. Architecture & data flow

```
                         ┌─────────────────────────── EXTERNAL SOURCES ───────────────────────────┐
                         │                                                                          │
  Google Earth Engine ───┤  ECMWF/NRT_FORECAST/IFS/OPER  (weather bands, ~25–28 km)                 │
   (compute + tiles)     │  USGS/SRTMGL1_003             (30 m DEM → slope)                         │
                         │  projects/ms-ndma-25 assets   (Pakistan boundary, districts)             │
                         │                                                                          │
  GeoServer @172.18.1.132┤  hajra_data:pak_national / pak_provinces / pak_districts / pak_tehsils   │
   (WFS GeoJSON)         │                                                                          │
                         │  radar.weather.gov.pk/jbirds  (PMD radar PNG frames + manifest)          │
  PMD (weather.gov.pk) ──┤  weather.gov.pk/nwfc/...       (RAIN-WIND press releases, scraped)       │
                         └──────────────────────────────────────────────────────────────────────────┘
                                                │
                          Flask backend (app.py, :5000) — proxies, caches, and RUNS the science
                          (CARI / hotspot / susceptibility scoring, precip derivation) on EE
                                                │  JSON tile‑URLs + GeoJSON + scalar results
                                                ▼
                          React frontend (App.js) — Mapbox GL renders EE raster tiles + WFS vectors
```

**Key architectural facts**

- The backend is a **thin science + proxy layer**. It does not store raster data locally — every
  weather/terrain raster is a **Google Earth Engine tile URL** produced by `getMapId()` at request
  time. Boundaries come from **GeoServer** (proxied + disk‑cached as gzip). Only two datasets are
  truly local files: the **IIOJK districts GeoJSON** and the **historical events CSV**.
- All heavy meteorology lives in **one ECMWF ImageCollection** and one **SRTM DEM**. Every indicator,
  score and mask is derived from those two sources.
- Results are disk‑cached under `backend/.cache/` keyed by ECMWF cycle (`creation_time`) so they
  auto‑invalidate every ~6 h.

---

## 2. Source A — Earth Engine (ECMWF forecast + SRTM terrain)

Access is via the Python `earthengine-api` (service account, see §13). Everything is server‑side
compute; the browser only ever receives **XYZ tile URLs** (`earthengine.googleapis.com/.../{z}/{x}/{y}`)
and scalar JSON.

### 2.1 Earth Engine assets

| Asset ID | EE type | Provides | How it's filtered/used | app.py |
|---|---|---|---|---|
| `ECMWF/NRT_FORECAST/IFS/OPER` | `ImageCollection` | ECMWF IFS operational NRT forecast (~25–28 km). **Source of ALL meteorology.** | `.sort('creation_time',False).first()` (latest cycle); `.filterMetadata('creation_time','equals',ct)`; `.filterMetadata('forecast_hours','equals',h)`; `.filterDate(end.advance(-9,'day'),end)`; `.aggregate_array('forecast_hours'|'creation_time')` | 192, 235, 265, 293, 1307, 2408, 2839 |
| `projects/ms-ndma-25/assets/pakistan_boundary_offical_gapfilled_simplified` | `FeatureCollection` | Simplified, gap‑filled Pakistan national boundary. Clip + reduceRegion geometry. | `PAKISTAN_GEOMETRY = PAKISTAN_BOUNDARY.geometry(0.1)` (0.1° error margin bounds union cost) | 192‑193 |
| `projects/ms-ndma-25/assets/pak_districts_all` | `FeatureCollection` | 167 Pakistan districts (**matches GeoServer `pak_districts` 1:1**). | `.filter(ee.Filter.eq('Districts', name)).first().geometry()`; province via `.get('province')` | 920, 978‑1008 |
| `USGS/SRTMGL1_003` | `Image` | SRTM 1‑arc‑sec (~30 m) elevation. Base for slope. | `.clip(geom)`; reduce 30 m→5 km→28 km with `Reducer.max()` for scoring; native res for per‑pixel raster/verify | 872, 1175, 1434, 2052 |
| `ee.Terrain.slope(USGS/SRTMGL1_003)` | derived `Image` | Slope in **degrees**. | Same reduction chain as DEM, or native res | 1176, 1438, 2313 |

> **Note on IIOJK:** the district GEE asset carries IIOJK as one coarse polygon; the app deliberately
> ignores it and uses a **local** GeoJSON instead (see §4).

### 2.2 ECMWF bands (raw + derived)

| Band key (raw ECMWF) | Meaning | Unit | Notes / derivation |
|---|---|---|---|
| `total_precipitation_sfc` | Cumulative precipitation since init | m | Base for hourly rate (see §8.1). Zero at hour 0. |
| `total_column_water_vapour_sfc` | Precipitable water / TCWV (a.k.a. PWAT) | mm (kg/m²) | Direct. |
| `relative_humidity_pl700` | Relative humidity @ 700 hPa | % | `.clamp(0,100)` (removes super‑saturation artifacts). |
| `relative_humidity_pl500` | Relative humidity @ 500 hPa | % | `.clamp(0,100)`. |
| `dewpoint_temperature_2m_sfc` | Dewpoint @ 2 m | °C | Direct. |
| `most_unstable_convective_available_potential_energy_sfc` | MU‑CAPE | J/kg | Direct. |
| `temperature_2m_sfc` | Temperature @ 2 m | °C | Direct. |
| `temperature_pl850` | Temperature @ 850 hPa | °C | Direct. |
| `vertical_velocity_pl500` | Vertical velocity @ 500 hPa | Pa/s | Negative = updraft. Reduced with **MIN**. |
| `vertical_velocity_pl700` | Vertical velocity @ 700 hPa | Pa/s | Negative = updraft. Reduced with **MIN**. |
| `u_component_of_wind_pl850` | Zonal wind @ 850 hPa | m/s | Component of derived wind speed. |
| `v_component_of_wind_pl850` | Meridional wind @ 850 hPa | m/s | Component of derived wind speed. |
| `precipitation_type_sfc` | Precip type code | categorical 0–12 | Rain = code 1. See §10.4. |

**Derived (synthetic) bands**

| Synthetic key | Formula | Unit | app.py |
|---|---|---|---|
| `wind_speed_pl850` | `sqrt(u850² + v850²) × 3.6` | km/hr | `_ws850_image()` 1852‑1856 |
| `total_precipitation_sfc_hourly` | `(precip[current] − precip[previous]) × 1000 / interval_h`, masked `> 0` | mm/hr | see §8.1 |

### 2.3 Terrain reduction chain (used by scoring & masks)

To bring 30 m SRTM onto the 28 km ECMWF grid without EE budget blow‑ups:

```
30 m  →  reduceResolution to EPSG:4326 @ 5000 m  (maxPixels=16384, Reducer.max())
5 km  →  reduceResolution to EPSG:4326 @ 28000 m (maxPixels=256,   Reducer.max())
```

`Reducer.max()` is used so a district's **worst‑case** (highest/steepest) cell drives the elevation
and slope conditions. Per‑pixel raster endpoints (CARI raster, DEM/slope tiles) use **native SRTM
resolution** instead (tile pipeline samples per zoom).

### 2.4 Reduce/scale constants

| Constant | Value | Where |
|---|---|---|
| ECMWF `reduceRegion` scale (CARI scalar, district count, hotspot count, susceptibility) | `28000` (28 km) | 1465, 1769, 2083, 3259 |
| `/api/forecast/ecmwf` stats `reduceRegion` scale | `25000` (25 km) | 2501 |
| Verify terrain stats | `scale=300` (elev), `1000` (slope), `28000` (conditions) | 2233‑2257 |
| `maxPixels` | `1e9` (tiles/counts), `1e13` (verify) | throughout |
| `bestEffort` | `True` everywhere | — |
| reduceResolution target proj | `EPSG:4326 .atScale(28000)` | 1432 |
| reduceResolution intermediate proj | `EPSG:4326 .atScale(5000)` | 1433 |
| Geometry simplification (`_simplify_geojson`) | `tolerance_deg=0.05` (~5.5 km); `0.01` for PMD | 3092‑3105 |
| Pakistan boundary error margin | `.geometry(0.1)` | 192 |

> Simplification is required because EE's lazy `.simplify()` still ships full geometry over the wire,
> exceeding EE's **10 MB request payload limit**. Done client‑side with Shapely
> (`shape(...).simplify(tol, preserve_topology=True)`), falling back to the original geometry on error.

---

## 3. Source B — GeoServer WFS boundaries

**Upstream:** `GEOSERVER_URL = http://172.18.1.132:8080/geoserver` (hard‑coded IP), workspace
`hajra_data`, endpoint `{GEOSERVER_URL}/hajra_data/wfs` (`app.py:34, 796`).

### 3.1 Layers (typeNames)

| Frontend id | typeName | Feature count | Default fillColor / stroke / width | Default visible | fillOpacity |
|---|---|---|---|---|---|
| `pak_national` | `hajra_data:pak_national` | 4 | `#00dd00` / `#ffffff` / 2 | **true** | 0.15 |
| `pak_provinces` | `hajra_data:pak_provinces` | 8 | `#4db8ff` / `#ffffff` / 1.5 | false | 0.85 |
| `pak_districts` | `hajra_data:pak_districts` | 167 | `#4dff88` / `#ffffff` / 1 | false | 0.25 |
| `pak_tehsils` | `hajra_data:pak_tehsils` | 554 | `#ffaa44` / `#ffffff` / 0.8 | false | 0.85 |

Defined in `LAYER_DEFS` (`App.js:85‑122`); defaults in `App.js:1063‑1074`.

### 3.2 Exact feature property names (critical for reprojection/joins)

| Layer | Property names (verified) | Consumed as |
|---|---|---|
| `pak_districts` | `country, OBJECTID, division, province, Districts, Population, Shape_Area, Shape_Leng` | `Districts` = name (join key to CARI/EE asset), `province` → matrix selection, `division` = display |
| `pak_provinces` | `OBJECTID, Province, Shape_Area, Shape_Leng` | `Province` = label |
| `pak_tehsils` | `TEHSIL, DISTRICT, OBJECTID, PROVINCE, Area_Sq_Km, SHAPE_Leng, Shape_Area, Shape_Le_1` | `TEHSIL` = label (frontend coalesces `name`→`TEHSIL`) |
| `pak_national` | `OBJECTID, Admin01_Na, Shape_Area, Shape_Leng` | outline only |

> **Join key:** `pak_districts.Districts` (string) is the primary key that links GeoServer polygons →
> EE `pak_districts_all.Districts` → CARI results → alerts. Preserve it exactly (case/spacing) in
> any migration.

### 3.3 Request & processing

- Frontend `buildWFSUrl` params (`App.js:127‑136`): `service=WFS, version=1.0.0, request=GetFeature,
  typeName=<...>, outputFormat=application/json`. Frontend retries 3× with backoff `800*(i+1)` ms.
- Backend `/api/geoserver/wfs` (`app.py:764‑839`): generic pass‑through of all query args to GeoServer
  (`timeout=180`, `Accept-Encoding: gzip`). Rejects non‑JSON upstream with **502**. Re‑gzips and
  returns with `Content-Encoding: gzip`. Districts/tehsils are ~**175 MB** uncompressed (~56 MB after
  the revamped backend's simplification; the legacy GeoServer payload is the large one).
- Cache: prefix `wfs_gz`, key `{'params': sorted(params.items())}`; validated by gzip magic
  `\x1f\x8b` before serving; atomic write; **never pruned**.
- `_load_districts_geojson()` (`app.py:3068‑3089`) reads the same `wfs_gz` cache for server‑side
  district geometry (used by susceptibility, PMD district matching).
- `/api/geoserver/rest/<path>` (`app.py:841‑849`): GeoServer REST proxy, `timeout=10`.

---

## 4. Source C — IIOJK / Kashmir districts (local GeoJSON)

- **File:** `data/IOK_Districts.geojson` (`_IOK_GEOJSON_PATH`, `app.py:931`). ~428 KB, **70 features**.
- **Loader** `_load_iok_districts()` (`app.py:933‑952`): keeps only features where
  `properties.ADM0_NAME == 'Jammu and Kashmir'` → **64** features (rest are India/Pakistan/Aksai Chin).
- **Key:** `IIOJK District <ADM2_CODE>` (`IOK_KEY_PREFIX = 'IIOJK District '`), e.g. `IIOJK District 72785`.
  ADM2_NAME is blank for the disputed area, so the numeric `ADM2_CODE` is the key.
- **GeoJSON properties:** `geometry_t, ADM1_CODE, ADM2_NAME, EXP2_YEAR, DISP_AREA, ADM1_NAME,
  Shape_Leng, STATUS, ADM0_NAME, STR2_YEAR, ADM0_CODE, Shape_Area, ADM2_CODE` (GAUL schema).
- **Endpoint** `/api/iok/districts` (`app.py:1344‑1358`): FeatureCollection where each feature's
  `properties = {district_key, label}` (both = `IIOJK District <code>`).
- **CARI flow:** IIOJK keys short‑circuit to province `Indian_Illegally_Occupied_Jammu_Kashmir`
  (`app.py:1000`), which is in `TERRAIN_PROVINCES` → IIOJK **always scores against the terrain matrix
  (Table 1)**. Geometry inlined to EE as `ee.Geometry` (each ≤ ~57 KB, under the 10 MB cap).

---

## 5. Source D — PMD radar imagery

- **Base:** `PMD_RADAR_BASE = https://radar.weather.gov.pk/jbirds` (`app.py:495`) — image overlays, NOT WMS.
- **Sites:** `{islamabad, karachi}` (`app.py:496`). **Products:** `Surface-R`, `Accumulated-R (12h)`
  (450 km), `CAPPI-R (01km)` (200 km). Headers: `User-Agent: Mozilla/5.0`.

### `/api/pmd/radar` (`app.py:499‑550`)
- Params: `site` (default `islamabad`), `product` (default `Surface-R`), `radius` (optional).
- Fetches manifest `{BASE}/radar-images-{site}.json` (`timeout=30`). Parses:
  - `radarSites[]` → the site object (`center`, `imageBounds`).
  - `radarImages[]` → filtered by `radarSiteId==site` and `product==product` (each has `radius,
    datetime, url`).
- Radius: explicit param → else prefer `'450'` → else `max(radii)`.
- Bounds: `site.imageBounds[radius] = [[northLat, westLon],[southLat, eastLon]]`.
- Newest frame: sort by `datetime`, take last.
- Returns 4 corner coords `[[w,n],[e,n],[e,s],[w,s]]`, plus `path` (latest image url), `frames[]`
  (oldest→newest), `center`, `datetime`.
- Auto‑refreshes every **2 min** while visible (frontend).

### `/api/pmd/radar/image` (`app.py:552‑566`)
- **Why proxied:** PMD image responses omit `Access-Control-Allow-Origin`; a direct cross‑origin
  fetch by Mapbox GL would taint the tile. Proxy adds CORS + `Cache-Control: public, max-age=120`.
- `path` must start with `images/radar/` and contain no `..`. Streams PNG bytes.
- Example: `images/radar/islamabad/068/islamabad_N334057_E0730351_H0591_202608051441_sri_450km.png`.

### Radar legend bins (frontend)
Two 16‑bin legends selected by product — full color/value tables in [§10.5](#105-pmd-radar-legends).

---

## 6. Source E — PMD press‑release prioritized districts (scraped)

`/api/pmd/forecast/districts` (`app.py:655‑761`) — ranks districts named in the latest PMD RAIN‑WIND advisory.

- **Upstream:** listing `https://weather.gov.pk/nwfc/all-press-releases?type=RAIN-WIND`
  (`PMD_PRESS_LIST_URL`), detail `https://weather.gov.pk/nwfc/all-press-releases/{id}?type=RAIN-WIND`.
  `timeout=30`, `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)`.
- **Scrape steps:**
  1. Find newest release id via regex `/nwfc/all-press-releases/(\d+)`, `release_id = max(ids)`.
  2. Parse title + date (`(\d{1,2}\s+[A-Za-z]+,?\s+\d{4})`) from the first card.
  3. Extract advisory prose from `<div ... press_release_content ...>`, strip tags.
  4. `_extract_districts_from_text`: normalize (uppercase, strip non‑alpha), longest‑term‑first
     containment matching against `_load_districts_geojson().Districts`.
- **Lookup tables:** `PMD_TEXT_STOP_PHRASES = ['KHYBER PAKHTUNKHWA','GILGIT BALTISTAN']`;
  `PMD_TEXT_ALIASES` (e.g. `NEELUM VALLEY→Neelam Valley`, `KOHISTAN→[Upper Kohistan, Lower Kohistan,
  Kolai Palas]`, `D G KHAN→Dera Ghazi Khan`, `KARACHI→[Central/East/South/West Karachi]`);
  `PMD_PROVINCE_COLORS` (per‑province hex).
- **Returns:** `{generated_at, source, release_url, release_id, title, issue_date, count, districts[]}`;
  each district = `{district_name, province, division, mentions[], bbox, centroid (shapely
  representative_point), geometry (simplified 0.01°), color}`.
- **Cache:** prefix `pmd_forecast_districts`, key `{release_id}` (auto‑refresh per new release).

---

## 7. Source F — Historical convective events (CSV + photos)

- **CSV:** `data/historical_data/Cloudburst_Historical_Data_Updated.csv` (~2.4 KB, **21 rows**),
  encoding **`latin-1`** (the `Precipitable_Water_kg/m²` header's `²` = byte 0xB2 breaks utf‑8).
- **Header row (verified):**
  `Sr. no, Location_Name, Occurrence, Latitude, Longitude, Rainfall_mm, CAPE_J/kg,
  Relative Humidity_%_700hPa, Precipitable_Water_kg/m², Vertical Velocity_Pa/s_700hpa , Elevation_m, Slope_deg`.
- **`CSV_COLUMN_RENAMES`** (`app.py:42‑48`) — apply on load:

  | Original header | Renamed to |
  |---|---|
  | `Location_Name` | `Location_name` |
  | `CAPE_J/kg` | `Cape_j_kg` |
  | `Relative Humidity_%_700hPa` | `Relative humidity_%` |
  | `Precipitable_Water_kg/m²` (with 0xB2) | `Precipitable_water_mm` |
  | `Vertical Velocity_Pa/s_700hpa ` (trailing spaces) | `Vertical velocity_500hpa ` (trailing space) |

  Pass‑through unchanged: `Rainfall_mm, Elevation_m, Slope_deg, Occurrence, Latitude, Longitude`.
- **Cleaning:** `Cape_j_kg` has thousands separators (`"3,543.75"`) → strip commas → float.
- **Endpoints:**
  - `/api/convective/data` (`app.py:468‑484`): returns **all rows** via `df.to_dict('records')`.
  - `/api/metrics` (`app.py:443‑466`): `intensityTrend` = zip(`Location_name`,`Rainfall_mm`);
    `frequencyByRegion` = means of `Rainfall_mm`, `Cape_j_kg`, `Relative humidity_%`,
    `Precipitable_water_mm`.
- **Per‑event photos:** **frontend‑only** mapping `HISTORIC_EVENTS` (`App.js:27‑49`, 21 events):
  `{location, folder, images[]}` → URL `/<historical_data>/<folder>/<img>`. Folders exist under
  `data/historical_data/` (`1. Pir Baba Buner` … `21. Lower Orakzai`).
- **Frontend detail chart** (`getChartData`, `App.js:3886`): plots `Rainfall_mm` (mm/hr),
  `Cape_j_kg` (J/kg), `Precipitable_water_mm` (kg/m²), `Relative humidity_%` (%, "Rel. Humidity
  700hPa"), `Elevation_m` (m), `Slope_deg` (degree).

---

## 8. Derived raster / tile layers

All of these produce an **EE `getMapId()` XYZ tile URL** (default 256 px tiles) plus metadata JSON.
The frontend adds them to Mapbox GL as `raster` sources.

### 8.1 Hourly precipitation derivation (shared)

`total_precipitation_sfc` is cumulative (m). The hourly **rate** used everywhere:

```
interval_h = max(1, current_lead − previous_lead)
rate_mm_per_hr = (precip[current] − precip[previous]) × 1000 / interval_h      # m→mm, per hour
rate = rate.updateMask(rate > 0)                                              # hide zero/negative
```

- `/api/forecast/ecmwf` uses `_prev_available_lead` (the actual published previous lead) — hardened
  against skipped grid leads.
- `/api/forecast/hotspots` uses the hardcoded `_ecmwf_step_size` (3 h ≤144, else 6 h) — **not** hardened
  (see [⚠](#12-known-discrepancies--data-quality-issues)).
- At lead 0: `previous = 0`, `current = first available > 0` (or 3).

### 8.2 Tile endpoints

| Endpoint | Renders | Vis params | Clip | app.py |
|---|---|---|---|---|
| `/api/forecast/ecmwf` | One ECMWF band as a national raster | `{min,max,palette}` (palette by band, §10) | `PAKISTAN_GEOMETRY` | 2372‑2530 |
| `/api/dem/pakistan` | SRTM elevation | `min=0,max=4000`, palette `['000080','0000ff','00ffff','00ff00','ffff00','ff7f00','ff0000','8b4513']` | Pakistan or `district=` | 851‑915 |
| `/api/slope/pakistan` | SRTM slope (`ee.Terrain.slope`, native 30 m) | `min=0,max=45`, palette `['006837','a6d96a','ffffbf','fdae61','d7191c','67000d']` | Pakistan or `district=` | 2292‑2345 |
| `/api/district/variable_clip` | One ECMWF band clipped to a district | per‑band min/max (`_DISTRICT_VAR_CONFIG`, §10.3) | district geom | 1859‑1925 |
| `/api/district/cari/raster` | **Per‑pixel CARI %** (0–100) clipped to a district | `{min:0,max:100, palette=CARI 7‑class}` step boundaries `[15,30,45,60,75,90]` | district geom (native SRTM) | 1928‑2001 |
| `/api/district/hotspots` | Binary hotspot mask (district) | `{min:0,max:1, palette:['ff0000']}`, `selfMask()` | district geom | 2004‑2107 |
| `/api/forecast/hotspots` | Binary hotspot mask (national) | `{min:0,max:1, palette:['ff0000']}`, `selfMask()` | `PAKISTAN_GEOMETRY` | 2815‑3066 |

- `/api/forecast/ecmwf` also returns `stats:{min,max}` from `reduceRegion(minMax, scale=25000)`.
- `/api/district/hotspots` returns `hotspot_pixel_count` from `reduceRegion(count, scale=28000)`.
- `/api/forecast/hotspots/verify` and `/api/district/verify` return per‑condition pixel counts + a
  final 13‑way AND count (exercise the **hotspot** thresholds).

---

## 9. Scientific models & thresholds

There are **three independent scoring systems**, all derived from the same ECMWF+SRTM inputs. They use
**different thresholds** — do not conflate them.

| System | Style | Output | Used by |
|---|---|---|---|
| **CARI** | Graded 0–6 per variable → weighted sum → % → 7 classes | continuous risk % | `/api/district/cari*`, `/api/alerts`, CARI raster |
| **Hotspot mask** | Strict boolean AND of 13 conditions | binary mask | `/api/forecast/hotspots`, `/api/district/hotspots`, verify |
| **Susceptibility** | Count of 13 (stricter) thresholds where ≥50% of district area passes | integer 0–13 → 5 classes | `/api/forecast/districts/susceptibility`, `/api/forecast/districts/prioritized` |

### 9.1 CARI (Convective Activity Risk Index)

**Score mechanic** (`app.py:1036‑1087`): each variable → integer **0–6** against a 6‑element threshold list.
- Ascending (`'asc'`): `score = first i where value ≤ thresholds[i]`, else 6.
- Descending (`'desc'`, VV bands): `score = first i where value > thresholds[i]`, else 6 (more‑negative = stronger updraft).
- `value is None` → 0.

**Weighting** (`app.py:1070‑1072`):
```
Primary (8, ×1.0):   RF, CAPE, TCWV, RH700, VV700, ELEV, WS, DP
Secondary (5, ×0.75): RH500, VV500, T2M, T850, SLOPE

CAS            = Σ(primary scores) + 0.75 × Σ(secondary scores)
CARI_MAX_SCORE = 8×6 + 5×6×0.75 = 70.5
CARI %         = CAS / 70.5 × 100        (0–100)
```

**Variable → source band / reduction:**

| Key | Band / source | Unit | Reduce |
|---|---|---|---|
| RF | `total_precipitation_sfc` (→ mm/hr, §8.1) | mm/hr | MAX |
| CAPE | `most_unstable_..._energy_sfc` | J/kg | MAX |
| TCWV | `total_column_water_vapour_sfc` | mm | MAX |
| RH700 | `relative_humidity_pl700` (clamp 0–100) | % | MAX |
| VV700 | `vertical_velocity_pl700` | Pa/s | **MIN** |
| ELEV | SRTM DEM | m | MAX |
| WS | `wind_speed_pl850` = √(u²+v²)×3.6 | km/hr | MAX |
| DP | `dewpoint_temperature_2m_sfc` | °C | MAX |
| RH500 | `relative_humidity_pl500` (clamp 0–100) | % | MAX |
| VV500 | `vertical_velocity_pl500` | Pa/s | **MIN** |
| T2M | `temperature_2m_sfc` | °C | MAX |
| T850 | `temperature_pl850` | °C | MAX |
| SLOPE | `ee.Terrain.slope(SRTM)` | degrees | MAX |

**The two threshold matrices** — `TABLE1_THRESHOLDS` = **terrain** ("Complex Terrain & Foothills"),
`TABLE2_THRESHOLDS` = **lowlands** ("Lowlands & Plains") (`app.py:1039‑1068`). Each cell is the 6‑element
threshold list `[t0,t1,t2,t3,t4,t5]`:

| Var | Order | TABLE1 (terrain) | TABLE2 (lowlands) | Differs |
|---|---|---|---|:---:|
| RF | asc | `10,20,40,60,80,100` | `10,20,40,60,80,100` | — |
| **CAPE** | asc | `150,400,1000,1500,2000,2500` | `250,500,1500,2500,4000,5000` | ✅ |
| **TCWV** | asc | `10,20,35,45,50,55` | `20,30,45,60,75,90` | ✅ |
| RH700 | asc | `60,70,80,90,95,98` | `60,70,80,90,95,98` | — |
| VV700 | desc | `0,-0.1,-0.3,-0.8,-1.5,-3.0` | `0,-0.1,-0.3,-0.8,-1.5,-3.0` | — |
| **ELEV** | asc | `300,500,800,1000,2000,3500` | `250,500,750,1000,1250,1500` | ✅ |
| WS | asc | `10,20,30,40,50,70` | `10,20,30,40,50,70` | — |
| **DP** | asc | `2,6,10,14,16,18` | `8,12,16,20,24,28` | ✅ |
| RH500 | asc | `50,60,70,80,90,95` | `50,60,70,80,90,95` | — |
| VV500 | desc | `0,-0.2,-0.5,-1.0,-2.0,-4.0` | `0,-0.2,-0.5,-1.0,-2.0,-4.0` | — |
| **T2M** | asc | `10,15,20,25,28,32` | `15,20,25,30,35,40` | ✅ |
| **T850** | asc | `0,5,10,15,20,24` | `5,10,15,20,25,30` | ✅ |
| SLOPE | asc | `3,8,15,25,35,45` | `3,8,15,25,35,45` | — |

**6 of 13 variables differ**: CAPE, TCWV, ELEV, DP, T2M, T850. Lowlands demands *higher*
CAPE/TCWV/DP/T2M/T850 for the same score; ELEV thresholds are *compressed* (plains rarely exceed 1500 m).

**CARI % → risk class** (`_classify_cari`, `app.py:1090‑1119`):

| idx | Name | Boundary | Hex | Text hex (frontend) |
|---|---|---|---|---|
| 0 | Very Low | ≤ 15 | `#2c7bb6` | `#2c7bb6` |
| 1 | Low | ≤ 30 | `#abd9e9` | `#2f8fbf` |
| 2 | Moderate | ≤ 45 | `#ffffbf` | `#b8860b` |
| 3 | Moderately High | ≤ 60 | `#fdae61` | `#d9822b` |
| 4 | High | ≤ 75 | `#f46d43` | `#e0492a` |
| 5 | Very High | ≤ 90 | `#d7191c` | `#d7191c` |
| 6 | Extreme | > 90 | `#7f0000` | `#7f0000` |

**Primary‑extreme override** (`app.py:1503‑1533`, never downgrades): count primary vars with score ≥ 5.
`≥ 6` → floor class to **5 (Very High)**; `== 5` → floor to **4 (High)**.

**Matrix auto‑selection** `_get_terrain_class(province, district)` (`app.py:1012‑1033`, mirrored `App.js:225`):
- `province ∈ TERRAIN_PROVINCES` → `terrain`. Set = {Azad Kashmir/AJK, Federal Capital/Islamabad,
  Gilgit Baltistan/GB, IIOJK variants, Khyber Pakhtunkhwa/KPK/KP}.
- `province` starts with `punjab` → `terrain` only if district ∈ {Rawalpindi, Jhelum, Attock, Chakwal,
  Murree}, else `lowlands`.
- else → `lowlands` (Sindh, Balochistan, central/southern Punjab).

**Endpoints:**
- `/api/district/cari` — single district; `matrix=` override wins over auto‑detect; returns
  `values, scores, primary_sum, secondary_sum, cas, cas_max(70.5), cari, class_idx, risk_level,
  risk_color, override, classes[]`.
- `/api/district/cari/all` — **requires** `matrix=`; filters districts to that matrix, one
  `reduceRegions(minMax)` in batches of 15; returns FeatureCollection + `class_counts[7]`.
- `/api/district/cari/raster` — per‑pixel CARI image, palette = 7 class hexes.

### 9.2 Hotspot mask (strict, 13 conditions AND'ed)

`/api/forecast/hotspots` + `/api/district/hotspots`. **ACTUAL in‑code thresholds** (`app.py:2874‑2927`,
district `2038‑2072`). All 13 combined with `.And(...)`, then `selfMask()`:

| # | Condition | Operator/value |
|---|---|---|
| 1 | Rainfall = rain type **and** rate | `precip_type == 1` **AND** rate `> 40` mm/hr |
| 2 | CAPE | `> 1000` J/kg |
| 3 | VV700 | `≤ -0.02` Pa/s |
| 4 | VV500 | `≤ -0.05` Pa/s |
| 5 | RH700 | `> 60` % |
| 6 | RH500 | `> 50` % |
| 7 | WS850 | `> 20` km/hr |
| 8 | TCWV / PW | `> 35` mm |
| 9 | T2m | `> 20` °C |
| 10 | Td2m | `> 15` °C |
| 11 | T850 | `> 10` °C |
| 12 | Elevation | `> 1000` m |
| 13 | Slope | `≥ 15`° |

> The JSON `thresholds` block and diagnostic band names report these **actual** values (40, 20). Only
> prose comments claim 60 mm/hr / 40 km/hr — see [⚠](#12-known-discrepancies--data-quality-issues).
> Cache methodology key: `hotspots_v3` / `district_hotspots_v3`.

### 9.3 District susceptibility (count of 13, ≥50% area)

`_compute_district_susceptibility` (`app.py:3128`). Build 13 **binary** condition bands, take the **MEAN**
over each district (fraction of area passing); a condition "passes" if `fraction ≥ 0.5`;
`score = count of passed conditions` (0–13). **Note: rain type and rain rate are SEPARATE conditions
here** (unlike the hotspot mask where they're AND'ed into one).

| # | Key | Condition |
|---|---|---|
| 1 | rain_type | `precipitation_type_sfc == 1` |
| 2 | rain_100mm | rate `≥ 100` mm/hr |
| 3 | cape_1500 | CAPE `> 1500` J/kg |
| 4 | vv700 | VV700 `≤ -0.2` Pa/s |
| 5 | vv500 | VV500 `≤ -0.3` Pa/s |
| 6 | rh700_80 | RH700 `> 80` % |
| 7 | rh500_70 | RH500 `> 70` % |
| 8 | pw_45 | TCWV `> 45` mm |
| 9 | t2m_25c | T2m `> 25` °C |
| 10 | td2m_18c | Td2m `> 18` °C |
| 11 | t850_15c | T850 `> 15` °C |
| 12 | elev_1500m | Elevation `> 1500` m |
| 13 | slope_15deg | Slope `≥ 15`° |

**Score → class** (`app.py:3268‑3316`, 5‑class RdYlBu‑reversed):

| Class | Hex | Score |
|---|---|---|
| Very Low | `#2c7bb6` | 0–2 |
| Low | `#abd9e9` | 3–4 |
| Moderate | `#ffffbf` | 5–6 |
| High | `#fdae61` | 7–8 |
| Very High | `#d7191c` | 9–13 |

> This 5‑class scheme reuses CARI hexes but with **different meanings** (`#fdae61` = "High" here, not
> "Moderately High"). `/api/forecast/districts/prioritized` ranks districts by peak susceptibility
> across leads `[24, 48, 72]` h; internal `district_susc` results are ~190 MB each (full geometries).

### 9.4 Alerts (`/api/alerts`, `app.py:3539`)

- **Trigger:** every district with CARI `class_idx ≥ 4` (High/Very High/Extreme) — driven by full CARI,
  not the hotspot mask.
- **Lead selection:** PKT = UTC+5; target = **tomorrow midday** local; lead = round to 3 h grid,
  snapped to a published lead. Cached per `(creation_time, target_date)` → refreshes daily.
- **Matrix:** loops both `terrain` and `lowlands`, scoring each district under the matrix its
  province/district dictates.
- **Row fields:** `district_name, province, class_idx, risk_level, risk_color, cari`; sorted by
  `(-class_idx, district_name)`. Envelope: `generated_at, creation_time, target_date,
  target_lead_hours, count, alerts[]`.

---

## 10. Numeric indicators, palettes & legends reference

### 10.1 Shared palette (`CONTINUOUS_PALETTE`, `App.js:158`)
```
['#000080','#0000ff','#00ffff','#00ff00','#ffff00','#ff7f00','#ff0000','#ffffff']
```
`makeLabels(min,max,decimals=0)` → 8 evenly spaced ticks, `step=(max-min)/7`.

### 10.2 CRI variable catalog (`CRI_CATEGORIES`, `App.js:276‑444`)

Frontend palettes are hex **without** `#` unless they reuse `CONTINUOUS_PALETTE`.

| Category (accent) | key | label | unit | min | max | palette | paletteTitle |
|---|---|---|---|---|---|---|---|
| **Rainfall** (`#dc2626`) | `total_precipitation_sfc_hourly` | Rainfall (ECMWF) | mm | 0 | 100 | `c6dbef,6baed6,2171b5,00ff00,ffff00,ff7f00,ff0000,7a0177` | Hourly Precipitation (mm) |
| **Moisture** (`#2563eb`) | `total_column_water_vapour_sfc` | PWAT | kg/m² | 0 | 60 | CONTINUOUS | PWAT (kg/m²) |
| | `relative_humidity_pl700` | RH 700 hPa | % | 0 | 100 | CONTINUOUS | Relative Humidity 700hPa (%) |
| | `relative_humidity_pl500` | RH 500 hPa | % | 0 | 100 | CONTINUOUS | Relative Humidity 500hPa (%) |
| | `dewpoint_temperature_2m_sfc` | Dew Point 2m | °C | -10 | 30 | CONTINUOUS | Dewpoint Temperature 2m (°C) |
| **Instability** (`#d97706`) | `most_unstable_..._energy_sfc` | CAPE | J/kg | 0 | 4000 | CONTINUOUS | CAPE (J/kg) |
| | `temperature_2m_sfc` | Temperature 2m | °C | -10 | 50 | CONTINUOUS | Temperature 2m (°C) |
| | `temperature_pl850` | Temperature 850 hPa | °C | -20 | 35 | CONTINUOUS | Temperature 850hPa (°C) |
| **Dynamic Lifting** (`#554570`) | `vertical_velocity_pl500` | Vert. Velocity 500 hPa | Pa/s | -2 | 2 | CONTINUOUS | Vertical Velocity 500hPa (Pa/s) |
| | `vertical_velocity_pl700` | Vert. Velocity 700 hPa | Pa/s | -2 | 2 | CONTINUOUS | Vertical Velocity 700hPa (Pa/s) |
| | `wind_speed_pl850` | Wind Speed 850 hPa | km/hr | 0 | 100 | CONTINUOUS | Wind Speed 850hPa (km/hr) |
| **Orographic** (`#059669`) | `elevation` *(static → `dem/pakistan`)* | Elevation | m | 0 | 5000 | `000080,0000ff,00ffff,00ff00,ffff00,ff7f00,ff0000,8b4513` | Elevation (m) |
| | `slope` *(static → `slope/pakistan`)* | Slope | ° | 0 | 45 | `006837,a6d96a,ffffbf,fdae61,d7191c,67000d` | Slope (°) |

### 10.3 National forecast bands (`forecastBands`, `App.js:842‑943`) — per‑band min/max

Same keys as above plus `precipitation_type_sfc` (categorical, min 0 / max 12). Backend
`_DISTRICT_VAR_CONFIG` (`app.py:1834‑1849`) mirrors these min/max for `variable_clip`.

### 10.4 Precipitation type legend (`precipitation_type_sfc`)

| Code | Label | Legend color (frontend) | Raster palette (backend) |
|---|---|---|---|
| 0 | No precipitation | `#1a1f3a` | `1a1f3a` |
| 1 | **Rain** | `#0052cc` | `0052cc` |
| 3 | Freezing rain | `#00d9ff` | `00d9ff` |
| 5 | Snow | `#ffffff` | `ffffff` |
| 6 | Wet snow | `#87ceeb` | `87ceeb` |
| 7 | Rain & snow mix | `#ff6b9d` | `ff6b9d` |
| 8 | Ice pellets | `#ffd700` | `ffd700` |
| 12 | Freezing drizzle | `#00ff00` | `00ff00` |
| 2,4,9,10,11 | (unused) | — | `1a1f3a` (dark filler) |

Only **code 1 (Rain)** feeds the hotspot/susceptibility rain conditions.

### 10.5 PMD radar legends (`App.js:55‑70`)

**Instantaneous mm/hr** (`PMD_RADAR_LEGEND_MMHR`, Surface‑R & CAPPI‑R), 16 bins `value ≤`:
```
233 #9900CC | 206 #CC0071 | 162 #FF1C00 | 100 #FD8113 | 78 #FFA600 | 61 #FFD800 |
 43 #FCFE4D |  30 #05E033 |  21 #57FA23 |  16 #A7FA84 | 10 #0745F8 |  8 #026DF8 |
  6 #0097FF |   4 #66D4FB |   2 #51F2FF |   1 #A7FFFF
```
**12 h accumulated mm** (`PMD_RADAR_LEGEND_12H_MM`, Accumulated‑R), 16 bins:
```
360 #9900CC | 300 #561238 | 200 #BB4040 | 120 #FF1C00 | 80 #FD8113 | 50 #FFA600 |
 35 #FFD800 |  20 #FCFE4D |  15 #05E033 |  10 #57FA23 |  6 #90EE90 |  4 #0000FF |
2.5 #0097FF | 1.5 #66D4FB | 0.5 #E6E6FA | 0.2 #FFFFFF
```

### 10.6 DEM display palettes (`demPalettes`, `App.js:819‑840`)

| key | colors (hex, no `#`) |
|---|---|
| elevation | `000080,0000ff,00ffff,00ff00,ffff00,ff7f00,ff0000,8b4513` |
| terrain | `1a4d2e,2d7a3a,52b788,95d5b2,f4e8d0,dbb66b,a67c52,6b4423` |
| grayscale | `000000,1a1a1a,333333,666666,999999,cccccc,e6e6e6,ffffff` |
| viridis | `440154,31688e,35b779,fde724,1f9e89,5ec962,52b788,95d5b2` |
| plasma | `0d0887,7e03a8,cc4778,f89540,f0f921,f0f921,f89540,cc4778` |

---

## 11. Time / forecast‑cycle model

- **`creation_time`** = ECMWF cycle timestamp (ms). Latest via
  `col.sort('creation_time',False).first().get('creation_time')`. Cached 5 min (`CREATION_TIME_TTL`).
- **`forecast_hours`** = lead time. Grid: **3 h from 0→144 h, then 6 h from 144→360 h** (`_snap_forecast_hours`).
  Real published leads read via `aggregate_array('forecast_hours')` (cycles publish incrementally / may
  skip a grid point). Fallback grid: `range(0,361,3)`.
- **History:** `HISTORY_HOURS=168` (7 days back), `HISTORY_STEP=6`. Negative leads map to **past
  cycles**: `_resolve_cycle` picks the newest cycle `≤ target_ms` where `target = latest + snapped×3600×1000`.
- **`_resolve_cycle(requested_hours)`** returns `{creation_time, lead_hours, is_historical}`; used by
  nearly every data endpoint.
- **`/api/forecast/ecmwf/meta`** returns `{creation_time, available_forecast_hours[], min_forecast_hours:-168,
  history_step:6, model:'ECMWF IFS OPER'}`. **Call this first** — the whole timeline derives from it.

---

## 12. Known discrepancies & data‑quality issues

> Reproduce the **actual code values** in a new build; the prose/UI values are stale.

1. **Rain threshold is three‑way inconsistent:**
   - Hotspot mask (code): **`> 40` mm/hr**; comments say "60"; UI v3 note says "60".
   - Susceptibility (code): **`≥ 100` mm/hr**.
   - CARI top score bucket: **100** (score 6 at RF > 100).
2. **WS850 threshold:** hotspot code uses **`> 20` km/hr**; comments/UI say "40 km/hr".
3. **Hotspot mask vs susceptibility** use the *same variables* at very different thresholds
   (susceptibility uniformly stricter): CAPE 1000→1500, VV700 **-0.02 → -0.2 (10×)**, VV500 -0.05→-0.3,
   RH700 60→80, RH500 50→70, PW 35→45, T2m 20→25, Td2m 15→18, T850 10→15, ELEV 1000→1500.
4. **UI condition counts disagree:** district panel says "12 conditions", empty‑state hint says "7",
   Verify modal lists "13". Canonical = **13**.
5. **Two precip‑delta implementations:** `/forecast/ecmwf` (published‑lead aware, hardened) vs
   `/forecast/hotspots` (hardcoded 3/6 h step — can hit a null `.first()` on a skipped lead).
6. **Stats pixel size:** `/forecast/ecmwf` uses `scale=25000`; CARI/hotspots use `28000`; both called
   "the ECMWF pixel".
7. **Precip‑type filler:** unused codes 2/4/9/10/11 render as `#1a1f3a` (dark) → visually "no precip".
8. **Susceptibility payload is huge** (~190 MB each — embeds full district geometry). A COG/vector‑tile
   redesign should separate the *score* (small) from the *geometry* (served once).
9. **Rain condition composition differs:** hotspot ANDs `type==1 & rate>40` into one condition;
   susceptibility counts `type==1` and `rate≥100` as two separate conditions.

---

## 13. Server‑side cache, EE auth & concurrency

- **Cache dir:** `backend/.cache/`. Key = `{prefix}_{md5(json.dumps(params,sort_keys=True))}.json`.
  Atomic temp+`os.replace` writes; gzip‑magic validation for `wfs_gz`.
- **Prefixes:** `wfs_gz` (boundaries, never pruned), `dem`, `ecmwf_`, `district_cari`,
  `district_cari_raster`, `district_susc`, `district_prioritized`, `hotspots_`, `pmd_forecast_districts`.
- **TTLs:** cycle re‑check 5 min; tile‑URL caches `max_age=6 h`; prune cutoff **10 days**
  (`_CACHE_PRUNE_PREFIXES = ('ecmwf_','district_cari','district_susc','hotspots_','pmd_forecast')`,
  throttled 30 min — `wfs_gz` and `dem` never pruned).
- **In‑flight de‑dup:** per‑key lock (`_get_inflight_lock`) prevents the ~190 MB susceptibility
  thundering‑herd.
- **Cache endpoints:** `/api/cache/status` (counts by prefix), `/api/cache/clear` (wipes all).
- **EE auth:** service account `hajrasportal@white-setting-437409-q8.iam.gserviceaccount.com`, key file
  `backend/white-setting-437409-q8-5c465f4a7bb2.json` (first of two candidates). Token refresh every
  **40 min** (`EE_REINIT_INTERVAL`, `@before_request`).
- **Concurrency:** `_EE_SEMAPHORE` cap **4** (`ee_bounded` acquires with 45 s timeout → 503).
  `ee_retry` = 3 attempts, exp backoff+jitter on transient EE errors.
- **Upstream timeouts:** GeoServer WFS 180 s, GeoServer REST 10 s, PMD radar 30 s, PMD press 30 s.

**External hosts contacted:**

| Host | Purpose |
|---|---|
| `http://172.18.1.132:8080/geoserver` | GeoServer WFS + REST boundaries |
| `https://radar.weather.gov.pk/jbirds` | PMD radar manifest + PNG frames |
| `https://weather.gov.pk/nwfc/all-press-releases` | PMD RAIN‑WIND press releases (scraped) |
| `earthengine.googleapis.com` + Google OAuth | ECMWF/SRTM compute & tiles |

---

## 14. API endpoint inventory

| Route (GET unless noted) | Source(s) | Returns |
|---|---|---|
| `/api/health` | — | `{status}` |
| `/api/forecast/ecmwf/meta` | EE ECMWF | cycle + available leads (**call first**) |
| `/api/forecast/ecmwf?band&forecast_hours&min&max&palette` | EE ECMWF | raster `{tileUrl, stats, creation_time}` |
| `/api/dem/pakistan?min&max&palette&district` | EE SRTM | raster `{tileUrl,min,max}` |
| `/api/slope/pakistan?min&max&palette&district` | EE SRTM slope | raster `{tileUrl,min,max}` |
| `/api/district/variable_clip?district&band&forecast_hours` | EE ECMWF | district‑clipped raster |
| `/api/district/cari?district&forecast_hours&matrix` | EE + CARI | scalar CARI result |
| `/api/district/cari/all?matrix&forecast_hours` | EE + CARI | FeatureCollection + `class_counts` |
| `/api/district/cari/raster?district&forecast_hours&matrix` | EE + CARI | per‑pixel CARI raster |
| `/api/district/hotspots?district&forecast_hours` | EE + hotspot mask | mask raster + `hotspot_pixel_count` |
| `/api/forecast/hotspots?forecast_hours` | EE + hotspot mask | national mask raster |
| `/api/forecast/hotspots/verify?forecast_hours` | EE + hotspot | per‑condition counts |
| `/api/district/verify?district&forecast_hours` | EE + hotspot | per‑condition counts |
| `/api/forecast/districts/susceptibility?forecast_hours` | EE + susceptibility | FeatureCollection (~190 MB) |
| `/api/forecast/districts/prioritized?hours&top` | susceptibility (leads 24/48/72) | ranked districts |
| `/api/alerts` | EE + CARI | tomorrow's High+ districts |
| `/api/iok/districts` | `data/IOK_Districts.geojson` | Kashmir FeatureCollection |
| `/api/geoserver/wfs?typeName…` | GeoServer | gzip GeoJSON (boundaries) |
| `/api/geoserver/rest/<path>` | GeoServer REST | JSON |
| `/api/pmd/radar?site&product&radius` | PMD radar | overlay metadata + frames |
| `/api/pmd/radar/image?path` | PMD radar | proxied PNG |
| `/api/pmd/forecast/districts` | PMD press releases | scraped priority districts |
| `/api/convective/data` | `Cloudburst_Historical_Data_Updated.csv` | all event rows |
| `/api/metrics` | same CSV | aggregate metrics |
| `/api/cache/status`, `/api/cache/clear` | cache dir | cache mgmt |

---

## 15. Migration notes → PostGIS + COG

Guidance for the new PERN + FastAPI + PostGIS/GDAL/rasterio build. This is orientation, not a
prescription.

### 15.1 Vector data → PostGIS + MVT tiles

| Current | New approach |
|---|---|
| GeoServer WFS `pak_national/provinces/districts/tehsils` (gzip GeoJSON, ~175 MB) | Ingest into PostGIS tables (`ogr2ogr … PG:`), **preserve `Districts`, `province`, `division`, `Province`, `TEHSIL` columns verbatim** (they are join keys). Serve as MVT via `ST_AsMVT` / **pg_tileserv** or **Martin**. Add `ST_Simplify`ed generalization columns per zoom to kill the 175 MB payload. |
| `data/IOK_Districts.geojson` (64 J&K features) | PostGIS table keyed `district_key = 'IIOJK District '||ADM2_CODE`; tag `province='Indian_Illegally_Occupied_Jammu_Kashmir'` so CARI routes it to the terrain matrix. |
| Historical events CSV | PostGIS point table (lat/lon → `geometry(Point,4326)`); keep renamed columns; store event photo paths. |

### 15.2 Raster data → COG + tile server

The weather/terrain rasters currently come from **Google Earth Engine tiles computed on demand**. Two
paths:

- **Keep EE** for compute and just cache the tile URLs (least work), **or**
- **Ingest natively** (the PostGIS/COG goal):
  - **ECMWF IFS**: pull the source GRIB/NetCDF per cycle, convert each band/lead to **COG**
    (`gdal_translate -of COG` or `rio cogeo create`), serve with **TiTiler**/rio‑tiler. Reproduce the
    **hourly precip derivation** (§8.1) and **`wind_speed_pl850 = √(u²+v²)×3.6`** at ingest.
  - **SRTM DEM**: one‑time COG; derive **slope (degrees)** with `gdaldem slope` → COG.
  - Reimplement CARI / hotspot / susceptibility as **numpy/rasterio zonal stats** over district
    polygons (PostGIS `ST_SummaryStats` on raster, or `rasterstats`). Use the §9 thresholds — **the
    code values in §12, not the comments.**

### 15.3 Things to get exactly right

- **Join key** `pak_districts.Districts` must match across boundary table, EE/COG zonal stats, CARI
  output, and alerts (case + spacing).
- **Reduction semantics:** elevation/slope use **max** over the 28 km cell; VV bands use **min**; all
  others **max** (§9.1). Zonal‑stats reducers must match or scores will drift.
- **Matrix auto‑selection** (§9.1) and **IIOJK → terrain** are business rules, not data — port them.
- **Precip is cumulative** — always difference consecutive leads before using as a rate.
- **Palettes/legends** (§10) are the visual contract; keep the CARI 7‑class and susceptibility 5‑class
  schemes distinct even though they share hexes.
- **Separate score from geometry** in the susceptibility/prioritized responses to avoid the 190 MB payload.

---

*Generated from `backend/app.py` and `frontend/src/App.js`. Line anchors reflect the state at
extraction time; the [⚠ Known Issues](#12-known-discrepancies--data-quality-issues) section is the
authoritative source for any code‑vs‑comment conflict.*
