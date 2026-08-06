---
name: docker-stack
description: Running, debugging and extending the cloud-burst-dev Compose stack. Use for container startup, healthchecks, networking, volumes, rebuilds and logs. Triggers on docker, compose, container, image, healthcheck, volume, network, port, rebuild, logs.
---

# Docker stack

Project `cloud-burst-dev`, one bridge network, six services, container ports matching host ports:
`cbd-db` 5545, `cbd-gateway` 3090, `cbd-api` 3091, `cbd-tiles` 3092, `cbd-raster` 3093, `cbd-web`
4090.

```bash
docker compose up -d --build
docker compose logs -f cbd-api
docker compose exec cbd-api bash          # the container with GDAL
docker compose exec cbd-db psql -U cbd_user -d cari
./scripts/stack.sh check                  # probes all, prints working LAN URLs
```

`docker compose down -v` deletes the Postgres volume. Ask first.

Networking detail: [ports-and-networking.md](../../guardrails/ports-and-networking.md). A DHCP change
needs no action.

## Healthchecks

Every service declares one; `depends_on` uses `condition: service_healthy`. `cbd-db` needs a 60 s
`start_period` because first boot runs init SQL and builds PostGIS extensions; too short and the
container is killed mid-init leaving a half-built schema. Its `pg_isready` needs `-p 5545`.

## Volumes

`cbd-pgdata` named volume survives `down`. `./data` at `/data`, read-write in `cbd-api` and read-only
elsewhere. Source bind-mounted in dev; the prod profile copies into the image.

## The GDAL image

Built on the official OSGeo image, which ships GDAL 3.8, PROJ 9 and the `osgeo` bindings compiled
against each other. Pip-installing GDAL against a mismatched system library loses a day.

```bash
docker compose exec cbd-api gdalinfo --version
docker compose exec cbd-api python3 -c "from osgeo import gdal; print(gdal.__version__)"
```

Dependency files are copied and installed before application code in every Dockerfile, so a code edit
does not invalidate the dependency layer. Keep it that way.

## Debugging

| Symptom | Check |
|---|---|
| Will not start | `docker compose logs <svc>`; usually a missing `.env` or a taken port |
| Port allocated | `netstat -ano \| findstr :3090` / `lsof -i :3090` |
| Gateway cannot reach API | test DNS **inside** the container: `docker compose exec cbd-gateway getent hosts cbd-api` |
| Works on host, not LAN | host firewall, not Docker |
| DB refused on 5545 | check health, then that the mapping is `5545:5545` |
| Deps not updating | layer cache: `build --no-cache cbd-api` |
| Vite loads, HMR dead | `hmr.clientPort` must be 4090 |
| DB unhealthy first boot | raise `start_period`, do not shorten init |

## Adding a service

Free port in 3090-3099 or 4090-4099, added to `ports.json`, `.env.example` and
[ports-and-networking.md](../../guardrails/ports-and-networking.md); a healthcheck; the same network
with no fixed address; routed through the gateway if the browser needs it.