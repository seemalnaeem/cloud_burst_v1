# Ports and networking

**Requirement:** the host address is DHCP assigned. When it changes, someone types the new address
into a browser and everything works. No rebuild, no config edit, no restart.

## Allocation

| Host | Service | Container | Note |
|---|---|---|---|
| 5545 | `cbd-db` Postgres + PostGIS | 5545 | a native Postgres holds 5432 here |
| 3090 | `cbd-gateway` | 3090 | the only port the browser needs |
| 3091 | `cbd-api` FastAPI | 3091 | direct access for `/docs` |
| 3092 | `cbd-tiles` pg_tileserv | 3092 | off its 7800 default via `TS_HTTPPORT` |
| 3093 | `cbd-raster` TiTiler | 3093 | off its 8000 default via `PORT` |
| 4090 | `cbd-web` Vite | 4090 | |
| 4091 | `cbd-web-prod` nginx | 4091 | listens on 4091, not 80 |

Container ports match host ports. Bridge networking already namespaces internal ports so a clash is
impossible; the alignment just means one number per service. Consequence: `pg_isready` and `psql`
inside `cbd-db` need `-p 5545`.

## Three mechanisms, no addresses

**Container to container: Docker DNS.** One bridge network, no `ipv4_address`, no reserved subnet.

```yaml
networks:
  cbd-net:
    driver: bridge
```

That is the whole definition. Docker allocates a `/16` per network; other stacks here hold
`172.17`-`172.21`, so this takes the next free block. Pinning one would collide with a project that
does not exist yet. (The old system hard-coded GeoServer at `172.18.1.132`, inside a range another
project owns today. It was never stable.)

**Host to container: bind everything.** Published ports bind `0.0.0.0` by default. Processes inside
must too: uvicorn `--host 0.0.0.0`, Vite `server.host: '0.0.0.0'`, Express `listen(port,'0.0.0.0')`.
Loopback inside a container is unreachable from outside.

**Browser to host: runtime resolution.**

```js
export const API_BASE = runtime.apiBase || import.meta.env.VITE_API_BASE ||
  `${window.location.protocol}//${window.location.hostname}:${port}`
```

Evaluated in the browser, not substituted at build time. That is the whole trick.
`window.__CBD_CONFIG__` from `public/runtime-config.js` is the escape hatch for a fixed deployment.

## Vite specifics

```js
server: {
  host: '0.0.0.0', port: 4090, strictPort: true,
  allowedHosts: true,        // else Vite rejects an unknown Host header, ie every new address
  hmr: { clientPort: 4090 }  // else the HMR socket targets the internal port and dies silently
}
```

Without `hmr.clientPort` the page still loads and edits just stop appearing, which takes a while to
notice.

## CORS

The origin is `http://<today's address>:4090`, so an allowlist cannot be written in advance. Default
`reflect`: read `Origin`, echo it, add `Vary: Origin`. Right for a LAN portal, wrong for a fixed
public deployment where `CORS_ORIGINS` becomes an explicit list. Never combine reflected origins with
cookie credentials.

## Verify

```bash
./scripts/stack.sh check     # probes all services, prints working LAN URLs
curl -H 'Origin: http://10.9.9.9:4090' -i http://localhost:3090/health | grep -i access-control
```

Check from a second machine too; `localhost` passing proves less than you think. If it fails: all
services healthy, host firewall allows 3090-3093 and 4090, then devtools to see whether a request is
going to an old host (something bypassed `lib/api.js`).