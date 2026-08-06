---
name: port-allocation
description: Backend ports 3090-3099, frontend 4090-4099, Postgres on 5545 with database cari and user cbd_user. Container ports match host ports.
metadata:
  type: project
---

Fixed by the owner: backend **3090-3099**, frontend **4090-4099**, PostgreSQL **5545**, database
`cari`, user `cbd_user`, password `postgres`.

Current: 3090 gateway, 3091 FastAPI, 3092 vector tiles, 3093 raster tiles, 4090 Vite, 4091 nginx.
Free: 3094-3099, 4092-4099. Container ports match host ports.

**Why 5545:** a native PostgreSQL really does hold 5432 on this machine (verified 2026-08-06), and
that collision surfaces as a confusing auth error. The neighbouring stack uses 5544, so 5545 also
fits the existing numbering.

**Taken by other things here** (conflict avoidance only, not conventions to copy): 5432 native
Postgres, 8080 native GeoServer, 4000/5544/8095/9000 and 8090 other stacks, 7000 a tile server,
3000/5001/8000/27017 stopped containers. Docker subnets `172.17`-`172.21` are in use, so this project
takes the next free `/16`. Our ranges are clear of all of it.

**How to apply:** taking a port means updating `ports.json`, `.env.example`, `docker-compose.yml` and
`.claude/guardrails/ports-and-networking.md` together. Re-check first:

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @(3090..3099 + 4090..4099) }
```

Related: [[auto-ip-requirement]], [[self-contained-project]]