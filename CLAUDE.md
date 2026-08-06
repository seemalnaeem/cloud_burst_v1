# CLAUDE.md - Cloud Burst Dev

A cloudburst risk portal for Pakistan. Ingests forecast rasters and administrative boundaries, runs
three scoring models (CARI, hotspot mask, susceptibility), renders them on a web map with legends,
alerts and district drill-downs.

A rebuild: the old system was a 3,600 line Flask file on Google Earth Engine plus a 6,000 line React
file on GeoServer. Both platforms are ruled out here.

## Source documents at the root

| File | Authority for |
|---|---|
| [DATA_SOURCES.md](DATA_SOURCES.md) | the science: sources, thresholds, palettes, endpoints. Section 9 the models, **section 12 the known discrepancies** (code values win over comments) |
| [COLOR_SCHEMES.md](COLOR_SCHEMES.md) | UI theme, every `--cb-*` token in light and dark |
| [OPEN_DATA_SOURCES.md](OPEN_DATA_SOURCES.md) | where data comes from now, all anonymous |
| [LAYER_REQUIREMENTS.md](LAYER_REQUIREMENTS.md) | what layers are needed and in what shape |
| `app.py` | the legacy implementation, kept for reference. Read before changing any calculation |

Do not restate their numbers as literals; load from [shared/contracts/](shared/contracts/).

## Stack

| Tier | Technology | Service | Port |
|---|---|---|---|
| Database | PostgreSQL 16 + PostGIS 3.4, database `cari` | `cbd-db` | 5545 |
| Middleware | Node 20 + Express 4 gateway | `cbd-gateway` | 3090 |
| Backend | Python 3.11 + FastAPI + GDAL 3.8 + rasterio | `cbd-api` | 3091 |
| Vector tiles | pg_tileserv | `cbd-tiles` | 3092 |
| Raster tiles | TiTiler | `cbd-raster` | 3093 |
| Frontend | Vite 5 + React 18 + Tailwind 4 + react-icons | `cbd-web` | 4090 |

One Compose project, `cloud-burst-dev`. Container ports match host ports.

## Hard rules

Full reasoning in [.claude/guardrails/](.claude/guardrails/).

1. Database `cari`, user `cbd_user`, port **5545** inside and out. Never 5432.
2. Backend **3090-3099**, frontend **4090-4099**.
3. **No IP addresses anywhere.** Services by name, browser derives the host at runtime.
4. **No authenticated sources.** Earth Engine and GeoServer ruled out, no credential variable exists.
5. Icons from **react-icons** only. Lucide banned.
6. Tailwind 4 via the Vite plugin. No PostCSS config, no CSS-in-JS.
7. **Write it once.** Check `shared/`, the tier's `lib` or `shared` before adding a helper.
8. **No em-dashes** anywhere.
9. Self-contained. Nothing from any other project on this machine.

## Facts that produce wrong numbers silently

- Precipitation is cumulative; difference consecutive leads.
- Vertical velocity reduces with **min**, not max.
- Slope derives from the **5 km** DEM, not native.
- GFS temperature is **Kelvin**; thresholds are Celsius.
- GFS precipitation type is 4 flags, not 1 code.
- At lead 0 the rain rate needs the 0-to-3 delta.
- `district_name` is an exact-string join key, never normalized.
- The three models disagree on purpose.

## Layout

```
.claude/            agents, skills, playbooks, guardrails, memory, commands
shared/contracts/   single source of truth JSON for all three tiers
db/ backend/ middleware/ frontend/ scripts/ data/
```

## Agents

`frontend-agent` owns `frontend/` | `middleware-agent` owns `middleware/` | `backend-agent` owns
`backend/app/` except `geo/` | `db-agent` owns `db/` and SQL | `geoprocessing-agent` owns
`backend/app/geo/` and `scripts/ingest/`.

Any change to `shared/contracts/` touches all five. Announce it.

## Run it

```bash
cp .env.example .env && docker compose up -d --build
./scripts/stack.sh check
```

Open `http://<host-ip>:4090`. The host IP can change freely; the app follows.

## Data status

Sources arrive incrementally. Unconfigured routes return **501** naming the missing setting rather
than guessing. Tracker: [.claude/memory/data-source-status.md](.claude/memory/data-source-status.md).
