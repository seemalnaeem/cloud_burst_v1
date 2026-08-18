// Mapbox GL helpers.
//
// Layer construction is driven entirely by shared/contracts/layers.json, so
// adding a layer is a JSON edit rather than a component change. If you find
// yourself adding a special case here, the contract is missing a field. Add the
// field instead.
//
// Every layer's colour comes from one place, def.color. The fill, the outline
// and the legend swatch all read it, which is what stops a legend from quietly
// disagreeing with the map it describes.

import { eventsGeoJsonUrl, rasterTileUrl, vectorTileUrl } from './api.js'

// Pakistan, generously. Used for the initial view and for the reset control.
export const DEFAULT_BOUNDS = [
  [60.5, 23.0],
  [78.0, 37.5]
]

export const DEFAULT_CENTER = [69.3, 30.4]
export const DEFAULT_ZOOM = 4.6

export const sourceId = (layerId) => `src-${layerId}`
export const fillId = (layerId) => `${layerId}-fill`
export const lineId = (layerId) => `${layerId}-line`
export const circleId = (layerId) => `${layerId}-circle`
// A second line per polygon layer, drawn on top of every layer, that shows only
// the selected feature. It exists because a thin selection outline on the normal
// line layer gets painted over by neighbouring features along shared edges, so it
// only appears on some borders. Lifting the selected outline into its own top
// layer lets it stay thin and still read all the way round.
export const selLineId = (layerId) => `${layerId}-sel`

/** Every map layer id a contract layer owns, for visibility and hit testing. */
export function layerIdsFor (def) {
  return def.geometryType === 'point'
    ? [circleId(def.id)]
    : [fillId(def.id), lineId(def.id), selLineId(def.id)]
}

// Selection is drawn in one fixed red for every layer, a red that is not any
// layer's own hue, so a picked polygon reads the same whether it is a boundary in
// the Map view or a choropleth cell in Analysis. The fill is a semi opaque wash of
// it and the outline is a thin full opacity line of it, drawn on its own top
// layer so it is never painted over: colour carries the selection, not weight.
const SELECT_COLOR = '#e11d1d'
const SELECT_OUTLINE_WIDTH = 2.2  // thin, but always on top so always visible
const SELECT_FILL_MAP = 0.32      // over the light Map view fill
const SELECT_FILL_ANALYSIS = 0.72 // matches the choropleth density in Analysis

// The fill colour for a polygon: the layer's own colour, turning to the selection
// maroon when the feature is selected. Shared with resetPaint so leaving the
// Analysis choropleth restores the selectable behaviour rather than a flat colour.
function fillColorExpr (baseColor) {
  return [
    'case',
    ['boolean', ['feature-state', 'selected'], false], SELECT_COLOR,
    baseColor
  ]
}

// The fill opacity for a polygon layer, as a feature-state expression. Polygon
// layers carry no fill of their own: the boundary is the outline, and the fill is
// transparent until the polygon is selected, when it takes the red selection
// wash. Hover is shown on the outline, not with a fill. Shared by addVectorLayer
// and resetPaint so a return from the choropleth restores the same behaviour.
function fillOpacityExpr () {
  return [
    'case',
    ['boolean', ['feature-state', 'selected'], false], SELECT_FILL_MAP,
    0
  ]
}


