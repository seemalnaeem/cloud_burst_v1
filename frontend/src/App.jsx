// App shell.
//
// The map is the application, so it occupies the whole area below the navbar
// and every panel floats over it in a dock. Docks are positioned by a grid of
// pointer-events-none rails, which means the gaps between panels stay part of
// the map and remain draggable. Absolutely positioned panels that swallow
// clicks in their margins are the usual way this goes wrong.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TbAlertTriangle, TbCloudStorm } from 'react-icons/tb'

import CariCard from '@/components/CariCard'
import EventCard from '@/components/EventCard'
import FeaturePanel from '@/components/FeaturePanel'
import ForecastChartPanel from '@/components/ForecastChartPanel'
import LayersPanel from '@/components/LayersPanel'
import MapControls from '@/components/MapControls'
import Navbar from '@/components/Navbar'
import RasterPanel from '@/components/RasterPanel'
import StatusBanner from '@/components/StatusBanner'
import TimeSlider from '@/components/TimeSlider'
import MapView from '@/features/map/MapView'
import { useCariChoropleth } from '@/hooks/useCariChoropleth'
import { useWarmTimeline } from '@/hooks/useWarmTimeline'
import { useRadarFrames } from '@/hooks/useRadarFrames'
import { useContracts } from '@/hooks/useContracts'
import { useComputedRasters } from '@/hooks/useComputedRasters'
import { useForecast } from '@/hooks/useForecast'
import { useRasterAvailability } from '@/hooks/useRasterAvailability'
import { useRasterPrefetch } from '@/hooks/useRasterPrefetch'
import { useTheme } from '@/hooks/useTheme'
import { getLayerExtent, getRasterPoint } from '@/lib/api'
import { availableBasemaps, defaultBasemapId, findBasemap, hasMapboxToken } from '@/lib/basemaps'
import { cariClasses, contracts, radarBounds, radarLayers, radarRing, rasterScale } from '@/lib/contracts'
import { DEFAULT_BOUNDS, fitToBounds, fitToExtent } from '@/lib/map'
import { getStored, setStored } from '@/lib/storage'

// Feature counts for the layer rows. Known from the ingest, and worth showing
// because "Tehsils 553" tells you the layer loaded and "Tehsils 0" tells you it
// did not, without opening a console.
const COUNTS = {
  pak_national: 2,
  pak_provinces: 8,
  pak_districts: 188,
  pak_tehsils: 553,
  iiojk_districts: 22
}

// The administrative layers the Analysis view scores, and how each joins to its
// choropleth. kind picks the scoring endpoint; keyField is the tile property the
// class colours match on, unique per feature. More analysis layers land here.
const CARI_LAYER_CONFIG = [
  { id: 'pak_districts', kind: 'district', keyField: 'district_name' },
  { id: 'pak_tehsils', kind: 'tehsil', keyField: 'tehsil_code' }
]

// Which boundary layer maps to which forecast-chart region kind, and the property
// that keys it. Districts join by name, tehsils by their unique code, IIOJK
// districts by district_code (the name is not unique across the Line of Control).
const REGION_KIND = { pak_districts: 'district', pak_tehsils: 'tehsil', iiojk_districts: 'iiojk' }

// Boundary layers to leave out of the layers panel. The IIOJK districts are
// already carried by the ordinary districts layer, so a separate toggle only
// duplicates them.
const HIDDEN_LAYERS = new Set(['iiojk_districts'])

function Splash ({ children }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg p-8">
      {children}
    </div>
  )
}

