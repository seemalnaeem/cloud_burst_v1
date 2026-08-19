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
import { load } from '../lib/contracts.js'
import { cache } from '../lib/cache.js'
import { EMPTY_TILE } from '../lib/emptyTile.js'
import { AppError, notConfigured } from '../lib/errors.js'
import { http } from '../lib/http.js'
import { upstreamPath } from '../lib/validate.js'

export const upstreamRouter = Router()

const RADAR_PATH_PREFIX = 'images/radar/'

/**
 * Every frame in one product directory, oldest to newest.
 *
 * The site publishes frames into an Apache autoindex, one file per scan, named
 * with a fixed prefix and a YYYYMMDDHHMM timestamp. There is no manifest to read;
 * the listing is the manifest. The timestamp sorts lexically as it does
 * chronologically, so the sorted list is the animation order, and the newest is
 * simply the last. The whole series is returned so the client can scrub and
 * animate the loop, not just show the latest scan.
 */
async function listFrames (base, prefix, site, product) {
  const dir = `${base}/${prefix}/${site}/${product.folder}/`
  const html = await http.getText(dir, { timeoutMs: 30000 })

  const names = [...new Set((html.match(/[A-Za-z0-9_]+\.png/g) || []))].filter((n) => n.startsWith(`${site}_`))
  const frames = names
    .map((filename) => {
      const stamp = filename.match(/_(\d{12})_/)
      return stamp
        ? { timestamp: stamp[1], path: `${prefix}/${site}/${product.folder}/${filename}` }
        : null
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  return {
    product: product.id,
    label: product.label,
    rangeKm: product.rangeKm,
    frames
  }
}

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
 * The radar frame series for a site, per product.
 *
 * Discovered live from the source's directory listing and cached briefly: radar
 * refreshes every few minutes, so a long TTL would show stale weather and a zero
 * TTL would hammer the upstream. Each product carries its full ordered list of
 * proxied frame paths, so the client can drive its own animation slider; every
 * frame loads through this gateway, never the source directly.
 */
upstreamRouter.get('/radar', async (req, res, next) => {
  try {
    if (!config.external.pmdRadarBase) {
      throw notConfigured('UPSTREAM_PMD_RADAR_BASE', 'radar imagery')
    }

    const contract = load('radar')
    const site = String(req.query.site || 'islamabad')
    if (!contract.sites.some((s) => s.id === site)) {
      throw new AppError('VALIDATION_FAILED', `Unknown radar site ${site}. See /api/meta/radar.`)
    }

    const products = await cache.wrap(
      'radar',
      { site },
      async () => {
        const settled = await Promise.all(
          contract.products.map((p) =>
            listFrames(config.external.pmdRadarBase, contract.pathPrefix, site, p).catch(() => null)
          )
        )
        return settled.filter(Boolean)
      },
      { ttlSeconds: 120 }
    )

    res.setHeader('Cache-Control', 'public, max-age=120')
    res.json({ site, products })
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

    // Radar imagery is best effort. A frame that has rolled off the listing 404s,
    // and the source is flaky enough that a live frame intermittently 502s or
    // times out; either way that is one empty frame in a loop, not a reason to
    // blank the map behind an error banner. Serve a transparent PNG and let the
    // animation carry on. A real outage still surfaces through the listing route
    // (/radar), whose failure the client shows as a dismissable toast.
    let upstream
    try {
      upstream = await http.stream(`${config.external.pmdRadarBase}/${safePath}`, {
        timeoutMs: 30000,
        allowStatus: [404]
      })
    } catch {
      // A short cache here, not the frame's usual six, so a frame that fails once
      // and recovers is retried on the next loop rather than stuck empty.
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'public, max-age=30')
      return res.status(200).end(EMPTY_TILE)
    }

    res.setHeader('Content-Type', 'image/png')

    if (upstream.statusCode === 404) {
      await upstream.body.dump()
      res.setHeader('Cache-Control', 'public, max-age=120')
      return res.status(200).end(EMPTY_TILE)
    }

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