/** Add a vector layer from its contract definition. */
export function addVectorLayer (map, def, visible) {
  const src = sourceId(def.id)
  const paint = def.paint ?? {}

  // Points are served as GeoJSON, not vector tiles, by deliberate exception. The
  // events layer is a couple of dozen features, so a GeoJSON source holds them
  // all client side and draws them at every zoom with no tiling at all. That
  // sidesteps the overzoom that silently drops a vector-tile point layer at some
  // zooms. Polygons stay on tiles, where their vertex counts make tiling
  // essential. The endpoint sets each feature's id, so feature-state (hover and
  // selection) works exactly as it does for the tiled layers.
  if (def.geometryType === 'point') {
    if (!map.getSource(src)) {
      map.addSource(src, { type: 'geojson', data: eventsGeoJsonUrl() })
    }
    if (!map.getLayer(circleId(def.id))) {
      const baseR = paint.circleRadius ?? 6
      const baseStroke = paint.circleStrokeWidth ?? 1.5
      map.addLayer({
        id: circleId(def.id),
        type: 'circle',
        source: src,
        minzoom: def.minzoom ?? 0,
        maxzoom: def.maxzoom ?? 22,
        layout: { visibility: visible ? 'visible' : 'none' },
        paint: {
          // Radius is a pure zoom curve: the dots stay findable when zoomed out
          // and do not turn into blobs when zoomed in. It deliberately carries no
          // feature-state, because a single property may not combine a zoom curve
          // with feature-state; doing so renders once and then drops the layer the
          // moment the zoom changes. Hover and selection are shown on the ring and
          // the opacity instead, which are feature-state only.
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            4, baseR * 0.7,
            10, baseR,
            14, baseR * 1.5
          ],
          'circle-color': def.color,
          // A white ring keeps every dot legible over a dark basemap and the
          // terrain, and thickens to mark hover and selection.
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], baseStroke + 2.2,
            ['boolean', ['feature-state', 'hover'], false], baseStroke + 1,
            baseStroke
          ],
          'circle-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false], 1,
            ['boolean', ['feature-state', 'hover'], false], 1,
            0.9
          ],
          'circle-stroke-opacity': 1
        }
      })
    }
    return
  }

  // Polygons and lines come from vector tiles. 14 is plenty because they
  // overzoom cleanly, and it keeps the vertex heavy admin tiles from being
  // refetched at every step.
  if (!map.getSource(src)) {
    map.addSource(src, {
      type: 'vector',
      tiles: [vectorTileUrl(def.id)],
      minzoom: 0,
      maxzoom: 14,
      // Spread, so the key is absent rather than present-and-undefined when a
      // layer has no join key. The style validator rejects an undefined
      // promoteId outright, and the source then fails to be created at all:
      // the visible symptom is the layer that follows complaining its source
      // does not exist, which points nowhere near the real cause.
      ...(def.joinKey ? { promoteId: def.joinKey } : {})
    })
  }

  const common = {
    source: src,
    'source-layer': def.sourceLayer,
    minzoom: def.minzoom ?? 0,
    maxzoom: def.maxzoom ?? 22,
    layout: { visibility: visible ? 'visible' : 'none' }
  }

  // Fill below line, so a boundary stays crisp over its own fill.
  if (!map.getLayer(fillId(def.id))) {
    map.addLayer({
      id: fillId(def.id),
      type: 'fill',
      ...common,
      paint: {
        // Own colour normally, maroon when selected. Feature state changes it
        // without re-rendering the source, which on the districts is the
        // difference between smooth and visibly stuttering.
        'fill-color': fillColorExpr(def.color),
        'fill-opacity': fillOpacityExpr()
      }
    })
  }

  if (!map.getLayer(lineId(def.id))) {
    map.addLayer({
      id: lineId(def.id),
      type: 'line',
      ...common,
      layout: { ...common.layout, 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        // The layer's own boundary. Hover nudges it a touch; selection is not
        // drawn here at all, because on this layer it is painted over by
        // neighbouring features along shared edges. It is drawn on the top
        // selection layer below instead.
        'line-color': def.color,
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          (paint.lineWidth ?? 1) + 0.5,
          paint.lineWidth ?? 1
        ],
        'line-opacity': 0.95,
        ...(paint.lineDasharray ? { 'line-dasharray': paint.lineDasharray } : {})
      }
    })
  }

  // The selection outline, on its own layer so nothing paints over it. It shows
  // only the selected feature (zero width and opacity otherwise) as a thin red
  // line, and installLayers lifts it above every other layer once they are all
  // added, so a picked polygon is outlined cleanly all the way round in both the
  // Map and the Analysis view.
  if (!map.getLayer(selLineId(def.id))) {
    map.addLayer({
      id: selLineId(def.id),
      type: 'line',
      ...common,
      layout: { ...common.layout, 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': SELECT_COLOR,
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], SELECT_OUTLINE_WIDTH,
          0
        ],
        'line-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 1,
          0
        ]
      }
    })
  }
}

/** Lift every selection outline above all other layers, so nothing covers it. */
export function raiseSelectionOutlines (map) {
  const style = map.getStyle()
  if (!style) return
  style.layers
    .filter((l) => l.id.endsWith('-sel'))
    .forEach((l) => map.moveLayer(l.id))
}

/**
 * Reorder the vector layers on the map from a top-first list of contract defs.
 *
 * The first def is drawn highest, so the top of the order dock is the top of the
 * map. Moving each layer's base parts to the very top from the bottom of the list
 * upward leaves the first one on top; rasters are never moved so they stay beneath
 * the vectors, and the basemap, which owns the bottom of the style, stays there.
 * Selection outlines are lifted back above everything at the end.
 */
export function applyLayerOrder (map, orderedDefsTopFirst) {
  if (!map || !map.getStyle()) return
  for (let i = orderedDefsTopFirst.length - 1; i >= 0; i--) {
    const def = orderedDefsTopFirst[i]
    if (!def) continue
    if (def.geometryType === 'point') {
      if (map.getLayer(circleId(def.id))) map.moveLayer(circleId(def.id))
    } else {
      // Fill first, then line, so the outline stays above the fill within a layer.
      if (map.getLayer(fillId(def.id))) map.moveLayer(fillId(def.id))
      if (map.getLayer(lineId(def.id))) map.moveLayer(lineId(def.id))
    }
  }
  raiseSelectionOutlines(map)
}

