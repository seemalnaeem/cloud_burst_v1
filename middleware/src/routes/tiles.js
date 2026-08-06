// Tile routes.
//
// Vector tiles come from pg_tileserv over a PostGIS function per layer. Raster
// tiles come from TiTiler over a COG. Both are proxied here so the browser
// deals with one origin, and so the layer name to backing resource mapping
// stays server side. A caller passes a layer id, never a filesystem path.

import { Router } from 'express'

import { config } from '../config.js'
import { layers, bands, palettes } from '../lib/contracts.js'
import { AppError } from '../lib/errors.js'
import { http } from '../lib/http.js'
import { logger } from '../lib/logger.js'
import { rasterLayer, tileCoords, vectorLayer } from '../lib/validate.js'

export const tilesRouter = Router()

const layerById = (id) => layers().layers.find((l) => l.id === id)
const bandByKey = (key) => bands().bands.find((b) => b.key === key)

/**
 * Vector tiles.
 *
 * How much geometry a tile carries is decided inside the PostGIS function,
 * which thins to the tile's own resolution and no further. Every caller
 * therefore behaves identically and nobody can request more detail than a tile
 * is able to draw.
 *
 * A layer's minzoom is enforced here as well as in the client, so a hand
 * crafted request cannot make the database build a tile the map would never
 * show. Set minzoom deliberately: a layer gated above the default view zoom
 * looks broken, because toggling it on does nothing at all.
 */
tilesRouter.get('/tiles/:layer/:z/:x/:y.pbf', async (req, res, next) => {
  try {
    const id = vectorLayer(req.params.layer)
    const { z, x, y } = tileCoords(req.params.z, req.params.x, req.params.y)
    const def = layerById(id)

    if (def.minzoom != null && z < def.minzoom) {
      // Empty rather than an error. The map asks for tiles outside a layer's
      // range as a matter of course and 204 is the cheap correct answer.
      res.setHeader('Cache-Control', config.cacheControl.vectorTiles)
      return res.status(204).end()
    }

    const url = `${config.upstreams.tiles}/${def.tileFunction}/${z}/${x}/${y}.pbf`
    const upstream = await http.stream(url, { timeoutMs: 30000 })

    res.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile')
    res.setHeader('Cache-Control', config.cacheControl.vectorTiles)
    upstream.body.pipe(res)
  } catch (err) {
    next(err)
  }
})

/**
 * Raster tiles.
 *
 * Rescale range and colormap come from the contracts, not from the query
 * string. That is what stops a legend and its tiles from ever disagreeing: they
 * read the same numbers.
 */
tilesRouter.get('/raster/:layer/:z/:x/:y.png', async (req, res, next) => {
  try {
    const id = rasterLayer(req.params.layer)
    const { z, x, y } = tileCoords(req.params.z, req.params.x, req.params.y)

    const bandKey = req.query.band ? String(req.query.band) : null
    const band = bandKey ? bandByKey(bandKey) : null

    if (bandKey && !band) {
      throw new AppError('VALIDATION_FAILED', `Unknown band ${bandKey}. See /api/meta/bands.`)
    }

    // Resolve the COG path through the API, which reads wx.raster_catalog.
    // The browser never sends a path, so this route cannot become an arbitrary
    // file reader.
    const resolveUrl = new URL(`${config.upstreams.api}/api/raster/resolve`)
    resolveUrl.searchParams.set('layer', id)
    if (bandKey) resolveUrl.searchParams.set('band', bandKey)
    if (req.query.creation_time) resolveUrl.searchParams.set('creation_time', String(req.query.creation_time))
    if (req.query.lead) resolveUrl.searchParams.set('lead', String(req.query.lead))

    const resolved = await http.getJson(resolveUrl.toString(), { timeoutMs: 15000 })

    if (!resolved?.path) {
      throw new AppError(
        'NOT_CONFIGURED',
        `No raster catalogued for layer ${id}${bandKey ? ` band ${bandKey}` : ''} at that cycle and lead.`
      )
    }

    const tileUrl = new URL(`${config.upstreams.raster}/cog/tiles/WebMercatorQuad/${z}/${x}/${y}.png`)
    tileUrl.searchParams.set('url', resolved.path)

    if (band) {
      tileUrl.searchParams.set('rescale', `${band.min},${band.max}`)
      const paletteName = band.palette
      const palette = palettes()[paletteName]
      if (palette?.colors) {
        tileUrl.searchParams.set('colormap', JSON.stringify(buildColormap(palette, band)))
      }
      // Categorical data must not be interpolated. Averaging codes 1 and 5
      // gives 3, which is a different category entirely.
      if (band.categorical) tileUrl.searchParams.set('resampling', 'nearest')
    }

    const upstream = await http.stream(tileUrl.toString(), { timeoutMs: 60000 })

    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', config.cacheControl.rasterTiles)
    upstream.body.pipe(res)
  } catch (err) {
    next(err)
  }
})

/**
 * Build a TiTiler colormap from a contract palette.
 *
 * Continuous palettes become evenly spaced value ranges across the band's
 * display range. Categorical palettes map each code to its color directly.
 */
function buildColormap (palette, band) {
  if (palette.kind === 'categorical') {
    return Object.fromEntries(palette.entries.map((e) => [e.code, hexToRgba(e.color)]))
  }

  const colors = palette.colors
  const span = (band.max - band.min) / colors.length

  return colors.map((color, i) => [
    [band.min + i * span, band.min + (i + 1) * span],
    hexToRgba(color)
  ])
}

const hexToRgba = (hex) => {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    255
  ]
}

// TileJSON so a map client can discover a layer without hardcoding the URL
// template. The tile URL is relative, which keeps it correct whatever address
// the host currently answers on.
tilesRouter.get('/tiles/:layer.json', (req, res, next) => {
  try {
    const id = vectorLayer(req.params.layer)
    const def = layerById(id)

    res.setHeader('Cache-Control', config.cacheControl.meta)
    res.json({
      tilejson: '3.0.0',
      name: def.label,
      tiles: [`/tiles/${id}/{z}/{x}/{y}.pbf`],
      minzoom: def.minzoom ?? 0,
      maxzoom: def.maxzoom ?? 16,
      vector_layers: [{ id: def.sourceLayer, fields: Object.fromEntries((def.properties || []).map((p) => [p, 'String'])) }]
    })
  } catch (err) {
    next(err)
  }
})

logger.debug('tile routes registered')
