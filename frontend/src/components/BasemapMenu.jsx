// The basemap list.
//
// Rendered by MapControls as part of the top right stack, opening to the left
// so it never runs off the edge of the viewport.

import { TbSatellite, TbMountain, TbRoad, TbSun, TbMoon, TbMap, TbAlertTriangle } from 'react-icons/tb'

export const BASEMAP_ICONS = {
  satellite: TbSatellite,
  terrain: TbMountain,
  streets: TbRoad,
  sun: TbSun,
  moon: TbMoon
}

export const iconFor = (basemap) => BASEMAP_ICONS[basemap?.icon] ?? TbMap

export default function BasemapMenu ({ basemaps, active, onSelect, tokenMissing }) {
  return (
    <div className="w-[190px] overflow-hidden rounded-cb border border-border bg-panel shadow-cb-lg">
      {tokenMissing && (
        <div className="flex items-start gap-2 border-b border-amber-border bg-amber-soft px-3 py-2">
          <TbAlertTriangle className="mt-[1px] shrink-0 text-[13px] text-amber" aria-hidden />
          <p className="text-[11px] leading-snug text-amber">
            No Mapbox token configured, so no basemap can be drawn.
          </p>
        </div>
      )}

      <ul className="p-1.5">
        {basemaps.map((b) => {
          const Icon = iconFor(b)
          const isActive = b.id === active
          return (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => onSelect(b.id)}
                className={`flex w-full items-center gap-2.5 rounded-cb-sm px-2.5 py-2 text-left transition-colors duration-150 ${
                  isActive ? 'bg-primary-soft text-primary' : 'text-text-2 hover:bg-panel-3 hover:text-text'
                }`}
              >
                <Icon className="shrink-0 text-[15px]" aria-hidden />
                <span className="flex-1 whitespace-nowrap text-[12.5px] font-medium">{b.label}</span>
                {isActive && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
