# Playbook: wire an external API

Owner: `middleware-agent`. All sources are anonymous; there is no credential in this project.

**1. Decide proxy or ingest.** Proxy what changes every few minutes and the browser reads directly
(radar frames), or free text needing parsing (advisories). **Ingest** anything that feeds scoring or
is static reference data. Do not proxy what should be ingested: a live proxy in the request path
means the portal is down whenever the upstream is.

**2. Configure.** `UPSTREAM_X_BASE=` blank by default. Blank means the route returns 501 naming the
variable. Never guess a URL, never return sample data. If a source needs a key, find another source.

**3. Probe before coding.** `curl -s -H 'User-Agent: Mozilla/5.0' "$UPSTREAM/manifest.json" | jq
keys`. Note whether it needs a User-Agent (several public weather services reject defaults), whether
it sends CORS headers, content type, size and latency.

**4. Route.**

```js
const safePath = upstreamPath(req.query.path, ALLOWED_PREFIX)   // not optional
const upstream = await http.stream(`${base}/${safePath}`, { timeoutMs: config.upstreamTimeoutMs })
res.set('Cache-Control', 'public, max-age=120')
upstream.body.pipe(res)
```

The path allowlist is not optional: without it the proxy is an open relay and an SSRF vector into the
Docker network where the database lives. Nor is the timeout: a hung upstream holds connections until
the process runs out.

Proxying exists mainly to add CORS headers. An image fetched cross-origin without them taints the
canvas and the map cannot use it.

**5. Cache on something that changes with the content.** A press release keys on its release id, so a
new one invalidates naturally and an unchanged one is never refetched. Time-based TTLs are the
fallback. `cache.wrap` also holds a per-key lock, so fifty simultaneous requests produce one upstream
call.

**6. Parse defensively.** External HTML and JSON change without notice; assume every field can be
missing. A scraper should log what it matched, degrade to a partial result rather than throwing, and
never let a parse failure take down a route that has cached data.

**7. Fail honestly.** Not configured 501 | timeout 504, serve stale cache **labelled as stale** |
unusable response 502, log the body and do not forward it | rate limited 503 with `Retry-After`.

A radar frame from four hours ago presented as current is worse than an error.