export const rasterId = (layerId) => `raster-${layerId}`

/**
 * The tile template for a raster layer at a moment in time.
 *
 * A band is sent only for a band driven layer. A cycle and a lead are sent only
 * for a temporal layer, and they are what make the same layer show a different
 * hour when the time slider moves. Everything else about the tile, the display
 * range, the palette, the resampling, is decided server side from the contract,
 * so the browser cannot ask for a tile the legend does not describe.
 */
export function rasterTemplate (def, { band, creationTime, leadHours } = {}) {
  return rasterTileUrl(def.id, {
    band: def.bandDriven ? band : undefined,
    // A forecast layer carries its model in the contract, so the tile resolves
    // against the right run without the caller having to thread it.
    model: def.model,
    creationTime: def.temporal ? creationTime : undefined,
    leadHours: def.temporal ? leadHours : undefined,
    // Cache discriminator so a palette change is not masked by cached tiles.
    style: def.palette
  })
}

/**
 * Add a raster layer, or leave it alone if it is already there.
 *
 * Idempotent on purpose. The obvious version removed and re-added the layer on
 * every call, which threw away the source and with it every tile the browser
 * had: dragging an opacity slider re-fetched the whole visible extent on each
 * frame. Opacity is a paint property and belongs in setRasterOpacity; moving
 * through time belongs in setRasterTime.
 */
export function addRasterLayer (map, def, options = {}) {
  const id = rasterId(def.id)
  const src = `src-${id}`

  if (map.getLayer(id)) {
    setRasterOpacity(map, def.id, options.opacity ?? def.opacity ?? 0.8)
    return
  }

  if (!map.getSource(src)) {
    map.addSource(src, {
      type: 'raster',
      tiles: [rasterTemplate(def, options)],
      tileSize: 256
    })
  }

  // Rasters go beneath every vector layer so boundaries stay readable over a
  // heat map. beforeId is the lowest vector data layer currently on the map.
  const first = map.getStyle().layers.find((l) => l.id.endsWith('-fill') || l.id.endsWith('-circle'))

  map.addLayer(
    {
      id,
      type: 'raster',
      source: src,
      paint: {
        'raster-opacity': options.opacity ?? def.opacity ?? 0.8,
        // Nearest at high zoom, so a 30 m DEM shows its own pixels instead of a
        // smoothed guess at what is between them.
        'raster-resampling': 'linear',
        'raster-fade-duration': 200
      }
    },
    first?.id
  )
}

export function removeRasterLayer (map, layerId) {
  const id = rasterId(layerId)
  if (map.getLayer(id)) map.removeLayer(id)
  if (map.getSource(`src-${id}`)) map.removeSource(`src-${id}`)
}

export function setRasterOpacity (map, layerId, opacity) {
  const id = rasterId(layerId)
  if (map.getLayer(id)) map.setPaintProperty(id, 'raster-opacity', opacity)
}

/**
 * Point a temporal raster layer at a different cycle or lead.
 *
 * setTiles swaps the URL template on the live source, so Mapbox refetches the
 * visible tiles for the new hour and keeps the layer, its position and its
 * opacity. Removing and re-adding the layer would flash and lose the stack
 * order; this just changes what the same layer is showing.
 */
export function setRasterTime (map, def, { creationTime, leadHours } = {}) {
  const src = map.getSource(`src-${rasterId(def.id)}`)
  if (src?.setTiles) src.setTiles([rasterTemplate(def, { creationTime, leadHours })])
}

// ------------------------------------------------------------------- radar
//
// Radar frames are single georeferenced PNGs, not tiles, so they ride on an
// image source pinned to four corners rather than a tile template. The frame
// refreshes every few minutes; updateImage swaps the picture on the live source
// without dropping the layer or its place in the stack. Like the other rasters
// they sit beneath the vector layers so boundaries and labels read over them.
// The range ring is the coverage circle the source draws around each site, drawn
// here as our own line rather than baked into the image.

const radarKey = (id) => id.replace(/[^a-z0-9]/gi, '-')
const radarSrcId = (id) => `src-radar-${radarKey(id)}`
const radarLayerId = (id) => `radar-${radarKey(id)}`
const radarRingSrcId = (id) => `src-radarring-${radarKey(id)}`
const radarRingLayerId = (id) => `radarring-${radarKey(id)}`

export function addRadarImage (map, id, { imageUrl, coordinates, opacity = 0.85, ring = null, ringColor }) {
  const src = radarSrcId(id)
  if (map.getSource(src)) {
    updateRadarImage(map, id, { imageUrl, coordinates })
  } else {
    map.addSource(src, { type: 'image', url: imageUrl, coordinates })
    const first = map.getStyle().layers.find((l) => l.id.endsWith('-fill') || l.id.endsWith('-circle'))
    map.addLayer(
      {
        id: radarLayerId(id),
        type: 'raster',
        source: src,
        paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' }
      },
      first?.id
    )
  }
  if (ring) setRadarRing(map, id, ring, ringColor)
}

