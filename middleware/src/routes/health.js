import { Router } from 'express'

import { config } from '../config.js'
import { cache } from '../lib/cache.js'
import { http } from '../lib/http.js'
import { logger } from '../lib/logger.js'

export const healthRouter = Router()

healthRouter.get('/health', (req, res) => {
  res.setHeader('Cache-Control', config.cacheControl.none)
  res.json({ status: 'ok', service: 'cbd-gateway', port: config.port })
})

/**
 * Readiness across the whole stack.
 *
 * Checks every upstream by service name, which also proves Docker DNS is
 * resolving. That is the check that catches a container which started before
 * its dependency was healthy.
 */
healthRouter.get('/ready', async (req, res) => {
  res.setHeader('Cache-Control', config.cacheControl.none)

  const probes = {
    api: `${config.upstreams.api}/health`,
    tiles: `${config.upstreams.tiles}/index.json`,
    raster: `${config.upstreams.raster}/healthz`
  }

  const results = {}
  await Promise.all(
    Object.entries(probes).map(async ([name, url]) => {
      try {
        await http.getJson(url, { timeoutMs: 5000 })
        results[name] = 'ok'
      } catch (err) {
        logger.warn({ name, url, err: err.message }, 'upstream probe failed')
        results[name] = 'unreachable'
      }
    })
  )

  const ok = Object.values(results).every((v) => v === 'ok')
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    upstreams: results,
    cache: await cache.status()
  })
})

healthRouter.get('/cache/status', async (req, res) => {
  res.setHeader('Cache-Control', config.cacheControl.none)
  res.json(await cache.status())
})

healthRouter.post('/cache/clear', async (req, res) => {
  const prefix = String(req.query.prefix || '')
  const removed = prefix ? await cache.invalidate(prefix) : await cache.prune()
  res.json({ removed, prefix: prefix || '(pruned by age)' })
})
