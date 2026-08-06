// Gateway configuration, all from environment.
//
// Every upstream is a compose service name. There is no IP address in this
// file and there must not be one, container addresses come from the Docker
// bridge pool and change on recreate.

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) ? n : fallback
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.GATEWAY_PORT, 3090),
  logLevel: process.env.LOG_LEVEL || 'info',

  // Internal ports match host ports one to one, so cbd-tiles is on 3092 both
  // inside the network and outside it.
  upstreams: {
    api: process.env.API_INTERNAL_URL || 'http://cbd-api:3091',
    tiles: process.env.TILES_INTERNAL_URL || 'http://cbd-tiles:3092',
    raster: process.env.RASTER_INTERNAL_URL || 'http://cbd-raster:3093'
  },

  // "reflect" echoes the caller origin back. That is what lets the portal work
  // when the host picks up a new DHCP address, because the browser origin is
  // http://<todays-address>:4090 and an allowlist cannot be written in advance
  // for a moving target. Set a comma separated list to lock it down for a fixed
  // deployment.
  corsOrigins: process.env.CORS_ORIGINS || 'reflect',

  cache: {
    dir: process.env.CACHE_DIR || '/app/.cache',
    ttlSeconds: int(process.env.CACHE_TTL_SECONDS, 21600),
    pruneDays: int(process.env.CACHE_PRUNE_DAYS, 10),
    pruneIntervalMs: 30 * 60 * 1000
  },

  upstreamTimeoutMs: int(process.env.UPSTREAM_TIMEOUT_MS, 180000),
  bodyLimit: '1mb',

  // External sources.
  //
  // All anonymous. No key, no token, no service account. Earth Engine and
  // GeoServer are ruled out, see OPEN_DATA_SOURCES.md. Blank means not
  // configured, and the route returns 501 naming the variable rather than
  // guessing a URL.
  external: {
    pmdRadarBase: process.env.UPSTREAM_PMD_RADAR_BASE || '',
    pmdPressBase: process.env.UPSTREAM_PMD_PRESS_BASE || '',
    userAgent: process.env.UPSTREAM_USER_AGENT || 'Mozilla/5.0 (compatible; CloudBurstDev/1.0)'
  },

  // Six hours matches the forecast cycle cadence. A result keyed by cycle and
  // lead is immutable once computed, so it can be cached hard and falls out of
  // relevance on its own when a new cycle lands.
  cacheControl: {
    vectorTiles: 'public, max-age=86400',
    rasterTiles: 'public, max-age=21600',
    scores: 'public, max-age=21600',
    alerts: 'public, max-age=900',
    meta: 'public, max-age=300',
    none: 'no-store'
  }
}
