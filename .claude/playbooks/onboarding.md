# Playbook: onboarding

## Read, in order

1. [CLAUDE.md](../../CLAUDE.md) and [GUARDRAILS.md](../guardrails/GUARDRAILS.md). Ten minutes.
2. [DATA_SOURCES.md](../../DATA_SOURCES.md) sections 9 (the models) and 12 (known discrepancies).
   Section 12 explains why several numbers look inconsistent and which value is correct.
3. [OPEN_DATA_SOURCES.md](../../OPEN_DATA_SOURCES.md). Where data actually comes from now, since
   Earth Engine and GeoServer are ruled out.
4. [COLOR_SCHEMES.md](../../COLOR_SCHEMES.md) when you first style something.

## Run it

```bash
cp .env.example .env
docker compose up -d --build
./scripts/stack.sh check
```

Open the portal from a **second machine** using the host LAN address. That access pattern is a
requirement, not a nice-to-have.

## Orient

```
shared/contracts/   every number the science and visuals depend on
db/                 schema, migrations, tile functions
backend/app/        FastAPI, models, services      backend/app/geo/  GDAL, COG, zonal
middleware/src/     gateway, cache, proxies        frontend/src/     React client
```

Four files carry most of the design: `shared/contracts/cari.json`,
`backend/app/shared/timeutil.py`, `middleware/src/lib/cache.js`, `frontend/src/lib/api.js`.

The eight things that will trip you up are listed in [CLAUDE.md](../../CLAUDE.md). Read them twice.

## Where to ask

How something works: [skills](../skills/). Step by step: [playbooks](.). Why it is like this:
[memory](../memory/) and [guardrails](../guardrails/). What number is correct:
`shared/contracts/`, then DATA_SOURCES.md section 12.

## Before a pull request

```bash
docker compose exec cbd-api python3 -m pytest -q && ruff check app
cd frontend && npm run lint && npm run build
cd middleware && npm run lint
```

- [ ] No hex in a component, no threshold literal in code
- [ ] No IP address, no Lucide import, no credential variable
- [ ] No em-dash