export function updateRadarImage (map, id, { imageUrl, coordinates }) {
  const src = map.getSource(radarSrcId(id))
  if (!src?.updateImage) return
  src.updateImage(coordinates ? { url: imageUrl, coordinates } : { url: imageUrl })
}

export function setRadarOpacity (map, id, opacity) {
  const layer = radarLayerId(id)
  if (map.getLayer(layer)) map.setPaintProperty(layer, 'raster-opacity', opacity)
}

export function removeRadarImage (map, id) {
  if (map.getLayer(radarLayerId(id))) map.removeLayer(radarLayerId(id))
  if (map.getSource(radarSrcId(id))) map.removeSource(radarSrcId(id))
  removeRadarRing(map, id)
}

export function setRadarRing (map, id, geojson, color = 'rgba(20,24,31,0.6)') {
  const src = radarRingSrcId(id)
  const layer = radarRingLayerId(id)
  if (map.getSource(src)) {
    map.getSource(src).setData(geojson)
    // The colour follows the basemap (white over a dark style, dark otherwise),
    // so an existing ring repaints rather than keeping its first colour.
    if (map.getLayer(layer)) map.setPaintProperty(layer, 'line-color', color)
    return
  }
  map.addSource(src, { type: 'geojson', data: geojson })
  map.addLayer({
    id: layer,
    type: 'line',
    source: src,
    paint: { 'line-color': color, 'line-width': 1.5, 'line-opacity': 0.75 }
  })
}

export function removeRadarRing (map, id) {
  if (map.getLayer(radarRingLayerId(id))) map.removeLayer(radarRingLayerId(id))
  if (map.getSource(radarRingSrcId(id))) map.removeSource(radarRingSrcId(id))
}

export function setLayerVisible (map, def, visible) {
  layerIdsFor(def).forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
    }
  })
}

export function setLayerOpacity (map, def, opacity) {
  const base = def.paint?.fillOpacity ?? 0.12
  if (def.geometryType === 'point') {
    if (map.getLayer(circleId(def.id))) {
      map.setPaintProperty(circleId(def.id), 'circle-opacity', opacity)
    }
    return
  }
  if (map.getLayer(fillId(def.id))) {
    map.setPaintProperty(fillId(def.id), 'fill-opacity', base * opacity)
  }
  if (map.getLayer(lineId(def.id))) {
    map.setPaintProperty(lineId(def.id), 'line-opacity', opacity)
  }
}

/**
 * Paint districts by a score.
 *
 * Scores arrive keyed by district and the geometry is already in the browser
 * from vector tiles, so this joins them client side with a match expression.
 * That is the entire reason the score endpoints return no geometry.
 */
export function paintByScore (map, layerId, scoresByKey, colorFor, keyField = 'district_code') {
  const entries = Object.entries(scoresByKey ?? {})
  const id = fillId(layerId)
  if (!map.getLayer(id)) return

  if (!entries.length) return

  const match = ['match', ['get', keyField]]
  entries.forEach(([key, score]) => {
    match.push(key, colorFor(score))
  })
  match.push('rgba(148, 163, 184, 0.25)') // no data

  // The choropleth colours the fill, but a selected cell overrides that with the
  // same maroon used everywhere else, at the choropleth's own density, so it
  // reads as a solid maroon patch under the thin maroon outline. Same selection
  // look as the Map view, just over the scored fill instead of the plain one.
  map.setPaintProperty(id, 'fill-color', [
    'case',
    ['boolean', ['feature-state', 'selected'], false], SELECT_COLOR,
    match
  ])
  map.setPaintProperty(id, 'fill-opacity', [
    'case',
    ['boolean', ['feature-state', 'selected'], false], SELECT_FILL_ANALYSIS,
    0.72
  ])
}

/** Put a layer back on its own contract colour. */
export function resetPaint (map, def) {
  const id = fillId(def.id)
  if (!map.getLayer(id)) return
  // Restore the feature-state expressions, not flat values, so hover and the
  // maroon selection keep working after a return from the Analysis choropleth.
  map.setPaintProperty(id, 'fill-color', fillColorExpr(def.color))
  map.setPaintProperty(id, 'fill-opacity', fillOpacityExpr())
}

export function fitToBounds (map, bounds, padding = 48) {
  map.fitBounds(bounds, { padding, duration: 700 })
}

export function fitToExtent (map, extent, padding = 64) {
  if (!extent) return
  fitToBounds(map, [[extent.west, extent.south], [extent.east, extent.north]], padding)
}
