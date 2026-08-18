// The map. Mapbox GL JS.
//
// Two rules keep this component from turning into the 6,000 line file the old
// portal had:
//
//   1. Layers come from the contract. This file never names a layer.
//   2. The map instance lives in a ref, not in state. Putting a map object in
//      React state re-renders the tree on every pan.
//
// Data layers are added on 'style.load' and only there. That event fires on the
// first load and again after every setStyle, and a style change wipes every
// source and layer the map had, so this is the single point where they come
// back. Adding them from the effect as well is what broke the first version:
// setStyle diffs the incoming style against the live one and removes anything
// present on the map but absent from the style.

import { useCallback, useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

import { getWindField } from '@/lib/api'
import { mapboxToken, styleUrl } from '@/lib/basemaps'
import {
  DEFAULT_CENTER, DEFAULT_ZOOM,
  addRadarImage, addRasterLayer, addVectorLayer, applyLayerOrder, layerIdsFor, paintByScore,
  raiseSelectionOutlines, removeRadarImage, removeRasterLayer, resetPaint, setLayerOpacity,
  setLayerVisible, setRasterOpacity, setRasterTime
} from '@/lib/map'
import { removeWindBarbs, setWindBarbs } from '@/lib/windBarbs'

mapboxgl.accessToken = mapboxToken()

// Which cycle and lead a raster layer's tiles resolve against. An ordinary
// forecast layer follows the active model's cycle and the slider lead. A computed
// layer (the per pixel CAR Index, the hotspot mask) lives on the WRFPRS grid at a
// snapped lead, prepared out of band, so it uses the time the compute endpoint
// returned and shows nothing until that entry reads "ready".
function rasterTimeFor (def, computedTimes, creationTime, leadHours) {
  if (def.source === 'computed') {
    const c = computedTimes?.[def.id]
    if (!c || c.status !== 'ready') return null
    return { creationTime: c.creationTime, leadHours: c.leadHours }
  }
  return { creationTime, leadHours }
}

export default function MapView ({
  layers,
  rasterLayers = [],
  visibleLayers,
  opacities,
  basemap,
  projection,
  creationTime = null,
  leadHours = null,
  computedTimes = {},
  identify = false,
  choropleth = null,
  radarOverlays = [],
  radarRingColor,
  selection = null,
  layerOrder = null,
  onIdentify,
  onMapReady,
  onSelectFeature,
  onHoverFeature
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const hoveredRef = useRef(null)
  const selectedRef = useRef(null)
  const styledWithRef = useRef(null)
  const barbAbortRef = useRef(null)
  const renderBarbsRef = useRef(null)
  const applyChoroplethRef = useRef(null)
  const applyRadarRef = useRef(null)
  const radarOnMapRef = useRef(new Set())
  const applyOrderRef = useRef(null)
  const paintedRef = useRef(new Set())
  const [ready, setReady] = useState(false)
  const [failure, setFailure] = useState(null)

  // Latest props without re-running the init effect. The map is created once.
  const propsRef = useRef({ layers, rasterLayers, visibleLayers, opacities, creationTime, leadHours, computedTimes })
  propsRef.current = { layers, rasterLayers, visibleLayers, opacities, creationTime, leadHours, computedTimes }

  /** Put every contract layer on the map. Safe to call repeatedly. */
  const installLayers = useCallback(() => {
    const map = mapRef.current
    if (!map || !map.getStyle()) return
    const { layers: defs, rasterLayers: rasters, visibleLayers: visible, opacities: op,
      creationTime: ct, leadHours: lh, computedTimes: ctimes } = propsRef.current

    // Vectors first. Rasters are inserted beneath the lowest vector layer, so
    // there has to be one for them to go beneath.
    defs.forEach((def) => {
      addVectorLayer(map, def, visible.has(def.id))
      if (op[def.id] != null) setLayerOpacity(map, def, op[def.id])
    })

    rasters.forEach((def) => {
      if (!visible.has(def.id)) return
      const t = rasterTimeFor(def, ctimes, ct, lh)
      if (!t) return
      addRasterLayer(map, def, { opacity: op[def.id] ?? def.opacity, creationTime: t.creationTime, leadHours: t.leadHours })
    })

    // Every polygon layer's selection outline goes to the very top now that all
    // layers exist, so a selected boundary or choropleth cell is outlined above
    // everything and never painted over by a neighbour.
    raiseSelectionOutlines(map)
  }, [])

  // ------------------------------------------------------------- create once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const style = styleUrl(basemap)
    if (!mapboxgl.accessToken || !style) return

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      maxZoom: 16,
      attributionControl: false,
      // Right drag rotates. Needed for the compass control to be worth having.
      dragRotate: true,
      pitchWithRotate: true
    })

    mapRef.current = map
    styledWithRef.current = basemap

    // No Mapbox chrome at all. The scale bar and the attribution control are
    // both off at the project owner's request, so the bottom right corner is
    // clear. attributionControl: false above suppresses the control; the
    // wordmark is hidden in index.css, since Mapbox GL re-adds it on every
    // setStyle and there is no constructor option for it.
    //
    // Mapbox's terms of service require their attribution and wordmark to be
    // visible on a map that uses their tiles. This was removed on instruction,
    // so it is a deliberate choice by the project owner, not an oversight.

    // Fires on first load and after every setStyle.
    map.on('style.load', () => {
      installLayers()
      // A style rebuild drops our images, sources and layers, so the barb
      // overlay, the choropleth fill and the chosen stacking order all have to be
      // put back too. Each effect below owns the latest render and stashes it in a
      // ref for exactly this.
      applyOrderRef.current?.()
      renderBarbsRef.current?.()
      applyChoroplethRef.current?.()
      // A style rebuild drops the image sources too; forget what was on the map so
      // the radar effect re-adds every active frame rather than skipping them.
      radarOnMapRef.current = new Set()
      applyRadarRef.current?.()
      setReady(true)
      onMapReady?.(map)
    })

    // Without this a failing tile or a rejected token produces a blank map and
    // nothing else. Silent is the worst outcome: it looks identical to "no data
    // for this area", which is a real state this portal also has.
    map.on('error', (e) => {
      const message = e?.error?.message || 'Unknown map error'
      const status = e?.error?.status
      if (status === 404) return // an empty vector tile route is normal
      setFailure({ message, status, source: e?.sourceId })
    })

    return () => {
      // React 18 StrictMode mounts, unmounts and remounts every component in
      // development. Without clearing the ref the remount sees a live map and
      // returns early, leaving a removed map attached to a detached container
      // and a blank page.
      map.remove()
      mapRef.current = null
      styledWithRef.current = null
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------- interaction
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    // The identify tool owns the click while it is armed, so vector selection
    // and hover step aside rather than fighting it for the same click.
    if (identify) return

    const clickable = layers.filter((l) => l.clickable)
    const targets = clickable
      .flatMap((l) => layerIdsFor(l))
      .filter((id) => (id.endsWith('-fill') || id.endsWith('-circle')) && map.getLayer(id))
    if (!targets.length) return

    // One handler on the map, not one per layer.
    //
    // Every layer is clickable now, and they overlap: a point inside Lahore is
    // inside the district, the province and the country all at once. Per layer
    // handlers all fire for that single click, each overwriting the last, so
    // the selection landed on whichever handler happened to run last rather
    // than on what the user aimed at.
    //
    // queryRenderedFeatures returns hits in render order with the topmost
    // first, and the contract lists layers coarse to fine, so the topmost hit
    // is always the most specific thing under the cursor: tehsil over district,
    // district over province, province over country.
    // Filter to layers that currently exist. A basemap switch runs setStyle,
    // which drops every layer until the style.load handler re-adds them, and a
    // mousemove landing in that gap would query a layer id that is momentarily
    // gone. Mapbox answers that with a hard error ("layer '...' does not exist
    // in the map's style") that surfaces in the failure banner, so query only
    // what is on the map right now; the set fills back in after the rebuild.
    const topmostAt = (point) => {
      const present = targets.filter((id) => map.getLayer(id))
      if (!present.length) return null
      return map.queryRenderedFeatures(point, { layers: present })[0] ?? null
    }

    const clearHover = () => {
      if (hoveredRef.current) {
        map.setFeatureState(hoveredRef.current, { hover: false })
        hoveredRef.current = null
      }
    }

    const onMove = (e) => {
      const feature = topmostAt(e.point)

      if (!feature) {
        map.getCanvas().style.cursor = ''
        clearHover()
        onHoverFeature?.(null)
        return
      }

      map.getCanvas().style.cursor = 'pointer'
      const ref = { source: feature.source, sourceLayer: feature.sourceLayer, id: feature.id }
      if (hoveredRef.current?.id === ref.id && hoveredRef.current?.source === ref.source) return

      clearHover()
      if (ref.id != null) {
        map.setFeatureState(ref, { hover: true })
        hoveredRef.current = ref
      }
      onHoverFeature?.(feature.properties)
    }

    const onLeaveCanvas = () => {
      map.getCanvas().style.cursor = ''
      clearHover()
      onHoverFeature?.(null)
    }

    const onClick = (e) => {
      const feature = topmostAt(e.point)
      if (!feature) return

      if (selectedRef.current) map.setFeatureState(selectedRef.current, { selected: false })
      const ref = { source: feature.source, sourceLayer: feature.sourceLayer, id: feature.id }
      if (ref.id != null) {
        map.setFeatureState(ref, { selected: true })
        selectedRef.current = ref
      }

      const def = clickable.find((l) => layerIdsFor(l).includes(feature.layer.id))
      // feature.id carries the tile's own feature id, which for a points layer
      // is the row id promoted out of the properties by ST_AsMVT. The events card
      // scores by it, so pass it alongside the attributes.
      onSelectFeature?.({ layer: def, properties: feature.properties, featureId: feature.id })
    }

    map.on('mousemove', onMove)
    map.on('click', onClick)
    map.getCanvas().addEventListener('mouseout', onLeaveCanvas)

    return () => {
      map.off('mousemove', onMove)
      map.off('click', onClick)
      map.getCanvas().removeEventListener('mouseout', onLeaveCanvas)
    }
  }, [ready, layers, visibleLayers, onSelectFeature, onHoverFeature, identify])

  // Clear the highlight when the selection is dropped elsewhere. Closing the
  // card or switching view sets the App selection to null, but the selected
  // feature-state lives on the map, so without this the red outline and fill
  // linger after the card is gone. Clicking a new feature is handled in the
  // click handler above; this only mirrors an external clear.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    if (!selection && selectedRef.current) {
      map.setFeatureState(selectedRef.current, { selected: false })
      selectedRef.current = null
    }
  }, [ready, selection])

  // ------------------------------------------------------------- identify
  //
  // When armed, a click reads the topmost raster on the map at that point. The
  // topmost is the last raster in draw order: rasters are inserted just beneath
  // the vectors in the order they are switched on, so the most recently added is
  // the highest. The layer id maps straight back to a contract def upstream.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !identify) return

    const canvas = map.getCanvas()
    canvas.style.cursor = 'crosshair'

    const topRasterLayerId = () => {
      const style = map.getStyle()
      if (!style) return null
      const rasters = style.layers.filter((l) => l.type === 'raster' && l.id.startsWith('raster-'))
      const top = rasters[rasters.length - 1]
      return top ? top.id.slice('raster-'.length) : null
    }

    const onClick = (e) => {
      onIdentify?.({ layerId: topRasterLayerId(), lng: e.lngLat.lng, lat: e.lngLat.lat })
    }

    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
      canvas.style.cursor = ''
    }
  }, [ready, identify, onIdentify])

  // ------------------------------------------------------------- visibility
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    layers.forEach((def) => setLayerVisible(map, def, visibleLayers.has(def.id)))
  }, [ready, layers, visibleLayers])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    layers.forEach((def) => {
      if (opacities[def.id] != null) setLayerOpacity(map, def, opacities[def.id])
    })
  }, [ready, layers, opacities])

  // ------------------------------------------------------------- rasters
  //
  // Added and removed rather than hidden. A raster layer left on the map with
  // visibility none still holds its tiles, and these are full resolution
  // terrain, so an unused layer would sit on tens of megabytes of them.
  //
  // Opacity is applied separately, because addRasterLayer is idempotent and
  // re-adding a source to change one paint property would discard every tile the
  // browser had cached.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    rasterLayers.forEach((def) => {
      const t = visibleLayers.has(def.id) ? rasterTimeFor(def, computedTimes, creationTime, leadHours) : null
      if (t) {
        addRasterLayer(map, def, { opacity: opacities[def.id] ?? def.opacity, creationTime: t.creationTime, leadHours: t.leadHours })
      } else {
        // A computed layer that is toggled on but not ready yet resolves to no
        // time and is removed until its COG lands, then this effect re-adds it.
        removeRasterLayer(map, def.id)
      }
    })
  }, [ready, rasterLayers, visibleLayers, opacities, creationTime, leadHours, computedTimes])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    rasterLayers.forEach((def) => {
      if (opacities[def.id] != null) setRasterOpacity(map, def.id, opacities[def.id])
    })
  }, [ready, rasterLayers, opacities])

  // ------------------------------------------------------------- forecast time
  //
  // Moving the slider swaps the tile template on each visible temporal source
  // rather than rebuilding it, so scrubbing hours keeps the layer, its stack
  // position and its opacity and only the pixels change.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    rasterLayers.forEach((def) => {
      if (!def.temporal || !visibleLayers.has(def.id)) return
      const t = rasterTimeFor(def, computedTimes, creationTime, leadHours)
      if (t && t.creationTime != null && t.leadHours != null) {
        setRasterTime(map, def, { creationTime: t.creationTime, leadHours: t.leadHours })
      }
    })
  }, [ready, rasterLayers, visibleLayers, creationTime, leadHours, computedTimes])

  // ------------------------------------------------------------- wind barbs
  //
  // A layer flagged `barbs` in the contract (the GFS wind layer) draws a
  // directional overlay on top of its speed raster. The barbs need the wind
  // vectors, so this fetches a coarse u/v grid from the API for the active
  // model, cycle and lead, and refetches when any of those change; scrubbing the
  // slider reorients the whole field. The render is stored in a ref so the
  // style.load handler can rebuild it after a basemap switch.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const def = rasterLayers.find((l) => l.barbs && visibleLayers.has(l.id))

    const render = async () => {
      const m = mapRef.current
      if (!m) return
      if (!def || creationTime == null || leadHours == null) {
        removeWindBarbs(m)
        return
      }
      barbAbortRef.current?.abort()
      const ac = new AbortController()
      barbAbortRef.current = ac
      try {
        const fc = await getWindField(def.model, creationTime, leadHours, ac.signal)
        if (ac.signal.aborted || !mapRef.current) return
        setWindBarbs(mapRef.current, fc)
      } catch (err) {
        if (err.name !== 'AbortError') removeWindBarbs(mapRef.current)
      }
    }

    renderBarbsRef.current = render
    render()

    return () => barbAbortRef.current?.abort()
  }, [ready, rasterLayers, visibleLayers, creationTime, leadHours])

  // ------------------------------------------------------------- choropleth
  //
  // In the Analysis view a layer is coloured by CARI class instead of its own
  // outline colour. The join is client side, a match expression on the layer's
  // key field, so the score endpoints stay geometry free. The applied paint is
  // stashed in a ref so a basemap rebuild, which drops the paint with the layer,
  // can put it straight back from the style.load handler above.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const apply = () => {
      const m = mapRef.current
      if (!m || !m.getStyle()) return
      const active = choropleth ?? {}

      // Reset any layer that was painted and no longer is.
      for (const layerId of paintedRef.current) {
        if (!active[layerId]) {
          const def = layers.find((l) => l.id === layerId)
          if (def) resetPaint(m, def)
        }
      }

      const painted = new Set()
      for (const [layerId, entry] of Object.entries(active)) {
        if (!entry?.byKey) continue
        paintByScore(m, layerId, entry.byKey, (color) => color, entry.keyField)
        painted.add(layerId)
      }
      paintedRef.current = painted
    }

    applyChoroplethRef.current = apply
    apply()
  }, [ready, choropleth, layers])

  // ------------------------------------------------------------------- radar
  //
  // Live radar frames are image overlays, reconciled against the desired set:
  // add a newly toggled layer, swap the picture when a frame refreshes, and drop
  // one that was turned off. Stashed in a ref so the style.load handler can put
  // every active frame back after a basemap change, which wipes image sources.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const apply = () => {
      const m = mapRef.current
      if (!m || !m.getStyle()) return

      const want = new Map(radarOverlays.map((o) => [o.id, o]))
      for (const id of radarOnMapRef.current) {
        if (!want.has(id)) {
          removeRadarImage(m, id)
          radarOnMapRef.current.delete(id)
        }
      }
      for (const o of radarOverlays) {
        // addRadarImage adds on first sight and swaps the image on later calls, so
        // a refreshed frame updates in place without dropping the layer.
        addRadarImage(m, o.id, {
          imageUrl: o.imageUrl,
          coordinates: o.coordinates,
          opacity: o.opacity ?? 0.85,
          ring: o.ring,
          ringColor: radarRingColor
        })
        radarOnMapRef.current.add(o.id)
      }
    }

    applyRadarRef.current = apply
    apply()
  }, [ready, radarOverlays, radarRingColor])

  // ------------------------------------------------------------- layer order
  //
  // The order dock hands down a top-first list of vector layer ids. This resolves
  // them to their contract defs and restacks the map so the top of the dock is the
  // top of the map. Stashed in a ref so a basemap rebuild reapplies it too.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const apply = () => {
      const m = mapRef.current
      if (!m || !m.getStyle() || !layerOrder?.length) return
      const byId = new Map(propsRef.current.layers.map((l) => [l.id, l]))
      applyLayerOrder(m, layerOrder.map((id) => byId.get(id)).filter(Boolean))
    }

    applyOrderRef.current = apply
    apply()
  }, [ready, layerOrder])

  // ------------------------------------------------------------- basemap
  //
  // A basemap change rebuilds the whole style, which drops our sources and
  // re-adds them from the style.load handler above. That is unavoidable, and it
  // was worth proving rather than assuming.
  //
  // The obvious optimisation is to fetch the incoming style as a document,
  // append our sources and layers to it, and let setStyle diff the result: our
  // entries appear unchanged on both sides, so the diff should leave them and
  // their tile cache alone. That was implemented and measured, and Mapbox
  // rejects it:
  //
  //     Unable to perform style diff: Unimplemented: setSprite.
  //     Rebuilding the style from scratch.
  //
  // Every basemap ships its own sprite, Mapbox GL 3 cannot diff a sprite
  // change, so any switch between two different basemaps falls back to a full
  // rebuild. Keeping the old sprite would make the diff succeed and render the
  // new basemap's icons wrong, which is not a trade worth making. The merge was
  // removed again: it cost an extra request for the style document and changed
  // nothing.
  //
  // What this actually costs, measured: 8 vector tile requests, all served from
  // the browser cache, 0 bytes from the network. Tiles carry max-age 86400 from
  // the gateway, so a basemap switch never reaches the backend.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    // Only on a real change. The map was created with this basemap, so calling
    // setStyle on mount was pure damage.
    if (styledWithRef.current === basemap) return
    styledWithRef.current = basemap

    // diff: false because the diff can never succeed here. Mapbox attempts one,
    // fails on the sprite, warns "Unable to perform style diff: Unimplemented:
    // setSprite. Rebuilding the style from scratch." and rebuilds anyway. Saying
    // so up front skips the wasted attempt and the console noise with it.
    const url = styleUrl(basemap)
    if (url) map.setStyle(url, { diff: false })
  }, [ready, basemap])

  // ------------------------------------------------------------- projection
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    map.setProjection(projection)
  }, [ready, projection])

  return (
    <>
      <div ref={containerRef} className="absolute inset-0" />

      {failure && (
        <div className="pointer-events-auto absolute left-1/2 top-4 z-20 w-[420px] max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-cb border border-danger-border bg-danger-soft px-3.5 py-2.5 shadow-cb-lg">
          <p className="text-[12.5px] font-semibold text-danger">The map could not load a resource</p>
          <p className="mt-1 break-words text-[11.5px] leading-snug text-text-2">
            {failure.message}
            {failure.status ? ` (HTTP ${failure.status})` : ''}
            {failure.source ? ` from source "${failure.source}"` : ''}
          </p>
          <button
            type="button"
            onClick={() => setFailure(null)}
            className="mt-2 text-[11px] font-medium text-danger underline underline-offset-2"
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  )
}
