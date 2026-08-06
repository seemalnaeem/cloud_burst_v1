---
name: shared-utilities
description: Where every reusable helper lives across the three tiers, and the rule against duplicating logic. Use before writing any helper, formatter, cache key, validator or contract loader. Triggers on utility, helper, shared, reuse, duplicate, DRY, lib, formatter.
---

# Shared utilities

**Check before you write.**

```bash
grep -rn "name" frontend/src/lib middleware/src/lib backend/app/shared backend/app/geo
```

| Tier | Directory | Contains |
|---|---|---|
| Shared data | `shared/contracts/` | JSON read by all three tiers |
| Frontend | `frontend/src/lib/` | api, contracts, format, color, map, storage |
| Middleware | `middleware/src/lib/` | contracts, cache, http, errors, logger, validate, cors |
| Backend | `backend/app/shared/` | contracts, cache, errors, logging, timeutil, validation |
| Geo | `backend/app/geo/` | gdal_tools, zonal, derive |

## Cross-language

JS and Python cannot share code, so shared knowledge is expressed as **data** in `shared/contracts/`
with a thin loader per tier. That covers thresholds, palettes, classes, bands, layers, ports and the
time grid, but not behaviour: each tier implements against the same contract, with tests proving they
agree on shared fixtures.

## The ones that matter

**`lib/api.js`** resolves the base URL from `window.location.hostname` at runtime, adds the request
id, handles the error envelope and supports abort. Never call `fetch` in a component.

**`lib/format.js`** handles null everywhere. `fmtNumber(null)` returns a placeholder, not `NaN`;
missing forecast values are normal.

**`lib/cache.js`** `wrap(prefix, params, producer)` handles the key hash, the atomic write, and the
in-flight lock that stops fifty concurrent requests starting fifty identical computations.

**`shared/timeutil.py`** the lead grid, skipped grid points, negative leads into past cycles, and the
lead-0 delta. Reimplementing a piece inline is how two endpoints end up disagreeing about which hour
they show.

**`geo/zonal.py`** `zonal_stat` takes the reducer as an argument, never defaulted, because it varies
per variable and a wrong one shifts every downstream score. `zonal_fraction` is what susceptibility
needs.

## When to share, and when not

Add a helper when a second caller appears. Not before, not after. Write a test; an untested helper is
one the next person reimplements.

Do not hoist just because two callers look similar. If a change for caller A would break caller B,
they were never the same function. Premature sharing produces a helper with four boolean flags, worse
than the duplication it replaced.