# Guardrails

Rules with their reasons. A rule without a reason gets ignored the first time it is inconvenient.

Detail: [ports-and-networking.md](ports-and-networking.md) | [data-contracts.md](data-contracts.md)
| [style.md](style.md) | [security.md](security.md)

| # | Rule | Reason |
|---|---|---|
| 1 | Database `cari`, user `cbd_user`, port **5545** inside and out | A native PostgreSQL holds 5432 on this machine; the clash fails as an auth error |
| 2 | Backend **3090-3099**, frontend **4090-4099**, container port = host port | Verified free of every other stack here |
| 3 | **No IP address anywhere** | Container IPs come from Docker's pool; the browser derives the host at runtime. The old system hard-coded `172.18.1.132`, an address another project owns today |
| 4 | Numbers live in `shared/contracts/`, never in code | Three models share variables at different thresholds. Duplicated constants drifted before: rain had 3 values, the UI claimed 7, 12 or 13 conditions |
| 5 | Write it once | Check the tier's `lib`/`shared` first. Duplicated logic is a bug |
| 6 | Vite + Tailwind 4 plugin + **react-icons**. Lucide banned | Project owner's call. No PostCSS config, no CSS-in-JS, no component library |
| 7 | **No authenticated sources.** Earth Engine and GeoServer ruled out | No credential variable exists in this project. If a task seems to need one, find another source. See [OPEN_DATA_SOURCES.md](../../OPEN_DATA_SOURCES.md) |
| 8 | Unconfigured means **501** naming the setting | Sources arrive incrementally. A fabricated endpoint is worse than an honest gap |
| 9 | Confirm before `DROP`, `TRUNCATE`, `down -v`, deleting `data/` | `down -v` destroys the volume and re-ingest is slow |
| 10 | Self-contained | No code, config or convention from any other project on this machine |
| 11 | **No em-dashes** anywhere | Prose, comments, commits, UI strings, logs |

## Port allocation

3090 gateway (only port the browser needs) | 3091 FastAPI | 3092 vector tiles | 3093 raster tiles |
4090 Vite dev | 4091 nginx prod | 5545 Postgres. Free: 3094-3099, 4092-4099.

Taking a port means updating `ports.json`, `.env.example`, `docker-compose.yml` and
[ports-and-networking.md](ports-and-networking.md) together.

## Facts that produce wrong numbers silently

Listed in [CLAUDE.md](../../CLAUDE.md) and ordered by likelihood in
[troubleshooting.md](../playbooks/troubleshooting.md). Reasoning in [memory](../memory/).