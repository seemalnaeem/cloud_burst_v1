# Playbook: troubleshooting

```bash
docker compose ps && ./scripts/stack.sh check
docker compose logs --tail=50 cbd-api
```

A container restarting in a loop: the logs from *before* the restart are the interesting ones.

## Portal

| Symptom | Cause |
|---|---|
| Blank page, no requests | Vite not serving; a syntax error stops the dev server |
| Works on localhost, not LAN | host firewall; Docker already binds all interfaces |
| Requests go to `localhost` from a LAN page | something bypassed `lib/api.js`, find the literal |
| CORS failure | `curl -H 'Origin: http://10.9.9.9:4090' -i http://localhost:3090/health` |
| Loads, HMR dead | `hmr.clientPort` must be 4090 |

## Database

| Symptom | Cause |
|---|---|
| Refused on 5545 | check health, then that the mapping is `5545:5545` |
| Password auth failed | Postgres reads `POSTGRES_PASSWORD` only on first init; a later change has no effect on an existing volume |
| Suddenly slow | `EXPLAIN (ANALYZE, BUFFERS)`; `Seq Scan` on geometry means the GiST index is unused |
| District vanished, no error | invalid geometry; `ST_IsValidReason` |

## Tiles

| Symptom | Cause |
|---|---|
| 200 with 0 bytes | empty tile: bbox mismatch, or `sourceLayer` differs from the name in `ST_AsMVT` |
| Hundreds of KB | generalization not applied; check `geom_z6`/`geom_z9` populated |
| Raster like static | a COG written directly into `/data/cog` and served half-written |
| Raster one flat colour | rescale range wrong, or nodata undeclared so it skews stats |

## Scores, in order of likelihood

1. **Which matrix** (in the response). Terrain and lowlands differ on six variables.
2. **Which reducer.** VV uses min; a max there grades 0 where it should grade 5 or 6.
3. **Was precipitation differenced.** Cumulative as a rate saturates the rainfall grade.
4. **Slope resolution.** 5 km DEM, not native. Native inflates mountain districts.
5. **Lead 0.** Rain rate needs the 0-to-3 delta or every rain condition reads zero.
6. **Which model.** The three use deliberately different numbers.
7. **Override applied.** Raises only, so a high class can be correct.
8. **Input sanity.** `gdallocationinfo -valonly -wgs84 <cog> <lon> <lat>`. Check units: GFS is Kelvin.

Every district scoring 0 usually means zonal stats returning null: a CRS mismatch, or the raster does
not cover Pakistan.

## Docker

| Symptom | Cause |
|---|---|
| Port allocated | `netstat -ano \| findstr :3090` / `lsof -i :3090` |
| Gateway cannot reach API | test DNS **inside** the container, not from the host |
| Deps not updating | layer cache: `build --no-cache` |
| DB unhealthy first boot | raise `start_period`, do not shorten init |

GDAL symptoms: see the failures table in [gdal-toolbox](../skills/gdal-toolbox/SKILL.md).

## When none of this helps

Capture state **before** restarting; a restart fixes the symptom and destroys the evidence.

```bash
docker compose ps > /tmp/state.txt && docker compose logs --tail=500 >> /tmp/state.txt
```

Then write what you find into [memory](../memory/) so next time it is a lookup.