---
name: api-contracts
description: The HTTP surface, route families, response shapes, error envelope, caching and how to add an endpoint. Use when designing or changing an API route. Triggers on endpoint, route, API, REST, response shape, error code, status code, OpenAPI, proxy.
---

# API contracts

One public origin, the gateway on 3090: `/api` to FastAPI 3091, `/tiles` to pg_tileserv 3092,
`/raster` to TiTiler 3093. Single origin means CORS is right in one place and the client never learns
the internal topology.

## Routes

`/health`, `/ready` | `/api/meta/*` (bands, layers, palettes, models, forecast) | `/api/districts/*`
| `/api/score/*` | `/api/alerts` | `/api/raster/resolve` | `/api/upstream/*` |
`/tiles/{layer}/{z}/{x}/{y}.pbf` | `/raster/{layer}/{z}/{x}/{y}.png`

Paths lowercase and hyphenated, params `snake_case`. Standard params: `forecast_hours` (negative
reaches history), `creation_time`, `district` (exact `district_name`), `band`, `matrix`.

## Shapes

Anything derived from a forecast carries `creationTime` and `leadHours`; a number without its cycle
is not interpretable. Scoring responses also carry `matrix`, because when a score looks surprising
that is the first question.

```json
{ "error": { "code": "...", "message": "...", "requestId": "..." } }
```

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | parameter missing or malformed |
| `DISTRICT_NOT_FOUND` | 404 | not in `geo.districts`; suggest near matches via trigram |
| `LEAD_UNAVAILABLE` | 404 | lead not published for this cycle |
| `NOT_CONFIGURED` | 501 | upstream env var blank |
| `UPSTREAM_ERROR` / `UPSTREAM_TIMEOUT` | 502 / 504 | external source |
| `BUSY` | 503 | concurrency limit |
| `INTERNAL` | 500 | detail in the log, not the response |

`NOT_CONFIGURED` matters: sources arrive incrementally, so a blank upstream returns 501 naming the
setting rather than inventing a URL or faking data.

## Caching

Boundary tiles 86400 | raster tiles and scores for a fixed cycle 21600 | alerts 900 | meta 300 |
health `no-store`.

Six hours matches the cycle cadence: a result keyed by `creation_time` and lead is immutable once
computed. **Only cache 2xx.** Caching a 404 for six hours means a district that appears after an
ingest stays missing.

## Adding an endpoint

Contract first, including the failure shapes; if you cannot say what happens when the data is
missing, it is not designed yet. Then Pydantic models in `schemas/`, a thin router (validate,
delegate, return, no numpy), work in `services/` cached on `(creation_time, lead)`, and a client call
in `frontend/src/lib/api.js` consumed through a hook that aborts on unmount or param change. Without
the abort, a user clicking through districts gets whichever response is slowest.

Test the **failure** paths; the happy path rarely breaks. OpenAPI at `http://localhost:3091/docs`.

## Tiles

Vector tiles come from one PostGIS function per layer with the zoom tier chosen inside. Raster tiles
come from TiTiler over a COG, with the layer name mapped to a path through `wx.raster_catalog` so a
caller never passes a filesystem path. Rescale and colormap come from `bands.json` and
`palettes.json`, not the query string, which is what stops a legend and its tiles disagreeing. Bound
the zoom range.

## Versioning

No prefix; frontend and backend deploy together. For a breaking change add the new shape alongside
the old, migrate the client, then remove the old. Never silently change a field's meaning.