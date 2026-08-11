# Security

A LAN dev stack, but these will bite regardless.

## Secrets

Every data source was anonymous HTTP or anonymous S3, with two named credentials admitted by the
owner as deliberate exceptions. Do not add a third without the same explicit sign off, and do not
cite these to justify one. [[no-authenticated-sources]]

1. **`VITE_MAPBOX_TOKEN`** (2026-08-06). A public client basemap token, not a data credential. Reaches
   the browser by design, restricted by URL in the Mapbox account, blank is supported.
2. **`PMD_USER` / `PMD_PASS`** (2026-08-10). The owner's account on the PMD early warning portal
   (`PMD_BASE`, currently `https://115.186.56.181:12304`), which serves the ECMWF / WRF / CFS forecast
   fields the CARI models need. This **is** a data credential and a real reversal of the anonymous
   rule, admitted because the owner is authorised to use PMD's own feed and no anonymous equivalent
   carries these exact fields for Pakistan. It is server side only, never reaches the browser, and
   lives only in `.env`. The server presents a self-signed certificate, so the ingest disables TLS
   verification for that host and only that host.

Never commit `.env`. `.claude/settings.json` denies reading it plus `secrets/**` and
`*service-account*.json`. The database password is `postgres` deliberately, which means the Postgres
port must not be exposed beyond the LAN. Never log a connection string, token, cookie or
Authorization header; each tier's logger has a redaction list, add to it rather than remembering. The
PMD `ews_jwt` cookie and password belong on that list.

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