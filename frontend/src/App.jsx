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
import LayersPanel from '@/components/LayersPanel'
import MapControls from '@/components/MapControls'
import Navbar from '@/components/Navbar'
import RasterPanel from '@/components/RasterPanel'
import StatusBanner from '@/components/StatusBanner'
import TimeSlider from '@/components/TimeSlider'
import MapView from '@/features/map/MapView'
import { useCariChoropleth } from '@/hooks/useCariChoropleth'
import { useContracts } from '@/hooks/useContracts'
import { useForecast } from '@/hooks/useForecast'
import { useRasterAvailability } from '@/hooks/useRasterAvailability'
import { useTheme } from '@/hooks/useTheme'
import { getLayerExtent, getRasterPoint } from '@/lib/api'
import { availableBasemaps, defaultBasemapId, findBasemap, hasMapboxToken } from '@/lib/basemaps'
import { cariClasses, contracts, rasterScale } from '@/lib/contracts'
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
  const [panelsOpen, setPanelsOpen] = useState(true)
  const [leadIndex, setLeadIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [activeModelId, setActiveModelId] = useState(() => getStored('activeModelId', null))
  const [levelChoice, setLevelChoice] = useState(() => getStored('levelChoice', {}))
  const [identify, setIdentify] = useState(false)
  const [rasterSelection, setRasterSelection] = useState(null)
  // Which CARI layers are on in the Analysis view. Its own visibility set, kept
  // apart from the Map view's layers so switching tabs never disturbs either.
  const [cariVisible, setCariVisible] = useState(() => new Set(getStored('cariVisible', ['pak_districts'])))
  const identifyReqRef = useRef(0)
  const initialBasemapRef = useRef(null)
  // Flips true the first time visibility is seeded, so the persist effect below
  // cannot write the empty initial set over a saved one before it is restored.
  const layersHydratedRef = useRef(false)

  const ready = contractState.status === 'ready'
  const layers = useMemo(() => (ready ? contracts().layers : []), [ready])
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
  const leads = forecast.leads
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
  // The Analysis view colours whole administrative layers by CARI class. It runs
  // off its own visibility set (cariVisible) and its own layer list, so the Map
  // view is untouched, and it reads the same timeline: the choropleth and the
  // detail card both score at the current lead.
  const analysis = view === 'analysis'

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

  const activeCariKinds = useMemo(
    () => cariLayerDefs.filter((c) => cariVisible.has(c.id)).map((c) => c.kind),
    [cariLayerDefs, cariVisible]
  )

  // Poll only while the Analysis view is open, so the Map view never triggers a
  // whole-layer scoring pass in the background.
  const choroplethData = useCariChoropleth(analysis ? activeCariKinds : [], analysis ? activeLead : null)

  // Per layer: the join value to class colour map the map fills with, built only
  // for visible layers whose scoring has landed.
  const cariChoropleth = useMemo(() => {
    if (!analysis) return null
    const out = {}
    for (const c of cariLayerDefs) {
      if (!cariVisible.has(c.id)) continue
      const entry = choroplethData[c.kind]
      if (entry?.status !== 'ready') continue
      const byKey = {}
      for (const f of entry.features) byKey[f.key] = cariClassList[f.classIdx]?.color ?? '#94a3b8'
      out[c.id] = { byKey, keyField: c.keyField }
    }
    return out
  }, [analysis, cariLayerDefs, cariVisible, choroplethData, cariClassList])

  const cariStatus = useMemo(() => {
    const out = {}
    for (const c of cariLayerDefs) out[c.id] = choroplethData[c.kind]?.status
    return out
  }, [cariLayerDefs, choroplethData])

  const effectiveVisible = analysis ? cariVisible : visibleLayers

  const toggleCariLayer = useCallback((id) => {
    setCariVisible((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  useEffect(() => { setStored('cariVisible', [...cariVisible]) }, [cariVisible])

  // A view switch clears whatever was picked in the other view, so a district
  // popup does not linger into Analysis and a CARI card does not linger back.
  useEffect(() => {
    setSelection(null)
    setRasterSelection(null)
    setIdentify(false)
  }, [view])

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
    try {
      const data = await getRasterPoint(def.id, {
        model: def.model,
        creationTime: def.temporal ? forecast.creationTime : undefined,
        leadHours: def.temporal ? activeLead : undefined,
        lon: lng,
        lat
      })
      if (identifyReqRef.current !== reqId) return
      setRasterSelection({
        def, lng, lat, status: 'ok',
        value: data.value, unit: data.unit, legendTitle: data.legendTitle, leadHours: data.leadHours
      })
    } catch {
      if (identifyReqRef.current !== reqId) return
      setRasterSelection({ def, lng, lat, status: 'error' })
    }
  }, [rasterLayers, forecast.creationTime, activeLead])

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
        status="pending"
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
          identify={!analysis && identify}
          choropleth={cariChoropleth}
          onIdentify={onIdentify}
          onMapReady={setMap}
          onSelectFeature={setSelection}
        />

        {/* Dock rails. Nothing here receives pointer events except the panels
            themselves, so the map stays draggable in every gap. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col p-3">
          <div className="flex min-h-0 flex-1 items-start justify-between gap-3">
            {panelsOpen ? (
              <LayersPanel
                layers={layers}
                rasterLayers={rasterLayers}
                availability={availability}
                visibleLayers={analysis ? cariVisible : visibleLayers}
                onToggleLayer={analysis ? toggleCariLayer : toggleLayer}
                onZoomToLayer={zoomToLayer}
                onShowAll={showAll}
                onHideAll={() => setVisibleLayers(new Set())}
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
                cariMode={analysis}
                cariLayers={cariLayerDefs}
                cariClasses={cariClassList}
                cariStatus={cariStatus}
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
                  : <FeaturePanel selection={selection} onClose={() => setSelection(null)} />
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
