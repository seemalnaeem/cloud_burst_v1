---
name: no-authenticated-sources
description: No API keys, tokens, service accounts or OAuth anywhere. Google Earth Engine and GeoServer are both explicitly ruled out.
metadata:
  type: feedback
---

No authenticated platform fetches data: no API key, token, service account, OAuth or login. Two named
exclusions from the owner: **Google Earth Engine** and **GeoServer** (a strict no).

**Why:** stated directly. Both were also liabilities: Earth Engine meant a service account JSON on
disk, a token refresh every 40 minutes, a quota and compute the project did not control; GeoServer
meant a second server at a hard-coded address, the fragility [[auto-ip-requirement]] exists to
prevent.

**Scope: this is about data.** Every value the models read, every raster, every boundary. It is not a
ban on the basemap the map draws underneath them.

**Two admitted credentials, both at the owner's explicit request. Do not add a third without the
same sign off, and do not cite these to justify one.**

1. **`VITE_MAPBOX_TOKEN`** (2026-08-06). Not a data credential: a public client basemap token that
   reaches the browser by design, restricted by URL in the Mapbox account, no model input through it.
   Blank is supported; the portal falls back to an open basemap and says so.

2. **`PMD_USER` / `PMD_PASS`** (2026-08-10). This one **is** a data credential and a real reversal of
   the rule above, so it is documented as an exception rather than pretended otherwise. The owner is
   authorised to use PMD's own early warning portal (`PMD_BASE`, `https://115.186.56.181:12304`), a
   third-party CME/EWS platform (Vue front end, FastAPI back end) that serves the ECMWF, WRF and CFS
   forecast fields the CARI models need, which no anonymous source carries for Pakistan at these
   levels. Mechanics that were reverse engineered from its bundle and confirmed live:
   - `POST /user/login {username,password}` sets an **HttpOnly `ews_jwt` cookie** (SameSite=Strict,
     ~30 day expiry). The JSON token it also returns is a decoy: the API authenticates on the cookie,
     not a bearer header, so header auth returns 401 "invalid jwt string".
   - `GET /api/getModelForecastLatest?data_type=ECMWF&element=CAPE` lists times and each one's
     `file_path`. `GET /static/.../*.tif` returns an EPSG:4326 GeoTIFF (confirmed: CAPE, 720x560,
     0.125 deg, 60-150E / 60N to -10S, 61 steps to +10 days, values 0-5465 J/kg).
   - Self-signed cert: disable TLS verification for this host only.
   - Server side only, `.env` only, never to the browser; cookie and password go on every logger's
     redaction list.

   Still open when this was written: the exact `element`/level codes for the pressure-level fields
   (only CAPE confirmed returning data), and the `data_type` strings for WRF and CFS. See
   [[data-source-status]].

**How to apply:**

- Replacements in [OPEN_DATA_SOURCES.md](../../OPEN_DATA_SOURCES.md): NOAA GFS for forecast bands,
  Copernicus DEM GLO-30 for terrain, OCHA COD-AB for boundaries. All anonymous HTTP or S3.
- Boundaries are ingested into PostGIS and served as MVT by pg_tileserv. No separate map server, ever.
- No credential env var exists for data and none should be added. If a task appears to need one, find
  another source. If an open source starts requiring registration, replace it.

**Two GFS conversions**, both producing a plausible wrong map:

- Temperature is **Kelvin**; thresholds are Celsius and T850 starts at 0, so an unconverted value
  grades 6 on every district.
- Precipitation type is **four boolean flags** (`CRAIN`, `CSNOW`, `CICEP`, `CFRZR`), not one code.
  Map back into the existing code space at ingest; frozen wins over rain, since only code 1 feeds the
  rain conditions.

Related: [[data-source-status]], [[self-contained-project]]