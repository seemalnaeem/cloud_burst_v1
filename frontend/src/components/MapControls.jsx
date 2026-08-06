// Map navigation controls, top right.
//
// Hand built rather than Mapbox's own NavigationControl, for one reason: the
// stock controls ship their own light styling and a hardcoded compass, so in
// dark theme they sit on the map as a white brick. These read the same tokens
// as every other surface, so they follow the theme for free.
//
// Everything lives behind one chevron. Collapsed, the map keeps its whole top
// right corner; expanded, the controls are grouped by what they do rather than
// by what they are. Zoom is continuous, so it is one keypad. Orientation and
// framing are discrete jumps, so they are another. Basemap is a rare choice, so
// it is last and opens its own list.

import { useEffect, useRef, useState } from 'react'
import {
  TbPlus, TbMinus, TbNavigation, TbWorld, TbMap2,
  TbFocusCentered, TbCurrentLocation, TbChevronDown, TbStack2
} from 'react-icons/tb'

import BasemapMenu, { iconFor } from './BasemapMenu'
import { ControlGroup, IconButton } from './ui/Panel'

/**
 * The compass. Rotates with the map and resets bearing and pitch on click.
 *
 * Worth having even in Mercator, and close to mandatory in globe projection
 * where it is genuinely easy to end up looking at Pakistan sideways with no
 * obvious way back.
 */
function CompassButton ({ map, bearing, pitch }) {
  const oriented = Math.abs(bearing) > 0.5 || pitch > 0.5

  return (
    <button
      type="button"
      title={oriented ? 'Reset north and tilt' : 'North is up'}
      aria-label="Reset bearing to north"
      onClick={() => map?.easeTo({ bearing: 0, pitch: 0, duration: 500 })}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center transition-colors duration-150 ${
        oriented ? 'bg-primary-soft text-primary' : 'bg-panel text-text-2 hover:bg-panel-3 hover:text-text'
      }`}
    >
      <TbNavigation
        className="text-[16px] transition-transform duration-150"
        style={{ transform: `rotate(${-bearing}deg)` }}
        aria-hidden
      />
    </button>
  )
}

export default function MapControls ({
  map,
  projection,
  onProjection,
  onZoomToPakistan,
  onLocate,
  basemaps,
  activeBasemap,
  onSelectBasemap,
  tokenMissing
}) {
  // Expanded by default. Zoom is the most used control on any map and hiding it
  // behind a click was the wrong default; the chevron is there to tuck the
  // stack away when the map itself matters more.
  const [open, setOpen] = useState(true)
  const [basemapOpen, setBasemapOpen] = useState(false)
  const [bearing, setBearing] = useState(0)
  const [pitch, setPitch] = useState(0)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!map) return
    const sync = () => {
      setBearing(map.getBearing())
      setPitch(map.getPitch())
    }
    sync()
    map.on('rotate', sync)
    map.on('pitch', sync)
    return () => {
      map.off('rotate', sync)
      map.off('pitch', sync)
    }
  }, [map])

  // Collapsing the stack has to take the basemap list with it, otherwise the
  // list is left floating against nothing.
  useEffect(() => {
    if (!open) setBasemapOpen(false)
  }, [open])

  // A click anywhere else closes the basemap list. Without this it stays open
  // over the map and the only way to dismiss it is to find the button again.
  useEffect(() => {
    if (!basemapOpen) return
    const onDocClick = (e) => {
      if (!rootRef.current?.contains(e.target)) setBasemapOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [basemapOpen])

  const isGlobe = projection === 'globe'
  const current = basemaps?.find((b) => b.id === activeBasemap)
  const BasemapIcon = iconFor(current)

  return (
    <div ref={rootRef} className="pointer-events-none flex flex-col items-end gap-2">
      <ControlGroup>
        <IconButton
          icon={TbChevronDown}
          label={open ? 'Hide map controls' : 'Show map controls'}
          active={open}
          onClick={() => setOpen((v) => !v)}
          className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </ControlGroup>

      {open && (
        <>
          <ControlGroup>
            <IconButton icon={TbPlus} label="Zoom in" onClick={() => map?.zoomIn({ duration: 250 })} />
            <IconButton icon={TbMinus} label="Zoom out" onClick={() => map?.zoomOut({ duration: 250 })} />
          </ControlGroup>

          <ControlGroup>
            <CompassButton map={map} bearing={bearing} pitch={pitch} />
          </ControlGroup>

          <ControlGroup>
            <IconButton
              icon={TbFocusCentered}
              label="Zoom to Pakistan extent"
              onClick={onZoomToPakistan}
            />
            <IconButton
              icon={isGlobe ? TbWorld : TbMap2}
              label={isGlobe ? 'Switch to Mercator projection' : 'Switch to globe projection'}
              active={isGlobe}
              onClick={() => onProjection(isGlobe ? 'mercator' : 'globe')}
            />
          </ControlGroup>

          <ControlGroup>
            <IconButton icon={TbCurrentLocation} label="Go to my location" onClick={onLocate} />
          </ControlGroup>

          {/* Basemap. The list opens to the left, because this sits against the
              right edge of the viewport. */}
          <div className="pointer-events-auto relative">
            <ControlGroup>
              <IconButton
                icon={basemaps?.length ? BasemapIcon : TbStack2}
                label={`Basemap: ${current?.label ?? 'none'}`}
                active={basemapOpen}
                onClick={() => setBasemapOpen((v) => !v)}
              />
            </ControlGroup>

            {basemapOpen && (
              <div className="absolute right-full top-0 mr-2">
                <BasemapMenu
                  basemaps={basemaps ?? []}
                  active={activeBasemap}
                  onSelect={(id) => {
                    onSelectBasemap(id)
                    setBasemapOpen(false)
                  }}
                  tokenMissing={tokenMissing}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
