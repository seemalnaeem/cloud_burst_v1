// External source proxies.
//
// Why these exist at all: several upstreams send no Access-Control-Allow-Origin
// header, and a cross origin fetch of an image without it taints the canvas so
// the map cannot use it. Proxying adds the header.
//
// Every route here is unconfigured until the project owner supplies the source.
// Unconfigured returns 501 naming the missing variable. It does not guess a URL
// and it does not serve sample data. See .claude/memory/data-source-status.md.

import { Router } from 'express'

import { config } from '../config.js'
import { cache } from '../lib/cache.js'
import { notConfigured } from '../lib/errors.js'
import { http } from '../lib/http.js'
import { upstreamPath } from '../lib/validate.js'

export const upstreamRouter = Router()

const RADAR_PATH_PREFIX = 'images/radar/'

upstreamRouter.get('/status', (req, res) => {
  res.setHeader('Cache-Control', config.cacheControl.none)
  res.json({
    configured: {
      pmdRadar: Boolean(config.external.pmdRadarBase),
      pmdPress: Boolean(config.external.pmdPressBase)
    },
    note: 'A false value means the environment variable is blank and the route returns 501.',
    auth: 'none. Every source is anonymous HTTP or anonymous S3, see OPEN_DATA_SOURCES.md.'
  })
})

/**
 * Radar frame manifest.
 *
 * Cached briefly. Radar refreshes every few minutes, so a long TTL would show
 * stale weather and a zero TTL would hammer the upstream.
 */
upstreamRouter.get('/radar', async (req, res, next) => {
  try {
    if (!config.external.pmdRadarBase) {
      throw notConfigured('UPSTREAM_PMD_RADAR_BASE', 'radar imagery')
    }

    const site = String(req.query.site || 'islamabad')
    const product = String(req.query.product || 'Surface-R')

    const manifest = await cache.wrap(
      'radar',
      { site, product },
      () => http.getJson(`${config.external.pmdRadarBase}/radar-images-${site}.json`, { timeoutMs: 30000 }),
      { ttlSeconds: 120 }
    )

    res.setHeader('Cache-Control', 'public, max-age=120')
    res.json({ site, product, manifest })
  } catch (err) {
    next(err)
  }
})

/**
 * Radar image passthrough.
 *
 * The path allowlist is not optional. Without it this route is an open relay
 * and an SSRF vector into the Docker network, where it can reach the database.
 */
upstreamRouter.get('/radar/image', async (req, res, next) => {
  try {
    if (!config.external.pmdRadarBase) {
      throw notConfigured('UPSTREAM_PMD_RADAR_BASE', 'radar imagery')
    }

    const safePath = upstreamPath(req.query.path, RADAR_PATH_PREFIX)
    const upstream = await http.stream(`${config.external.pmdRadarBase}/${safePath}`, { timeoutMs: 30000 })

    res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/png')
    res.setHeader('Cache-Control', 'public, max-age=120')
    upstream.body.pipe(res)
  } catch (err) {
    next(err)
  }
})

/**
 * Advisory press releases.
 *
 * Keyed on the release id rather than a time window, so a new release
 * invalidates naturally and an unchanged one is never refetched.
 */
upstreamRouter.get('/advisories', async (req, res, next) => {
  try {
    if (!config.external.pmdPressBase) {
      throw notConfigured('UPSTREAM_PMD_PRESS_BASE', 'weather advisories')
    }

    const data = await cache.wrap(
      'advisories',
      { type: String(req.query.type || 'RAIN-WIND') },
      () => http.getJson(config.external.pmdPressBase, { timeoutMs: 30000 }),
      { ttlSeconds: 1800 }
    )

    res.setHeader('Cache-Control', 'public, max-age=1800')
    res.json(data)
  } catch (err) {
    next(err)
  }
})
