// Pass /api through to FastAPI.
//
// The gateway does not reshape these responses. FastAPI already returns the
// standard error envelope, so re-wrapping would only add a layer to unwrap.
// What this adds is the single origin, the cache headers and the request id
// correlation between the two services.

import { createProxyMiddleware } from 'http-proxy-middleware'

import { config } from '../config.js'
import { logger } from '../lib/logger.js'

// Cache policy by path prefix. A result keyed by cycle and lead is immutable
// once computed, so it caches hard. Anything cycle discovery related is short,
// because that is how a new cycle becomes visible.
const CACHE_RULES = [
  { prefix: '/meta/forecast', value: config.cacheControl.meta },
  { prefix: '/meta', value: config.cacheControl.scores },
  { prefix: '/score', value: config.cacheControl.scores },
  { prefix: '/alerts', value: config.cacheControl.alerts },
  { prefix: '/districts', value: config.cacheControl.scores },
  // Event records and their images are static once ingested, so they cache like
  // scores. The images also carry their own immutable Cache-Control from FastAPI.
  { prefix: '/events', value: config.cacheControl.scores }
]

const cacheControlFor = (path) =>
  CACHE_RULES.find((rule) => path.startsWith(rule.prefix))?.value ?? config.cacheControl.none

export function apiProxy () {
  return createProxyMiddleware({
    target: config.upstreams.api,
    changeOrigin: true,
    pathRewrite: (path) => `/api${path}`,
    proxyTimeout: config.upstreamTimeoutMs,
    timeout: config.upstreamTimeoutMs,

    on: {
      proxyReq: (proxyReq, req) => {
        // Correlate the two services in the logs. Chasing a failure across a
        // gateway and an API without a shared id is unpleasant.
        if (req.id) proxyReq.setHeader('X-Request-Id', req.id)
      },

      proxyRes: (proxyRes, req) => {
        // Only cache successful responses. Caching a 404 for six hours means a
        // district that appears after an ingest stays missing until someone
        // clears the cache by hand.
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          proxyRes.headers['cache-control'] = cacheControlFor(req.path)
        } else {
          proxyRes.headers['cache-control'] = config.cacheControl.none
        }
      },

      error: (err, req, res) => {
        logger.error({ err: err.message, path: req.path, requestId: req.id }, 'api proxy failed')
        if (res.headersSent) return
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: {
              code: 'UPSTREAM_ERROR',
              message: 'The API service is not reachable. Check `docker compose ps cbd-api`.',
              requestId: req.id || 'unknown'
            }
          })
        )
      }
    }
  })
}
