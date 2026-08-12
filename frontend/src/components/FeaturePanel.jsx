// Feature inspector.
//
// Shows whatever the clicked layer declares in its `properties` contract entry,
// in the order the contract lists them. No per layer markup, so a new layer
// gets a working inspector the moment its contract entry exists.

import { TbInfoCircle, TbX, TbMapPin } from 'react-icons/tb'

import { Panel, IconButton, Chip } from './ui/Panel'
import { LayerSwatch } from './LayerLegend'

// Presentation only. Values themselves are never rounded before display
// anywhere they might be used for a calculation.
const LABELS = {
  district_code: 'Code',
  district_name: 'District',
  tehsil_code: 'Code',
  tehsil: 'Tehsil',
  district_src: 'District (as filed)',
  province_code: 'Province code',
  province: 'Province',
  national_code: 'Code',
  name: 'Name',
  division: 'Division',
  population: 'Population',
  area_km2: 'Area',
  location_name: 'Location',
  occurrence: 'Occurrence',
  rainfall_mm: 'Rainfall',
  cape_j_kg: 'CAPE',
  elevation_m: 'Elevation',
  slope_deg: 'Slope'
}

const UNITS = {
  area_km2: 'km²',
  rainfall_mm: 'mm',
  cape_j_kg: 'J/kg',
  elevation_m: 'm',
  slope_deg: '°'
}

function formatValue (key, value) {
  // A hyphen, not an em dash. No em-dashes anywhere is a project rule and it
  // covers UI strings, not just prose.
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'number') {
    const decimals = key === 'area_km2' ? 1 : key === 'slope_deg' ? 1 : 0
    return `${value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    })}${UNITS[key] ? ` ${UNITS[key]}` : ''}`
  }
  return String(value)
}

export default function FeaturePanel ({ selection, onClose }) {
  if (!selection?.layer) return null

  const { layer, properties } = selection
  const fields = (layer.properties ?? []).filter((k) => k !== layer.labelField)
  const title = properties?.[layer.labelField] ?? layer.label

  return (
    <Panel
      title={layer.label}
      icon={TbInfoCircle}
      accent={layer.color}
      className="w-[320px]"
      bodyClassName="px-3 py-3"
      actions={<IconButton icon={TbX} label="Close" size="sm" tone="ghost" onClick={onClose} />}
    >
      <div className="mb-3 flex items-start gap-2.5">
        <LayerSwatch color={layer.color} render={layer.legend?.render} className="mt-1" />
        <div className="min-w-0">
          <h3 className="truncate text-[16px] font-semibold leading-tight text-text">{title}</h3>
          {properties?.province && properties.province !== title && (
            <p className="mt-0.5 truncate text-[11.5px] text-muted">{properties.province}</p>
          )}
        </div>
      </div>

      <dl className="flex flex-col">
        {fields.map((key) => {
          const value = properties?.[key]
          if (value === undefined) return null
          return (
            <div
              key={key}
              className="flex items-baseline justify-between gap-3 border-b border-border py-[7px] last:border-b-0"
            >
              <dt className="shrink-0 text-[11.5px] text-muted">{LABELS[key] ?? key}</dt>
              <dd
                className={`min-w-0 truncate text-right text-[12.5px] font-medium text-text ${
                  key.endsWith('_code') ? 'font-mono text-[11.5px]' : ''
                }`}
              >
                {formatValue(key, value)}
              </dd>
            </div>
          )
        })}
      </dl>

      {/* Population is genuinely absent for the disputed districts rather than
          zero, and saying so beats rendering a dash with no explanation. */}
      {properties?.population == null && layer.id.includes('district') && (
        <p className="mt-3 flex items-start gap-1.5 rounded-cb-sm border border-border bg-panel-2 px-2.5 py-2 text-[11px] leading-snug text-muted">
          <TbMapPin className="mt-[2px] shrink-0" aria-hidden />
          Population is not published for this district in the source boundary file.
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Chip color={layer.color}>{layer.label}</Chip>
        {properties?.province_code && <Chip>{properties.province_code}</Chip>}
      </div>
    </Panel>
  )
}
