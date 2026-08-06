# Stack helpers for Windows.
#
#   .\scripts\stack.ps1 up
#   .\scripts\stack.ps1 logs cbd-api
#   .\scripts\stack.ps1 psql
#   .\scripts\stack.ps1 check
#
# Nothing here hardcodes an address. The check target discovers the machine's
# current addresses and reports the URLs that should work right now.

param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1)][string]$Arg = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Show-Help {
  Write-Host @'
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
'@
}

switch ($Command) {
  'up' {
    if (-not (Test-Path .env)) {
      Copy-Item .env.example .env
      Write-Host 'Created .env from .env.example'
    }
    docker compose up -d --build
    docker compose ps
  }

  'down'    { docker compose down }
  'ps'      { docker compose ps }
  'restart' { docker compose restart $Arg }
  'logs'    { docker compose logs -f $Arg }
  'psql'    { docker compose exec cbd-db psql -U cbd_user -d cari }
  'shell'   { docker compose exec cbd-api bash }
  'test'    { docker compose exec cbd-api python3 -m pytest -q }

  'check' {
    $probes = @(
      @{ Name = 'gateway'; Url = 'http://localhost:3090/health' }
      @{ Name = 'api';     Url = 'http://localhost:3091/health' }
      @{ Name = 'tiles';   Url = 'http://localhost:3092/index.json' }
      @{ Name = 'raster';  Url = 'http://localhost:3093/healthz' }
      @{ Name = 'web';     Url = 'http://localhost:4090/' }
    )

    foreach ($probe in $probes) {
      try {
        $response = Invoke-WebRequest -Uri $probe.Url -TimeoutSec 5 -UseBasicParsing
        Write-Host ("  {0,-8} ok ({1})" -f $probe.Name, $response.StatusCode) -ForegroundColor Green
      } catch {
        Write-Host ("  {0,-8} unreachable" -f $probe.Name) -ForegroundColor Red
      }
    }

    # The addresses are discovered rather than configured. That is the whole
    # point: the machine can move between networks and the portal follows.
    Write-Host "`nReachable from this machine and the LAN at:"
    Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      ForEach-Object { Write-Host ("  http://{0}:4090" -f $_.IPAddress) }
  }

  default { Show-Help }
}
