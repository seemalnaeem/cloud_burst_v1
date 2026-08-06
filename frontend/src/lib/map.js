// MapLibre helpers.
//
// Layer construction is driven entirely by shared/contracts/layers.json, so
// adding a layer is a JSON edit rather than a component change. If you find
// yourself adding a special case here, the contract is missing a field. Add the
// field instead.
//
// Every layer's colour comes from one place, def.color. The fill, the outline
// and the legend swatch all read it, which is what stops a legend from quietly
// disagreeing with the map it describes.

import { rasterTileUrl, vectorTileUrl } from './api.js'

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

/** Every map layer id a contract layer owns, for visibility and hit testing. */
export function layerIdsFor (def) {
  return def.geometryType === 'point'
    ? [circleId(def.id)]
    : [fillId(def.id), lineId(def.id)]
}

/** Add a vector layer from its contract definition. */
export function addVectorLayer (map, def, visible) {
  const src = sourceId(def.id)

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

  const paint = def.paint ?? {}

  if (def.geometryType === 'point') {
    if (!map.getLayer(circleId(def.id))) {
      map.addLayer({
        id: circleId(def.id),
        type: 'circle',
        ...common,
        paint: {
          // Grow slightly with zoom so the dots stay findable when zoomed out
          // and do not turn into blobs when zoomed in.
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            4, (paint.circleRadius ?? 6) * 0.7,
            10, paint.circleRadius ?? 6,
            14, (paint.circleRadius ?? 6) * 1.5
          ],
          'circle-color': def.color,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': paint.circleStrokeWidth ?? 1.5,
          'circle-opacity': 0.95
        }
      })
    }
    return
  }

  // Fill below line, so a boundary stays crisp over its own fill.
  if (!map.getLayer(fillId(def.id))) {
    map.addLayer({
      id: fillId(def.id),
      type: 'fill',
      ...common,
      paint: {
        'fill-color': def.color,
        // Feature state lets hover change opacity without re-rendering the
        // source, which on the district layer is the difference between smooth
        // and visibly stuttering.
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'hover'], false],
          Math.min(0.85, (paint.fillOpacity ?? 0.12) + 0.28),
          ['boolean', ['feature-state', 'selected'], false],
          Math.min(0.85, (paint.fillOpacity ?? 0.12) + 0.4),
          paint.fillOpacity ?? 0.12
        ]
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
        'line-color': def.color,
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          (paint.lineWidth ?? 1) + 1.6,
          ['boolean', ['feature-state', 'hover'], false],
          (paint.lineWidth ?? 1) + 0.8,
          paint.lineWidth ?? 1
        ],
        'line-opacity': 0.95,
        ...(paint.lineDasharray ? { 'line-dasharray': paint.lineDasharray } : {})
      }
    })
  }
}

/** Add or replace a raster layer. */
export function addRasterLayer (map, layerId, options) {
  const id = `raster-${layerId}`
  const src = `src-${id}`

  removeRasterLayer(map, layerId)

  map.addSource(src, {
    type: 'raster',
    tiles: [rasterTileUrl(layerId, options)],
    tileSize: 256
  })

  // Rasters go beneath every vector layer so boundaries stay readable over a
  // heat map. beforeId is the lowest data layer currently on the map.
  const first = map.getStyle().layers.find((l) => l.id.endsWith('-fill') || l.id.endsWith('-circle'))

  map.addLayer(
    { id, type: 'raster', source: src, paint: { 'raster-opacity': options?.opacity ?? 0.75 } },
    first?.id
  )
}

export function removeRasterLayer (map, layerId) {
  const id = `raster-${layerId}`
  if (map.getLayer(id)) map.removeLayer(id)
  if (map.getSource(`src-${id}`)) map.removeSource(`src-${id}`)
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

  const expression = ['match', ['get', keyField]]
  entries.forEach(([key, score]) => {
    expression.push(key, colorFor(score))
  })
  expression.push('rgba(148, 163, 184, 0.25)') // no data

  map.setPaintProperty(id, 'fill-color', expression)
  map.setPaintProperty(id, 'fill-opacity', 0.75)
}

/** Put a layer back on its own contract colour. */
export function resetPaint (map, def) {
  const id = fillId(def.id)
  if (!map.getLayer(id)) return
  map.setPaintProperty(id, 'fill-color', def.color)
  map.setPaintProperty(id, 'fill-opacity', def.paint?.fillOpacity ?? 0.12)
}

export function fitToBounds (map, bounds, padding = 48) {
  map.fitBounds(bounds, { padding, duration: 700 })
}

export function fitToExtent (map, extent, padding = 64) {
  if (!extent) return
  fitToBounds(map, [[extent.west, extent.south], [extent.east, extent.north]], padding)
}
