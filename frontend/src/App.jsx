// App shell.
//
// The map is the application, so it occupies the whole area below the navbar
// and every panel floats over it in a dock. Docks are positioned by a grid of
// pointer-events-none rails, which means the gaps between panels stay part of
// the map and remain draggable. Absolutely positioned panels that swallow
// clicks in their margins are the usual way this goes wrong.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TbAlertTriangle, TbCloudStorm } from 'react-icons/tb'

import FeaturePanel from '@/components/FeaturePanel'
import LayersPanel from '@/components/LayersPanel'
import MapControls from '@/components/MapControls'
import Navbar from '@/components/Navbar'
import StatusBanner from '@/components/StatusBanner'
import MapView from '@/features/map/MapView'
import { useContracts } from '@/hooks/useContracts'
import { useTheme } from '@/hooks/useTheme'
import { availableBasemaps, defaultBasemapId, hasMapboxToken } from '@/lib/basemaps'
import { contracts } from '@/lib/contracts'
import { DEFAULT_BOUNDS, fitToBounds } from '@/lib/map'

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
  const [visibleLayers, setVisibleLayers] = useState(new Set())
  const [opacities, setOpacities] = useState({})
  const [selection, setSelection] = useState(null)
  const [basemap, setBasemap] = useState(null)
  const [projection, setProjection] = useState('mercator')
  const [layersCollapsed, setLayersCollapsed] = useState(false)
  const [panelsOpen, setPanelsOpen] = useState(true)
  const initialBasemapRef = useRef(null)

  const ready = contractState.status === 'ready'
  const layers = useMemo(() => (ready ? contracts().layers : []), [ready])

  // Seed visibility from the contract once, then it belongs to the user.
  useEffect(() => {
    if (!ready) return
    setVisibleLayers(new Set(contracts().layers.filter((l) => l.defaultVisible).map((l) => l.id)))
  }, [ready])

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

  const setOpacity = useCallback((id, value) => {
    setOpacities((current) => ({ ...current, [id]: value }))
  }, [])

  const zoomToPakistan = useCallback(() => {
    if (map) fitToBounds(map, DEFAULT_BOUNDS, 56)
  }, [map])

  const locate = useCallback(() => {
    if (!map || !navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => map.flyTo({ center: [coords.longitude, coords.latitude], zoom: 10, duration: 1200 }),
      () => {}
    )
  }, [map])

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
          visibleLayers={visibleLayers}
          opacities={opacities}
          basemap={activeBasemap}
          projection={projection}
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
                visibleLayers={visibleLayers}
                onToggleLayer={toggleLayer}
                onShowAll={() => setVisibleLayers(new Set(layers.map((l) => l.id)))}
                onHideAll={() => setVisibleLayers(new Set())}
                counts={COUNTS}
                opacities={opacities}
                onOpacity={setOpacity}
                collapsed={layersCollapsed}
                onCollapse={() => setLayersCollapsed((v) => !v)}
              />
            ) : (
              <span />
            )}

            <div className="flex items-start gap-3">
              {selection && <FeaturePanel selection={selection} onClose={() => setSelection(null)} />}
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
              />
            </div>
          </div>

          {/* The bottom rail is now the forecast timeline's alone. The basemap
              switcher moved into the top right control stack. */}
          <div className="flex shrink-0 items-end justify-end gap-3 pt-3">
            {/* Left for the forecast timeline, which needs a cycle to exist
                before it can honestly show anything. */}
            <div className="pointer-events-auto flex items-center gap-2 rounded-cb-sm border border-amber-border bg-amber-soft px-3 py-2">
              <TbAlertTriangle className="shrink-0 text-[14px] text-amber" aria-hidden />
              <span className="text-[11.5px] font-medium text-amber">
                No forecast cycle ingested yet, so scoring layers are unavailable
              </span>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
