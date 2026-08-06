#!/usr/bin/env bash
# Stack helpers.
#
#   ./scripts/stack.sh up
#   ./scripts/stack.sh logs cbd-api
#   ./scripts/stack.sh check
#
# Nothing here hardcodes an address. The check target discovers the machine's
# current addresses and prints the URLs that work right now.

set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  cat <<'EOF'
Cloud Burst Dev stack

  up        Build and start everything
  down      Stop, keeping the database volume
  restart   Restart one service, for example: restart cbd-gateway
  logs      Follow logs for one service
  ps        Status and health
  psql      Open a psql session against cari
  shell     Shell into cbd-api, the container with GDAL
  check     Probe every health endpoint and print the reachable URLs
  test      Run the backend test suite

Ports: gateway 3090, api 3091, tiles 3092, raster 3093, web 4090, postgres 5545
EOF
}

cmd="${1:-help}"
arg="${2:-}"

case "$cmd" in
  up)
    [ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example"; }
    docker compose up -d --build
    docker compose ps
    ;;
  down)    docker compose down ;;
  ps)      docker compose ps ;;
  restart) docker compose restart "$arg" ;;
  logs)    docker compose logs -f "$arg" ;;
  psql)    docker compose exec cbd-db psql -U cbd_user -d cari ;;
  shell)   docker compose exec cbd-api bash ;;
  test)    docker compose exec cbd-api python3 -m pytest -q ;;

  check)
    probe () {
      if curl -sf -o /dev/null --max-time 5 "$2"; then
        printf '  %-8s ok\n' "$1"
      else
        printf '  %-8s unreachable\n' "$1"
      fi
    }
    probe gateway http://localhost:3090/health
    probe api     http://localhost:3091/health
    probe tiles   http://localhost:3092/index.json
    probe raster  http://localhost:3093/healthz
    probe web     http://localhost:4090/

    echo
    echo "Reachable from this machine and the LAN at:"
    if command -v ip >/dev/null 2>&1; then
      ip -4 -o addr show scope global | awk '{split($4,a,"/"); print "  http://" a[1] ":4090"}'
    else
      ifconfig | awk '/inet /{ if ($2 != "127.0.0.1") print "  http://" $2 ":4090" }'
    fi
    ;;

  *) usage ;;
esac
