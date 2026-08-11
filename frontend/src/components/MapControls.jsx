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
  TbFocusCentered, TbCurrentLocation, TbChevronDown, TbStack2, TbInfoCircle
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
  tokenMissing,
  identifyActive,
  onToggleIdentify
}) {
  // Expanded by default. Zoom is the most used control on any map and hiding it
  // behind a click was the wrong default; the chevron is there to tuck the
  // stack away when the map itself matters more.
  const [open, setOpen] = useState(true)
  const [basemapOpen, setBasemapOpen] = useState(false)
  const [bearing, setBearing] = useState(0)
  const [pitch, setPitch] = useState(0)
  // Clip the stack while it is collapsed or mid-glide, so the height animation
  // has something to hide behind; freed once fully open so the basemap flyout is
  // not cut off. Starts unclipped because the stack starts open.
  const [clip, setClip] = useState(false)
  const rootRef = useRef(null)

  // Collapsing clips immediately; expanding waits for the glide to finish before
  // unclipping (see onTransitionEnd on the stack).
  useEffect(() => {
    if (!open) setClip(true)
  }, [open])

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

      {/* The stack glides open and shut: the grid row animates the height while a
          fade and a slight zoom play from the top-right corner. Rendered always,
          not mounted on demand, so both directions animate. overflow is clipped
          only while collapsed or mid-glide, then freed once open so the basemap
          flyout, which extends left out of the stack, is not cut off. */}
      <div
        onTransitionEnd={(e) => { if (e.propertyName === 'grid-template-rows' && open) setClip(false) }}
        className={`grid origin-top-right transition-all duration-300 ease-out ${
          open
            ? 'grid-rows-[1fr] scale-100 opacity-100'
            : 'pointer-events-none grid-rows-[0fr] scale-95 opacity-0'
        }`}
      >
        <div className={`flex flex-col items-end gap-2 ${clip ? 'overflow-hidden' : ''}`}>
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
            {/* Identify: click the map to read the topmost raster's value at that
                pixel. A tool, so it stays pressed while armed. */}
            <IconButton
              icon={TbInfoCircle}
              label={identifyActive ? 'Identify tool on, click the map' : 'Identify raster value'}
              active={identifyActive}
              onClick={onToggleIdentify}
            />
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
        </div>
      </div>
    </div>
  )
}
