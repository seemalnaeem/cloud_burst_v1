// Raster identify.
//
// The raster counterpart to FeaturePanel. Where a vector click inspects a
// feature's attributes, a raster click inspects the single pixel under the
// cursor on the topmost raster: its layer, the band behind it, and the value
// there, read from the same COG the tiles are drawn from so the number matches
// the map. Temporal rasters also show which model, level and lead the value is
// for, since the same layer means a different number at a different hour.

import { TbCurrentLocation, TbInfoCircle, TbX } from 'react-icons/tb'

import { fmtUnit } from '@/lib/format'

import { Panel, IconButton, Chip } from './ui/Panel'

function formatValue (value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  const abs = Math.abs(value)
  const decimals = abs >= 100 ? 0 : abs >= 1 ? 1 : 2
  const num = value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return unit ? `${num} ${fmtUnit(unit)}` : num
}

function Row ({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-[7px] last:border-b-0">
      <dt className="shrink-0 text-[11.5px] text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[12.5px] font-medium text-text">{children}</dd>
    </div>
  )
}

export default function RasterPanel ({ selection, onClose }) {
  if (!selection?.def) return null

  const { def, lng, lat, status } = selection
  const hasValue = selection.value !== null && selection.value !== undefined
  const value = hasValue ? formatValue(selection.value, selection.unit) : null
  const updating = status === 'updating'

  return (
    <Panel
      title={def.label}
      icon={TbInfoCircle}
      accent={def.color}
      className="w-[300px]"
      bodyClassName="px-3 py-3"
      actions={<IconButton icon={TbX} label="Close" size="sm" tone="ghost" onClick={onClose} />}
    >
      <div className="mb-3 flex items-center gap-2.5">
        <span className="h-3.5 w-3.5 shrink-0 rounded-[3px]" style={{ background: def.color }} />
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold leading-tight text-text">
            {def.label}{def.level ? ` ${def.levelLabel}` : ''}
          </h3>
          {def.modelLabel && <p className="mt-0.5 truncate text-[11px] text-muted">{def.modelLabel}</p>}
        </div>
      </div>

      {/* The value, picked out. It stays put between clicks: while the next
          pixel loads the previous number remains, dimmed with a pulse, and is
          replaced atomically, so the card never blanks or reflows. */}
      <div className="relative mb-3 rounded-cb-sm border border-border bg-panel-2 px-3 py-2.5 text-center">
        {status === 'error'
          ? <span className="text-[13px] text-muted">Could not read this layer here.</span>
          : value !== null
            ? <span className={`font-mono text-[22px] font-semibold tabular-nums text-text transition-opacity ${updating ? 'opacity-50' : ''}`}>{value}</span>
            : status === 'loading'
              ? <span className="text-[13px] text-muted">Reading value...</span>
              : <span className="text-[13px] text-muted">No data at this point</span>}
        {updating && (
          <span className="absolute right-2 top-2 h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
        )}
      </div>

      <dl className="flex flex-col">
        {selection.riskClass && (
          <Row label="Class">
            <span
              className="inline-flex items-center gap-1.5 rounded-cb-sm px-2 py-0.5 text-[12px] font-semibold"
              style={{ color: selection.riskClass.textColor ?? selection.riskClass.color }}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: selection.riskClass.color }} />
              {selection.riskClass.name}
            </span>
          </Row>
        )}
        {selection.legendTitle && <Row label="Band">{selection.legendTitle}</Row>}
        {def.level ? <Row label="Level">{def.levelLabel}</Row> : null}
        {selection.leadHours != null && <Row label="Lead">{`+${selection.leadHours}h`}</Row>}
        <Row label="Coordinates">
          <span className="font-mono text-[11.5px]">Lat {lat.toFixed(3)}, Lng {lng.toFixed(3)}</span>
        </Row>
      </dl>

      <div className="mt-3 flex items-center gap-1.5 text-[10.5px] text-muted">
        <TbCurrentLocation className="shrink-0" aria-hidden />
        Value sampled from the pixel under the cursor.
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Chip color={def.color}>{def.label}</Chip>
        {def.modelLabel && <Chip>{def.modelLabel}</Chip>}
      </div>
    </Panel>
  )
}
