# Security

A LAN dev stack, but these will bite regardless.

## Secrets

**There is no credential in this project.** Every source is anonymous HTTP or anonymous S3; Earth
Engine and GeoServer are ruled out. If something appears to need a key, find another source.
[[no-authenticated-sources]]

Never commit `.env`. `.claude/settings.json` denies reading it plus `secrets/**` and
`*service-account*.json`. The database password is `postgres` deliberately, which means the Postgres
port must not be exposed beyond the LAN. Never log a connection string, token or Authorization
header; each tier's logger has a redaction list, add to it rather than remembering.

## Proxy safety

Every proxy route needs both:

```js
if (!path.startsWith(ALLOWED_PREFIX) || path.includes('..')) throw new AppError('VALIDATION_FAILED', ...)
```

Without the path allowlist the proxy is an open relay and an SSRF vector into the Docker network
where the database lives. Without a timeout a hung upstream holds connections until the process runs
out. Outbound requests only go to hosts named in env vars; no route accepts a full URL from a caller.

## Input validation

Pydantic on FastAPI, `lib/validate.js` on the gateway. `district` checked against the table and never
interpolated into SQL, `forecast_hours` an integer in range, `band` checked against `bands.json`,
`z`/`x`/`y` integers with `x` and `y` inside `2^z`.

Parameterized queries always. Never build SQL by concatenation, including for identifiers; map a
dynamic table name through a fixed allowlist.

## Resource limits

An unbounded raster request is accidental denial of service. Gateway body limit, 180 s upstream
timeout, `MAX_CONCURRENT_JOBS` returning 503 rather than queueing unbounded, bounded tile zoom, and
in-flight de-duplication so one slow computation is not started fifty times.

## CORS

Reflecting the origin is intentional for a moving LAN address
([ports-and-networking.md](ports-and-networking.md)) and wrong for a fixed public deployment, where
`CORS_ORIGINS` becomes an explicit list. Never combine reflected origins with cookie credentials.

## Containers

Non-root where the base image allows. Postgres on a named volume so a stray `down` does not erase it;
only `down -v` does, which is in the deny list. Read-only mounts where a service only reads. No
`privileged: true`.