// Tile routes.
//
// Vector tiles come from pg_tileserv over a PostGIS function per layer. Raster
// tiles come from TiTiler over a COG. Both are proxied here so the browser
// deals with one origin, and so the layer name to backing resource mapping
// stays server side. A caller passes a layer id, never a filesystem path.

import { Router } from 'express'

import { config } from '../config.js'
import { layers, bands, palettes } from '../lib/contracts.js'
import { EMPTY_TILE } from '../lib/emptyTile.js'
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
 * Rescale range, palette and resampling all come from the API's resolve call,
 * not from the query string and not from a second lookup here. The API reads
 * them out of the same contract the legend reads, so a tile and the legend
 * describing it cannot disagree.
 *
 * Deriving them here from a `band` query parameter was the earlier design and
 * it had a hole: a layer that is not band driven sends no band, so there was
 * nothing to derive from, and the tile went out with no rescale and no colormap
 * at all. A 16 bit elevation raster rendered that way is a black square. The
 * resolver already knows the band a layer maps to, so it is the one that should
 * answer.
 */
tilesRouter.get('/raster/:layer/:z/:x/:y.png', async (req, res, next) => {
  try {
    const id = rasterLayer(req.params.layer)
    const { z, x, y } = tileCoords(req.params.z, req.params.x, req.params.y)

    const bandKey = req.query.band ? String(req.query.band) : null

    if (bandKey && !bandByKey(bandKey)) {
      throw new AppError('VALIDATION_FAILED', `Unknown band ${bandKey}. See /api/meta/bands.`)
    }

    // Resolve the COG path through the API, which reads wx.raster_catalog.
    // The browser never sends a path, so this route cannot become an arbitrary
    // file reader.
    const resolveUrl = new URL(`${config.upstreams.api}/api/raster/resolve`)
    resolveUrl.searchParams.set('layer', id)
    if (bandKey) resolveUrl.searchParams.set('band', bandKey)
    // The model selects which forecast run backs a temporal layer, since the same
    // band exists under several models. Absent for static and computed layers.
    if (req.query.model) resolveUrl.searchParams.set('model', String(req.query.model))
    if (req.query.creation_time) resolveUrl.searchParams.set('creation_time', String(req.query.creation_time))
    if (req.query.lead) resolveUrl.searchParams.set('lead', String(req.query.lead))

    // 501 (NOT_CONFIGURED) is allowed through: a temporal layer legitimately has
    // no tile at some cycles and leads (a field can be initialised on a different
    // run than the model's main cycle, so it does not cover every step). That is
    // an empty tile, exactly like a 404 from the tiler, not a 502 error banner.
    const resolved = await http.getJson(resolveUrl.toString(), { timeoutMs: 15000, allowStatus: [501] })

    if (!resolved?.path) {
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', config.cacheControl.rasterTiles)
      return res.status(200).end(EMPTY_TILE)
    }

    const tileUrl = new URL(`${config.upstreams.raster}/cog/tiles/WebMercatorQuad/${z}/${x}/${y}.png`)
    tileUrl.searchParams.set('url', resolved.path)

    const palette = resolved.palette ? palettes()[resolved.palette] : null

    if (resolved.categorical) {
      // No rescale for categorical data. The colormap keys are the codes
      // themselves, and rescaling would move them somewhere else entirely.
      // Nor may it be interpolated: averaging codes 1 and 5 gives 3, which is a
      // different category.
      tileUrl.searchParams.set('resampling', 'nearest')
      if (palette) {
        tileUrl.searchParams.set('colormap', JSON.stringify(buildColormap(palette)))
      }
    } else if (resolved.min != null && resolved.max != null) {
      tileUrl.searchParams.set('rescale', `${resolved.min},${resolved.max}`)
      if (palette) {
        tileUrl.searchParams.set('colormap', JSON.stringify(buildColormap(palette, resolved.min, resolved.max)))
      }
    }

    // 404 from the tiler means the tile does not intersect the raster, which
    // for a country shaped dataset on a square tile grid is most of the tiles
    // the map asks for. It is an answer, not a failure.
    const upstream = await http.stream(tileUrl.toString(), {
      timeoutMs: 60000,
      allowStatus: [404]
    })

    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', config.cacheControl.rasterTiles)

    if (upstream.statusCode === 404) {
      await upstream.body.dump()
      return res.status(200).end(EMPTY_TILE)
    }

    upstream.body.pipe(res)
  } catch (err) {
    next(err)
  }
})

/**
 * Build a TiTiler colormap from a contract palette.
 *
 * Categorical palettes map each code to its color directly, on raw values.
 *
 * Continuous palettes are expressed over 0 to 255, NOT over the band's own
 * range, and that is the whole subtlety of this function. TiTiler applies
 * `rescale` first, which linearly maps the display range onto 0 to 255, and only
 * then applies the colormap. Intervals written in data units therefore match
 * nothing at all: every pixel falls outside every interval and the tile comes
 * back transparent. It is a convincing failure, because the request is a 200
 * with a valid PNG in it, the COG is fine, and the same URL without the colormap
 * renders correctly.
 *
 * Rescaling first is also what makes the range clamp rather than drop out. The
 * DEM reaches 8526 m against a 5000 m ceiling, and those pixels saturate to the
 * last colour instead of turning into holes in the mountains.
 *
 * The step count matches the palette exactly, and the legend divides its own
 * range into the same number of blocks, so the nth colour on the map and the nth
 * block in the legend describe the same interval.
 */
function buildColormap (palette, min, max) {
  if (palette.kind === 'categorical') {
    return Object.fromEntries(palette.entries.map((e) => [e.code, hexToRgba(e.color)]))
  }

  // A classed palette that declares explicit class intervals in data units, the
  // Hotspot Mask being the one: it renders the CAR Index percentage but shows only
  // its top classes and leaves the rest transparent. The boundaries are exact
  // percents, not equal buckets, so they are converted to the 0..255 space TiTiler
  // colours in (rescale runs first) rather than divided evenly. Below the first
  // class is a transparent interval, so a cell under the threshold shows the map.
  if (Array.isArray(palette.classes)) {
    const lo = min ?? 0
    const hi = max ?? 100
    const to255 = (v) => Math.round(((v - lo) / (hi - lo)) * 255)
    const out = []
    if (palette.transparentBelow != null) {
      out.push([[0, to255(palette.transparentBelow)], [0, 0, 0, 0]])
    }
    palette.classes.forEach((c, i) => {
      const start = to255(c.min)
      // The last class closes at 256 for the same half-open reason as below, so the
      // single brightest value is not left uncoloured.
      const end = i === palette.classes.length - 1 ? 256 : to255(c.max)
      out.push([[start, end], hexToRgba(c.color)])
    })
    return out
  }

  const colors = palette.colors
  const span = 256 / colors.length

  return colors.map((color, i) => {
    const rgba = hexToRgba(color)
    // transparentFirst makes the lowest bucket see-through, so a dry or barely
    // wet cell shows the map beneath rather than a wash of the palette's palest
    // colour. Used by the rainfall palette. The legend mirrors it.
    if (i === 0 && palette.transparentFirst) rgba[3] = 0
    return [
      // The last interval closes at 256 rather than 255. The comparison is a half
      // open [start, stop), so stopping at 255 would leave the single brightest
      // value uncoloured: one transparent pixel exactly on the highest peaks.
      [Math.round(i * span), i === colors.length - 1 ? 256 : Math.round((i + 1) * span)],
      rgba
    ]
  })
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
