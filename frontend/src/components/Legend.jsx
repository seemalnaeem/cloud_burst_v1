import { legendTicks, paletteColors } from '@/lib/color'
import { fmtNumber, fmtUnit } from '@/lib/format'

/**
 * Legend rendered from a contract palette.
 *
 * Never hand written. The palette, the min and the max all come from the same
 * contract the tile route reads, which is what stops a legend from disagreeing
 * with the map it sits beside.
 */
export default function Legend ({ title, paletteName, kind, classes, min, max, unit, decimals = 0 }) {
  return (
    <div className="rounded-cb-sm border border-border bg-panel-2 p-3">
      {title && <p className="mb-2 text-xs font-semibold text-text-2">{title}</p>}

      {kind === 'classed' && classes ? (
        <ul className="space-y-1">
          {classes.map((cls) => (
            <li key={cls.idx} className="flex items-center gap-2">
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-sm"
                style={{ background: cls.color, boxShadow: 'inset 0 0 0 1px rgba(16,24,40,0.12)' }}
              />
              {/* The label sits next to the swatch on purpose. Meaning must
                  never be carried by color alone. */}
              <span className="text-xs text-text-2">{cls.name}</span>
              <span className="ml-auto text-xs text-muted">
                {cls.min != null ? `${cls.min} to ${cls.max}` : `≤ ${cls.max}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          {/* Discrete blocks, not a gradient. See paletteColors in lib/color. */}
          <div
            className="flex h-3 w-full overflow-hidden rounded"
            style={{ boxShadow: 'inset 0 0 0 1px rgba(16,24,40,0.06)' }}
          >
            {paletteColors(paletteName).map((color, i) => (
              <span key={`${color}-${i}`} className="flex-1" style={{ background: color }} />
            ))}
          </div>
          <div className="mt-1 flex justify-between">
            {legendTicks(min, max, 5, decimals).map((tick) => (
              <span key={tick} className="text-[10px] text-muted">
                {fmtNumber(tick, decimals)}
              </span>
            ))}
          </div>
          {unit && <p className="mt-1 text-center text-[10px] text-muted">{fmtUnit(unit)}</p>}
        </>
      )}
    </div>
  )
}
