# Convective Activity Risk System

A cloudburst risk portal for Pakistan. Ingests weather forecast rasters and
administrative boundaries, runs three scoring models over them, and renders the
result on a web map with legends, alerts and district drill-downs.

Stack is PERN plus FastAPI: PostgreSQL with PostGIS, an Express gateway, a
Python geoprocessing and science service, and a React client. Everything runs in
Docker.

## Quick start

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Then open `http://<this-machine-ip>:4090`.

Helper scripts:

```bash
./scripts/stack.sh up        # or  .\scripts\stack.ps1 up  on Windows
./scripts/stack.sh check     # probes everything, prints the URLs that work now
```

## Services and ports

| Service | What it does | Host port |
|---|---|---|
| `cbd-db` | PostgreSQL 16 with PostGIS 3.4, database `cari` | 5545 |
| `cbd-gateway` | Express gateway, the only port the browser needs | 3090 |
| `cbd-api` | FastAPI plus GDAL, rasterio, geopandas | 3091 |
| `cbd-tiles` | pg_tileserv, MVT vector tiles from PostGIS | 3092 |
| `cbd-raster` | TiTiler, XYZ raster tiles from COG | 3093 |
| `cbd-web` | Vite dev server | 4090 |
| `cbd-web-prod` | nginx serving the production build, `prod` profile | 4091 |

Backend ports stay in 3090 to 3099, frontend in 4090 to 4099. Database is `cari`
with user `cbd_user`.

## The address moves and that is fine

The machine gets its address from DHCP. When it changes, open the new address in
a browser and everything works. No rebuild, no config edit, no restart.

Three mechanisms make that true:

- Containers find each other by Compose service name through Docker's DNS. No
  fixed addresses, no reserved subnet.
- Published ports bind every interface, and processes inside containers listen
  on `0.0.0.0` rather than loopback.
- The browser computes every API URL from `window.location.hostname` when the
  page loads. That happens at runtime, so one build works on any address.

CORS reflects the caller origin, because an allowlist cannot be written in
advance for a moving address.

Full reasoning: [.claude/guardrails/ports-and-networking.md](.claude/guardrails/ports-and-networking.md).

## Layout

```
.claude/            agents, skills, playbooks, guardrails, memory, commands
shared/contracts/   thresholds, palettes, bands, layers, ports, time model
db/                 Dockerfile, init SQL, tile functions, helpers
backend/            FastAPI, scoring models, geoprocessing
middleware/         Express gateway, cache, upstream proxies
frontend/           Vite, React, Tailwind 4, react-icons
scripts/            ingest helpers and stack control
data/               raw sources and derived COGs, git-ignored
```

## Where the numbers live

Every threshold, weight, class boundary and palette is in
[shared/contracts/](shared/contracts/) as JSON, read by all three tiers through
one loader each. Nothing is retyped into source code.

This is not tidiness. The system being replaced had three scoring models sharing
variables at different thresholds, spread across a 3,600 line Python file and a
6,000 line JavaScript file. The rain threshold ended up with three different
values depending on where you looked, and the UI told users there were 7, 12 or
13 conditions depending on which panel they opened. Section 12 of
[DATA_SOURCES.md](docs/DATA_SOURCES.md) catalogs the rest.

## Two source documents

- [DATA_SOURCES.md](docs/DATA_SOURCES.md) is the data catalog. Sources, processing,
  thresholds, palettes, endpoints. Section 9 covers the scoring models, section
  12 lists every place the old code and its own comments disagreed. The code
  values are the correct ones and the contracts encode them.
- [COLOR_SCHEMES.md](docs/COLOR_SCHEMES.md) is the UI theme system, every `--cb-*`
  token in light and dark.

## The three scoring models

They share input variables and use different thresholds on purpose.

| | CARI | Hotspot mask | Susceptibility |
|---|---|---|---|
| Mechanic | 13 variables graded 0 to 6, weighted, summed | 13 conditions ANDed | count of 13 conditions holding over half the district area |
| Output | percentage, 7 classes | binary mask | 0 to 13, 5 classes |
| Rain | grade 6 above 100 mm/hr | type is rain AND rate above 40, one condition | type is rain, and rate at or above 100, two conditions |

Susceptibility is uniformly stricter than the hotspot mask. That is intentional
and they should never be reconciled.

## Development

```bash
docker compose exec cbd-api python3 -m pytest -q     # backend tests
docker compose exec cbd-api ruff check app           # backend lint
cd frontend && npm run lint && npm run build
cd middleware && npm run lint
docker compose exec cbd-db psql -U cbd_user -d cari
```

FastAPI publishes OpenAPI docs at `http://localhost:3091/docs`.

## Working with Claude Code

[.claude/](.claude/) carries the full context: five specialist agents that own
separate directories, skills for GDAL, PostGIS, the scoring models, Docker and
theming, playbooks for the recurring procedures, guardrails with the reasoning
behind each rule, and project memory.

Start with [CLAUDE.md](CLAUDE.md), then
[.claude/playbooks/onboarding.md](.claude/playbooks/onboarding.md).

Slash commands: `/stack-check`, `/guardrail-audit`, `/new-source`,
`/score-debug`.

## Data status

Vector sources, raster sources and external APIs are being supplied
incrementally. Until a source is confirmed, its route returns `501` naming the
missing configuration rather than guessing a URL or serving sample data.

Current status: [.claude/memory/data-source-status.md](.claude/memory/data-source-status.md).