export default function App () {
  const contractState = useContracts()
  const { isDark, toggle: toggleTheme } = useTheme()

  const [view, setView] = useState('map')
  const [map, setMap] = useState(null)
  // Layer state is restored from a previous visit. visibleLayers is seeded in an
  // effect once the contract is known, so its stored set can be validated against
  // the layers that still exist; the rest restore directly and are pruned by
  // their consumers if a key has gone stale.
  const [visibleLayers, setVisibleLayers] = useState(new Set())
  const [opacities, setOpacities] = useState(() => getStored('opacities', {}))
  const [selection, setSelection] = useState(null)
  const [basemap, setBasemap] = useState(() => getStored('basemap', null))
  const [projection, setProjection] = useState('mercator')
  const [layersCollapsed, setLayersCollapsed] = useState(false)
  // The vector layers' stacking, top-first (index 0 draws on top of the map).
  const [layerOrder, setLayerOrder] = useState(() => getStored('layerOrder', null))
  const [panelsOpen, setPanelsOpen] = useState(true)
  const [leadIndex, setLeadIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [activeModelId, setActiveModelId] = useState(() => getStored('activeModelId', null))
  const [levelChoice, setLevelChoice] = useState(() => getStored('levelChoice', {}))
  const [identify, setIdentify] = useState(false)
  const [rasterSelection, setRasterSelection] = useState(null)
  // The region whose forecast trend chart is open, or null. Set from a clicked
  // boundary via the feature panel's "View forecast chart" button.
  const [chartRegion, setChartRegion] = useState(null)
  // Which CARI layers are on in the Analysis view. Its own visibility set, kept
  // apart from the Map view's layers so switching tabs never disturbs either.
  const identifyReqRef = useRef(0)
  const initialBasemapRef = useRef(null)
  // Flips true the first time visibility is seeded, so the persist effect below
  // cannot write the empty initial set over a saved one before it is restored.
  const layersHydratedRef = useRef(false)

  const ready = contractState.status === 'ready'
  const layers = useMemo(() => (ready ? contracts().layers.filter((l) => !HIDDEN_LAYERS.has(l.id)) : []), [ready])
  const rasterLayers = useMemo(() => (ready ? contracts().rasterLayers : []), [ready])

  // Which raster layers can actually serve a tile today. Declared in the
  // contract is not the same as ingested, and the panel says which is which.
  const { availability } = useRasterAvailability(rasterLayers)

  // The forecast models, in contract order, with the data_type each resolves
  // against. One is active at a time and drives the map and the timeline.
  const forecastModels = useMemo(() => {
    const out = []
    const seen = new Set()
    for (const l of rasterLayers) {
      if (!l.modelId || seen.has(l.modelId)) continue
      seen.add(l.modelId)
      out.push({ modelId: l.modelId, model: l.model, modelLabel: l.modelLabel })
    }
    return out
  }, [rasterLayers])

  const activeModel = forecastModels.find((m) => m.modelId === activeModelId) ?? null

  // Default the active model once availability is known: the first model with an
  // ingested cycle, or the first in the contract if none has landed yet. A model
  // restored from a previous visit that the contract no longer offers is dropped
  // first, so the map never tries to draw a model that is not there.
  useEffect(() => {
    if (forecastModels.length === 0) return
    if (activeModelId) {
      if (!forecastModels.some((m) => m.modelId === activeModelId)) setActiveModelId(null)
      return
    }
    const withCycle = forecastModels.find((m) =>
      rasterLayers.some((l) => l.modelId === m.modelId && availability[l.id]?.ok)
    )
    setActiveModelId((withCycle ?? forecastModels[0]).modelId)
  }, [activeModelId, forecastModels, rasterLayers, availability])

  // The forecast cycle behind the time slider, for the active model. Keyed on
  // how many raster bands are catalogued, so it reloads the moment an ingest
  // lands a cycle, and on the active model, so switching model reloads its run.
  const availabilitySignal = Object.values(availability).filter((a) => a?.ok).length
  const forecast = useForecast(activeModel?.model ?? null, availabilitySignal)
  const modelLeads = forecast.leads
  // CARI scores on the 3 hour grid: its wind (GFS) and precipitable water
  // (GRAPES) inputs are 3-hourly, so a class cannot change faster than that.
  // WRFPRS happens to publish hourly, which made the Analysis slider step three
  // identical slots per real change. So in the Analysis view the slider steps the
  // 3 hour grid (leads that are multiples of 3, exactly the distinct scoring
  // leads); the Forecast view keeps the model's own leads, hourly where it has
  // them.
  const analysisLeads = useMemo(() => modelLeads.filter((h) => h % 3 === 0), [modelLeads])
  const leads = view === 'analysis' ? analysisLeads : modelLeads
  const activeLead = leads.length ? leads[Math.min(leadIndex, leads.length - 1)] : null

  // Temporal layers currently shown for the active model, for the slider to name
  // what the time applies to. The level is spelled out when it is not surface.
  const activeTemporalLabels = useMemo(
    () => rasterLayers
      .filter((l) => l.temporal && l.modelId === activeModelId && visibleLayers.has(l.id))
      .map((l) => (l.level ? `${l.label} ${l.levelLabel}` : l.label)),
    [rasterLayers, visibleLayers, activeModelId]
  )

  // Clamp the lead index if a new cycle publishes fewer steps than the old one.
  useEffect(() => {
    if (leadIndex > leads.length - 1) setLeadIndex(Math.max(0, leads.length - 1))
  }, [leads.length, leadIndex])

  // --------------------------------------------------------------- Analysis
  //
  // The Analysis view colours administrative layers by CARI class. Districts and
  // tehsils are one layer each with a single visibility toggle shared across
  // tabs, so they never disappear on a tab switch; only the toggle removes them.
  // The tab decides how they are drawn (a plain boundary in Map, the choropleth
  // here), what a click does (a CARI card here, an attribute card elsewhere) and
  // how the timeline is labelled.
  const analysis = view === 'analysis'
  // The Radar tab draws its own image overlays but otherwise leaves the map as
  // is; this flag only keeps the forecast charts out of the way while it is open.
  const radar = view === 'radar'

  const cariLayerDefs = useMemo(
    () => CARI_LAYER_CONFIG
      .map((c) => {
        const def = layers.find((l) => l.id === c.id)
        return def ? { ...c, label: def.label, color: def.color } : null
      })
      .filter(Boolean),
    [layers]
  )

  const cariClassList = useMemo(() => (ready ? cariClasses() : []), [ready])

  // Districts and tehsils are a single layer each, with one visibility toggle
  // shared by the Map and Analysis tabs. The difference is only how they are
  // drawn: a plain boundary everywhere, coloured by CARI class in the Analysis
  // tab. So the scoring keys off the same visibleLayers set the Map tab toggles,
  // and only the paint is gated on the tab.
  const activeCariKinds = useMemo(
    () => cariLayerDefs.filter((c) => visibleLayers.has(c.id)).map((c) => c.kind),
    [cariLayerDefs, visibleLayers]
  )

  // Score only while the Analysis tab is open: that is the only place the
  // choropleth is drawn, so the Map tab never triggers a whole-layer pass. The
  // paint resets to the plain boundary when the tab is left.
  const choroplethData = useCariChoropleth(analysis ? activeCariKinds : [], analysis ? activeLead : null)

  // Per layer: the join value to class colour map the map fills with, built in the
  // Analysis tab for every visible administrative layer whose scoring has landed.
  const cariChoropleth = useMemo(() => {
    if (!analysis) return null
    const out = {}
    for (const c of cariLayerDefs) {
      if (!visibleLayers.has(c.id)) continue
      const entry = choroplethData[c.kind]
      if (entry?.status !== 'ready') continue
      const byKey = {}
      for (const f of entry.features) byKey[f.key] = cariClassList[f.classIdx]?.color ?? '#94a3b8'
      out[c.id] = { byKey, keyField: c.keyField }
    }
    return Object.keys(out).length ? out : null
  }, [analysis, cariLayerDefs, visibleLayers, choroplethData, cariClassList])

  const cariStatus = useMemo(() => {
    const out = {}
    for (const c of cariLayerDefs) out[c.id] = choroplethData[c.kind]?.status
    return out
  }, [cariLayerDefs, choroplethData])

  // Warm the whole timeline for every visible administrative layer, in the
  // background, so stepping the slider lands on a cache hit rather than a fresh
  // pass. Only while the Analysis tab is open, and only for kinds turned on.
  const warmProgress = useWarmTimeline(analysis ? activeCariKinds : [], analysis)
  const cariWarm = useMemo(() => {
    const out = {}
    for (const c of cariLayerDefs) out[c.id] = warmProgress[c.kind]
    return out
  }, [cariLayerDefs, warmProgress])

  // Radar layers are a static catalogue (two sites, three products each). A
  // toggled-on layer draws in every tab, like the rest; only the toggles live in
  // the Radar tab. The live frame comes from the gateway, refreshed on a timer,
  // and each is pinned to its coverage square with a coverage ring.
  const radarLayerDefs = useMemo(() => (ready ? radarLayers() : []), [ready])
  const activeRadarLayers = useMemo(
    () => radarLayerDefs.filter((l) => visibleLayers.has(l.id)),
    [radarLayerDefs, visibleLayers]
  )
  // Picking a single site drops the other site's radar layers, so its imagery
  // cannot stay on the map after its controls are hidden. "Both" leaves them be.
  const selectRadarSite = useCallback((siteId) => {
    if (siteId === 'both') return
    setVisibleLayers((current) => {
      const next = new Set(current)
      for (const l of radarLayerDefs) {
        if (l.site !== siteId) next.delete(l.id)
      }
      return next
    })
  }, [radarLayerDefs])

  // Set several layers on or off at once, for the both-sites radar toggles that
  // drive a product at every site together.
  const setLayersVisible = useCallback((ids, on) => {
    setVisibleLayers((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const radarFrames = useRadarFrames(activeRadarLayers)
  const radarOverlays = useMemo(
    () =>
      activeRadarLayers
        .map((l) => {
          const frame = radarFrames[l.id]
          if (!frame) return null
          return {
            id: l.id,
            imageUrl: frame.imageUrl,
            coordinates: radarBounds(l.center, l.rangeKm),
            opacity: opacities[l.id] ?? 0.85,
            ring: radarRing(l.center, l.rangeKm)
          }
        })
        .filter(Boolean),
    [activeRadarLayers, radarFrames, opacities]
  )

  // One visibility set for everything, so switching tabs never hides a layer:
  // toggling is the only thing that does.
  const effectiveVisible = visibleLayers

  // The computed rasters (per pixel CAR Index, hotspot mask) are graded on demand,
  // so a visible one is prepared through the compute endpoint before the map draws
  // it. The hook polls until each is ready and hands back the WRFPRS cycle and the
  // snapped lead its tiles must resolve against, distinct from the active model's.
  const visibleComputedIds = useMemo(
    () => rasterLayers.filter((l) => l.source === 'computed' && effectiveVisible.has(l.id)).map((l) => l.id),
    [rasterLayers, effectiveVisible]
  )
  const computedTimes = useComputedRasters(visibleComputedIds, activeLead)
  // Warm the tiles for the leads the slider is about to reach, so scrubbing and
  // playing a forecast layer render from cache instead of a fresh render pass.
  useRasterPrefetch({
    map,
    rasterLayers,
    visibleLayers: effectiveVisible,
    leads,
    leadIndex,
    playing,
    creationTime: forecast.creationTime
  })
  const computingLabels = useMemo(
    () => rasterLayers
      .filter((l) => l.source === 'computed' && effectiveVisible.has(l.id) && computedTimes[l.id]?.status === 'computing')
      .map((l) => l.label),
    [rasterLayers, effectiveVisible, computedTimes]
  )
  const computedErrors = useMemo(
    () => rasterLayers
      .filter((l) => l.source === 'computed' && effectiveVisible.has(l.id) && computedTimes[l.id]?.status === 'error')
      .map((l) => ({ label: l.label, message: computedTimes[l.id]?.message })),
    [rasterLayers, effectiveVisible, computedTimes]
  )

  // A view switch clears whatever was picked in the other view, so a district
  // popup does not linger into Analysis and a CARI card does not linger back.
  useEffect(() => {
    setSelection(null)
    setRasterSelection(null)
    setChartRegion(null)
    setIdentify(false)
  }, [view])

  // Escape closes the open top-right card in either view, the same as its close
  // button, for the feature panel, the CAR Index card, the event card and the
  // raster identify card alike. The event card's full-screen image lightbox
  // consumes Escape first (a capturing listener there), so one press closes the
  // lightbox and a second closes the card.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setSelection(null)
      setRasterSelection(null)
      setChartRegion(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Legend scales for the raster rows, built from the palette and the display
  // range the gateway colours the tiles with.
  const scales = useMemo(() => {
    if (!ready) return {}
    return Object.fromEntries(
      rasterLayers.map((l) => [l.id, rasterScale(l)]).filter(([, scale]) => scale)
    )
  }, [ready, rasterLayers])

  // Seed visibility once the contract is ready. A set saved from a previous visit
  // wins, filtered to layers that still exist so a contract change cannot bring a
  // dead id back to life; otherwise fall back to the contract's defaultVisible.
  // After this one run the set belongs to the user and is persisted below.
  useEffect(() => {
    if (!ready || layersHydratedRef.current) return
    const all = contracts()
    const validIds = new Set([...all.layers, ...all.rasterLayers].map((l) => l.id))
    const saved = getStored('visibleLayers', null)
    const restored = Array.isArray(saved) ? saved.filter((id) => validIds.has(id)) : null
    setVisibleLayers(
      restored
        ? new Set(restored)
        : new Set(all.layers.filter((l) => l.defaultVisible).map((l) => l.id))
    )
    layersHydratedRef.current = true
  }, [ready])

  // Persist the layer state so a reload returns to the same map without a
  // re-toggle. The visibility write waits for the one-time hydration above, so
  // the empty initial set is never saved over a restored one. The others hold
  // their restored value from mount, so writing it straight back is a no-op.
  useEffect(() => {
    if (!layersHydratedRef.current) return
    setStored('visibleLayers', [...visibleLayers])
  }, [visibleLayers])
  useEffect(() => { setStored('opacities', opacities) }, [opacities])
  useEffect(() => { setStored('activeModelId', activeModelId) }, [activeModelId])
  useEffect(() => { setStored('levelChoice', levelChoice) }, [levelChoice])

  // Persist the chosen basemap and restore it next visit. Once the contract is
  // known, a stored id that no longer exists (a token removed, a renamed style)
  // is dropped so it falls back to the theme default rather than a blank map.
  useEffect(() => { setStored('basemap', basemap) }, [basemap])
  useEffect(() => {
    if (!ready || !basemap) return
    if (!findBasemap(basemap)) setBasemap(null)
  }, [ready, basemap])

  // Seed and heal the vector layer order once the contract is known. The contract
  // lists layers bottom to top (national first, events last), so the map's natural
  // top-first order is that list reversed. A saved order wins, filtered to layers
  // that still exist, with any newly added layer placed on top.
  useEffect(() => {
    if (!ready) return
    const vectorIds = contracts().layers.map((l) => l.id)
    const fallback = [...vectorIds].reverse()
    setLayerOrder((prev) => {
      if (!Array.isArray(prev)) return fallback
      const kept = prev.filter((id) => vectorIds.includes(id))
      const added = fallback.filter((id) => !kept.includes(id))
      return [...added, ...kept]
    })
  }, [ready])
  useEffect(() => { if (layerOrder) setStored('layerOrder', layerOrder) }, [layerOrder])

  // The vector layers resolved into the current top-first order, for the order
  // dock to list and for the map to stack.
  const orderedVectorDefs = useMemo(() => {
    const byId = new Map(layers.map((l) => [l.id, l]))
    const ids = layerOrder ?? [...layers.map((l) => l.id)].reverse()
    return ids.map((id) => byId.get(id)).filter(Boolean)
  }, [layerOrder, layers])

  // Every model's temporal layers, so the forecast chart can pick a model and
  // then that model's variables, independent of the map's active model.
  const chartTemporalLayers = useMemo(
    () => rasterLayers.filter((l) => l.temporal),
    [rasterLayers]
  )
  // The active model's temporal layers, used only to seed the chart's opening
  // variable from whatever is currently shown on the map.
  const chartLayers = useMemo(
    () => chartTemporalLayers.filter((l) => l.modelId === activeModelId),
    [chartTemporalLayers, activeModelId]
  )
  const chartInitialLayerId = useMemo(() => {
    const shown = chartLayers.find((l) => visibleLayers.has(l.id))
    return (shown ?? chartLayers[0])?.id
  }, [chartLayers, visibleLayers])
  const openForecastChart = useCallback((sel) => {
    const kind = REGION_KIND[sel?.layer?.id]
    if (!kind) return
    const props = sel.properties || {}
    const key = kind === 'tehsil' ? props.tehsil_code : kind === 'iiojk' ? props.district_code : props.district_name
    const name = kind === 'tehsil' ? props.tehsil : props.district_name
    if (key) setChartRegion({ kind, key, name: name || key })
  }, [])

  // Resolved during render, not in an effect. Setting it in an effect meant the
  // map mounted with one basemap for a frame and then called setStyle once
  // state caught up, which reads on screen as a flash.
  //
  // Captured once in a ref rather than recomputed each render, because it
  // depends on isDark: without the ref, toggling the theme changed the resolved
  // basemap for anyone who had not picked one, which triggered a full style
  // reload as a side effect of pressing the day and night button.
  //
  // Once the user picks a basemap it is theirs: `basemap` wins from then on.
  if (ready && !initialBasemapRef.current) {
    initialBasemapRef.current = defaultBasemapId(isDark)
  }
  const activeBasemap = basemap ?? initialBasemapRef.current
  // Radar range rings track the basemap: white over a dark style so they read
  // against the ground, the usual dark ink over a light one.
  const radarRingColor = findBasemap(activeBasemap)?.scheme === 'dark'
    ? 'rgba(255,255,255,0.9)'
    : 'rgba(20,24,31,0.6)'

  const toggleLayer = useCallback((id) => {
    setVisibleLayers((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Show all means show everything that can draw. Switching on a layer whose
  // data is not ingested would produce a row of failed tile requests and an
  // error banner, which is not what pressing "show all" is asking for. Only the
  // active model's forecast layers are turned on, since one model draws at a time.
  const showAll = useCallback(() => {
    setVisibleLayers(new Set([
      ...layers.map((l) => l.id),
      ...rasterLayers
        .filter((l) => availability[l.id]?.ok && (!l.modelId || l.modelId === activeModelId))
        .map((l) => l.id)
    ]))
  }, [layers, rasterLayers, availability, activeModelId])

  // One model draws at a time. Switching drops the previous model's forecast
  // layers from view, resets the timeline to the first lead, and lets the new
  // model's cycle take over the slider.
  const selectModel = useCallback((modelId) => {
    setActiveModelId(modelId)
    setLeadIndex(0)
    setVisibleLayers((current) => {
      const next = new Set(current)
      for (const l of rasterLayers) {
        if (l.modelId && l.modelId !== modelId) next.delete(l.id)
      }
      return next
    })
  }, [rasterLayers])

  // Pick a pressure level for a forecast element. If that element is currently
  // shown, move visibility to the newly selected level so the map follows the
  // dropdown without a second click.
  const selectLevel = useCallback((modelId, element, level) => {
    setLevelChoice((current) => ({ ...current, [`${modelId}:${element}`]: level }))
    setVisibleLayers((current) => {
      const variants = rasterLayers.filter(
        (l) => l.modelId === modelId && l.element === element
      )
      const shown = variants.find((v) => current.has(v.id))
      const target = variants.find((v) => v.level === level)
      if (!shown || !target || shown.id === target.id) return current
      const next = new Set(current)
      next.delete(shown.id)
      next.add(target.id)
      return next
    })
  }, [rasterLayers])

  const setOpacity = useCallback((id, value) => {
    setOpacities((current) => ({ ...current, [id]: value }))
  }, [])

  const zoomToPakistan = useCallback(() => {
    if (map) fitToBounds(map, DEFAULT_BOUNDS, 56)
  }, [map])

  // Frame a single layer at its own extent, asked of the API which computes it
  // from the layer's geometry. Most layers are national, so they land close to
  // the Pakistan view, but IIOJK frames the north and a points layer would frame
  // its points. Falls back to the national bounds if the layer has no features
  // yet or the request fails, so the button never does nothing.
  const zoomToLayer = useCallback(async (layerId) => {
    if (!map) return
    try {
      const { extent } = await getLayerExtent(layerId)
      if (extent) fitToExtent(map, extent, 64)
      else fitToBounds(map, DEFAULT_BOUNDS, 56)
    } catch {
      fitToBounds(map, DEFAULT_BOUNDS, 56)
    }
  }, [map])

  const locate = useCallback(() => {
    if (!map || !navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => map.flyTo({ center: [coords.longitude, coords.latitude], zoom: 10, duration: 1200 }),
      () => {}
    )
  }, [map])

  // Arm or disarm the identify tool. Disarming clears any open value popup, so
  // the tool and its result turn off together.
  const toggleIdentify = useCallback(() => {
    setIdentify((on) => {
      if (on) setRasterSelection(null)
      return !on
    })
  }, [])

  // Read the value of the topmost raster at a clicked point. The layer id comes
  // from the map's draw order; everything else, the model, cycle and lead, is
  // what the map is currently showing, so the number matches the pixel.
  const onIdentify = useCallback(async ({ layerId, lng, lat }) => {
    const def = rasterLayers.find((l) => l.id === layerId)
    if (!def) {
      setRasterSelection(null)
      return
    }
    const reqId = ++identifyReqRef.current
    // Keep the open card and its current value while the next pixel loads, so a
    // new click updates the card in place instead of blanking and reflowing it.
    // Only the very first open shows a loading state, since there is nothing to
    // keep yet; the swap to the new value happens atomically on arrival.
    setRasterSelection((prev) => (prev ? { ...prev, status: 'updating' } : { def, lng, lat, status: 'loading' }))
    // A computed layer is drawn at its own WRFPRS cycle and snapped lead, not the
    // active model's, so the pixel is read at the same time the tile shows it.
    const computed = def.source === 'computed' ? computedTimes[def.id] : null
    const identifyCt = computed ? computed.creationTime : (def.temporal ? forecast.creationTime : undefined)
    const identifyLead = computed ? computed.leadHours : (def.temporal ? activeLead : undefined)
    try {
      const data = await getRasterPoint(def.id, {
        model: def.model,
        creationTime: identifyCt,
        leadHours: identifyLead,
        lon: lng,
        lat
      })
      if (identifyReqRef.current !== reqId) return
      // For the CAR Index raster the pixel value is a percentage, so name the risk
      // class it falls in (High, Very High, Extreme...) rather than leaving the card
      // to convey meaning by colour alone. Same class boundaries as the choropleth.
      const isRisk = contracts().bands.find((b) => b.key === def.band)?.category === 'risk'
      const riskClass = isRisk && data.value != null
        ? cariClassList.find((c) => data.value <= c.max) ?? cariClassList[cariClassList.length - 1]
        : null
      setRasterSelection({
        def, lng, lat, status: 'ok',
        value: data.value, unit: data.unit, legendTitle: data.legendTitle, leadHours: data.leadHours, riskClass
      })
    } catch {
      if (identifyReqRef.current !== reqId) return
      setRasterSelection({ def, lng, lat, status: 'error' })
    }
  }, [rasterLayers, forecast.creationTime, activeLead, computedTimes, cariClassList])

  if (contractState.status === 'loading') {
    return (
      <Splash>
        <TbCloudStorm className="text-4xl text-primary" aria-hidden />
        <p className="text-[13px] text-muted">Loading the portal</p>
      </Splash>
    )
  }

  if (contractState.status === 'error') {
    return (
      <Splash>
        <StatusBanner
          kind="danger"
          title="Could not reach the API"
          message={contractState.error?.message}
          detail="Check that the stack is running with docker compose ps, and that ports 3090 and 4090 are open on this machine."
        />
      </Splash>
    )
  }

  const basemaps = availableBasemaps()

  // Mapbox GL cannot draw anything without a token, so say so instead of
  // presenting an empty map that looks like a bug.
  if (!hasMapboxToken()) {
    return (
      <Splash>
        <StatusBanner
          kind="danger"
          title="Mapbox token is missing"
          message="The map cannot render without one."
          detail="Set VITE_MAPBOX_TOKEN in .env and recreate the web container with docker compose up -d cbd-web. Compose reads .env when the container is created, so a restart is not enough."
        />
      </Splash>
    )
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <Navbar
        view={view}
        onView={setView}
        isDark={isDark}
        onToggleTheme={toggleTheme}
        onToggleSidebar={() => setPanelsOpen((v) => !v)}
      />

      <main className="relative min-h-0 flex-1">
        <MapView
          layers={layers}
          rasterLayers={rasterLayers}
          visibleLayers={effectiveVisible}
          opacities={opacities}
          basemap={activeBasemap}
          projection={projection}
          creationTime={forecast.creationTime}
          leadHours={activeLead}
          computedTimes={computedTimes}
          identify={!analysis && identify}
          choropleth={cariChoropleth}
          radarOverlays={radarOverlays}
          radarRingColor={radarRingColor}
          selection={selection}
          layerOrder={layerOrder}
          onIdentify={onIdentify}
          onMapReady={setMap}
          onSelectFeature={setSelection}
        />

        {/* The per pixel products grade every forecast cell on demand, which takes
            a few seconds the first time a lead is opened. A quiet chip says so, so
            an empty map reads as working rather than broken. */}
        {(computingLabels.length > 0 || computedErrors.length > 0) && (
          <div className="pointer-events-none absolute left-1/2 top-4 z-20 flex -translate-x-1/2 flex-col items-center gap-1.5">
            {computingLabels.length > 0 && (
              <div className="flex items-center gap-2 rounded-cb border border-border bg-panel px-3.5 py-2 shadow-cb-lg">
                <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden />
                <span className="text-[12px] font-medium text-text">Computing {computingLabels.join(' and ')}…</span>
              </div>
            )}
            {computedErrors.map((e) => (
              <div key={e.label} className="flex max-w-[26rem] items-start gap-2 rounded-cb border border-danger-border bg-danger-soft px-3.5 py-2 shadow-cb-lg">
                <TbAlertTriangle className="mt-[1px] shrink-0 text-[15px] text-danger" aria-hidden />
                <span className="text-[12px] text-danger"><span className="font-semibold">{e.label}</span> {e.message}</span>
              </div>
            ))}
          </div>
        )}


        {/* Forecast trend chart for a selected boundary, floated over the lower
            map above the timeline. Map view only, and only once a model has
            temporal layers to chart. */}
        {!analysis && !radar && chartRegion && chartTemporalLayers.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-28 z-30 flex justify-center px-3">
            <ForecastChartPanel
              region={chartRegion}
              layers={chartTemporalLayers}
              models={forecastModels}
              availability={availability}
              initialModelId={activeModelId}
              initialLayerId={chartInitialLayerId}
              isDark={isDark}
              onClose={() => setChartRegion(null)}
            />
          </div>
        )}

        {/* Dock rails. Nothing here receives pointer events except the panels
            themselves, so the map stays draggable in every gap. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col p-3">
          <div className="flex min-h-0 flex-1 items-start justify-between gap-3">
            {panelsOpen ? (
              <LayersPanel
                view={view}
                layers={orderedVectorDefs}
                rasterLayers={rasterLayers}
                availability={availability}
                visibleLayers={visibleLayers}
                onToggleLayer={toggleLayer}
                onZoomToLayer={zoomToLayer}
                onShowAll={showAll}
                onHideAll={() => setVisibleLayers(new Set())}
                onReorderLayers={setLayerOrder}
                counts={COUNTS}
                scales={scales}
                opacities={opacities}
                onOpacity={setOpacity}
                activeModelId={activeModelId}
                onSelectModel={selectModel}
                levelChoice={levelChoice}
                onSelectLevel={selectLevel}
                collapsed={layersCollapsed}
                onCollapse={() => setLayersCollapsed((v) => !v)}
                cariLayers={cariLayerDefs}
                cariClasses={cariClassList}
                cariStatus={cariStatus}
                cariWarm={cariWarm}
                radarLayers={radarLayerDefs}
                onRadarSite={selectRadarSite}
                onSetLayers={setLayersVisible}
              />
            ) : (
              <span />
            )}

            <div className="flex items-start gap-3">
              {/* Map view shows the attribute popup and the raster identify card;
                  Analysis view shows the CARI score for the clicked unit. One
                  card is up at a time and both live top right beside the controls. */}
              {/* A clicked historic event point gets its own card, with the
                  attribute readout and the photo carousel; every other layer
                  falls through to the generic attribute inspector. */}
              {!analysis && selection && (
                selection.layer?.id === 'historic_events'
                  ? <EventCard selection={selection} onClose={() => setSelection(null)} />
                  : <FeaturePanel selection={selection} onClose={() => setSelection(null)} onForecastChart={openForecastChart} />
              )}
              {!analysis && rasterSelection && (
                <RasterPanel selection={rasterSelection} onClose={() => setRasterSelection(null)} />
              )}
              {analysis && selection && (
                <CariCard selection={selection} leadHours={activeLead} onClose={() => setSelection(null)} />
              )}
              <MapControls
                map={map}
                projection={projection}
                onProjection={setProjection}
                onZoomToPakistan={zoomToPakistan}
                onLocate={locate}
                basemaps={basemaps}
                activeBasemap={activeBasemap}
                onSelectBasemap={setBasemap}
                tokenMissing={!hasMapboxToken()}
                identifyActive={!analysis && identify}
                onToggleIdentify={toggleIdentify}
              />
            </div>
          </div>

          {/* The bottom rail is the forecast timeline. It shows the time slider
              once a cycle is ingested, and says so plainly until then. */}
          <div className="flex shrink-0 items-end justify-center gap-3 pt-3">
            {forecast.status === 'ok' && leads.length ? (
              <TimeSlider
                cycle={forecast.creationTime}
                model={activeModel?.modelLabel ?? forecast.model}
                leads={leads}
                index={Math.min(leadIndex, leads.length - 1)}
                onIndex={setLeadIndex}
                playing={playing}
                onPlayToggle={() => setPlaying((v) => !v)}
                activeLayers={activeTemporalLabels}
                analysis={analysis}
              />
            ) : (
              <div className="pointer-events-auto flex items-center gap-2 rounded-cb-sm border border-amber-border bg-amber-soft px-3 py-2">
                <TbAlertTriangle className="shrink-0 text-[14px] text-amber" aria-hidden />
                <span className="text-[11.5px] font-medium text-amber">
                  No forecast cycle ingested yet, so the timeline and scoring layers are unavailable
                </span>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
