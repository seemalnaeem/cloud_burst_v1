// Convective Activity Risk System gateway.
//
// The only port the browser talks to. Fans /api to FastAPI, /tiles to
// pg_tileserv and /raster to TiTiler, so the client sees one origin and never
// learns the internal topology.

import { randomUUID } from 'node:crypto'

import compression from 'compression'
import express from 'express'
import helmet from 'helmet'

import { config } from './config.js'
import { cache } from './lib/cache.js'
import { cors } from './lib/cors.js'
import { errorHandler, notFoundHandler } from './lib/errors.js'
import { logger } from './lib/logger.js'
import { registerRoutes } from './routes/index.js'

const app = express()

app.disable('x-powered-by')
app.set('trust proxy', true)

// helmet defaults include COEP and a CSP tuned for HTML responses. This service
// returns JSON and binary tiles to a separate origin, and those two headers
// break the tile fetches without buying anything here.
//
// Cross-Origin-Resource-Policy is forced to cross-origin for the same reason.
// The web tier is served on a different port, so it is a different origin, and
// helmet's default of same-origin makes the browser silently refuse to embed
// any resource from here. JSON and tiles survive it because they are fetched
// with CORS, but a plain <img src> is a no-cors load: the event photos would be
// blocked with no console error. Everything this gateway serves is already open
// through CORS, so opening CORP to match is consistent, not a new exposure.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}))

app.use(cors())
app.use(compression())
app.use(express.json({ limit: config.bodyLimit }))

app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID()
  res.setHeader('X-Request-Id', req.id)
  const started = Date.now()
  res.on('finish', () => {
    logger.info(
      { requestId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started },
      'request'
    )
  })
  next()
})

registerRoutes(app)

app.use(notFoundHandler)
app.use(errorHandler(logger))

// Bind 0.0.0.0, not 127.0.0.1. A process on loopback inside a container is
// unreachable from outside it, which would defeat the whole point of publishing
// the port. See .claude/guardrails/ports-and-networking.md.
const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(
    { port: config.port, upstreams: config.upstreams, cors: config.corsOrigins },
    'gateway listening on all interfaces'
  )
})

cache.startPruneTimer()

const shutdown = (signal) => {
  logger.info({ signal }, 'shutting down')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
