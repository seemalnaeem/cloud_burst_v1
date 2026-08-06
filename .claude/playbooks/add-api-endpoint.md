# Playbook: add an API endpoint

Owner: `backend-agent`, plus `middleware-agent` for a new prefix and `frontend-agent` for the client.
Conventions in [api-contracts](../skills/api-contracts/SKILL.md).

**1. Contract first.** Path, method, parameters, response shape, **failure shapes**, cache duration
and key. If you cannot say what happens when the data is missing, it is not designed yet.

**2. Schemas.** Pydantic models in `backend/app/schemas/`, not dicts. They are validation,
serialization and the OpenAPI docs at once. Include `matrix` in any scoring response, because when a
score looks surprising that is the first question and the answer should not need a log dig.

**3. Router, thin.**

```python
@router.get('/score/cari', response_model=CariResponse)
async def get_cari(district: str = Depends(require_district),
                   forecast_hours: int = Depends(require_lead),
                   matrix: MatrixName | None = None) -> CariResponse:
    return await score_service.cari(district, forecast_hours, matrix)
```

Validate, delegate, return. No numpy, no SQL, no threshold.

**4. Service does the work.** Resolve the cycle, cache on `(creation_time, lead, ...)` so the entry
is immutable, fetch geometry, run zonal stats in a threadpool, score, store, return.

**5. Failure paths, each an explicit branch.** Unknown district 404 with trigram suggestions | lead
not published 404 listing nearest | raster not catalogued 501 naming what is missing | concurrency
limit 503 with `Retry-After` | anything else 500 with detail in the log only.

The 404 suggestion is worth the effort: the fuzzy index already exists and it saves a round trip.

**6. Gateway.** An existing prefix needs nothing; a new one goes in the proxy map with a deliberate
cache policy. Only cache 2xx.

**7. Client.** Named call in `frontend/src/lib/api.js`, consumed through a hook that aborts on
unmount or parameter change. Without the abort, a user clicking through districts gets whichever
response is slowest.

**8. Test the failure paths.** The happy path usually works and rarely breaks.