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

**The one credential in the project, added 2026-08-06 at the owner's request:** `VITE_MAPBOX_TOKEN`,
for the satellite, outdoors, streets, light and dark basemaps. It is admissible because it is not a
data credential: it is a public client token that reaches the browser by design, is restricted by URL
in the Mapbox account, and no model input passes through it. Blank is a supported state, and the
portal falls back to an open basemap and says so rather than breaking. Never put it in
`runtime-config.js` in a repository, and never reuse this exception to justify an authenticated
*data* source.

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