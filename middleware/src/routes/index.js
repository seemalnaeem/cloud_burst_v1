// Route registration.
//
// Order matters: specific routes before the catch-all proxies.

import { healthRouter } from './health.js'
import { tilesRouter } from './tiles.js'
import { upstreamRouter } from './upstream.js'
import { apiProxy } from './api-proxy.js'

export function registerRoutes (app) {
  app.use(healthRouter)

  // External sources we proxy ourselves, before /api falls through to FastAPI.
  app.use('/api/upstream', upstreamRouter)

  // Vector and raster tiles.
  app.use(tilesRouter)

  // Everything else under /api goes to FastAPI.
  app.use('/api', apiProxy())
}
