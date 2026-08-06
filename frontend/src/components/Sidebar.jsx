import { FiAlertTriangle, FiLayers, FiMapPin } from 'react-icons/fi'
import { TbChartHistogram } from 'react-icons/tb'

import Legend from '@/components/Legend'
import Section from '@/components/Section'
import Toggle from '@/components/Toggle'
import AlertsPanel from '@/features/alerts/AlertsPanel'
import DistrictPanel from '@/features/district/DistrictPanel'
import { bandsByCategory, contracts } from '@/lib/contracts'

export default function Sidebar ({
  visibleLayers,
  onToggleLayer,
  activeBand,
  onSelectBand,
  selectedDistrict,
  leadHours
}) {
  const { layers, bands } = contracts()
  const categories = bandsByCategory()
  const band = activeBand ? bands.find((b) => b.key === activeBand) : null

  return (
    <aside className="cb-scroll w-80 shrink-0 overflow-y-auto rounded-cb border border-border bg-panel p-3 shadow-cb max-lg:hidden">
      <Section icon={FiLayers} title="Boundaries" badge={visibleLayers.size || null} defaultOpen>
        {layers.map((layer) => (
          <Toggle
            key={layer.id}
            label={layer.label}
            checked={visibleLayers.has(layer.id)}
            onChange={() => onToggleLayer(layer.id)}
          />
        ))}
      </Section>

      <Section icon={TbChartHistogram} title="Forecast Variables">
        {categories.map((category) => (
          <div key={category.key} className="mb-3">
            <p
              className="mb-1 border-l-2 pl-2 text-xs font-semibold uppercase tracking-wide"
              style={{ borderColor: category.accent, color: 'var(--cb-text-2)' }}
            >
              {category.label}
            </p>
            {category.bands.map((entry) => (
              <Toggle
                key={entry.key}
                label={entry.label}
                checked={activeBand === entry.key}
                onChange={() => onSelectBand(activeBand === entry.key ? null : entry.key)}
              />
            ))}
          </div>
        ))}

        {band && (
          <Legend
            title={band.legendTitle}
            paletteName={band.palette}
            kind={band.categorical ? 'categorical' : 'continuous'}
            min={band.min}
            max={band.max}
            unit={band.unit}
          />
        )}
      </Section>

      <Section icon={FiMapPin} title="District">
        <DistrictPanel district={selectedDistrict} leadHours={leadHours} />
      </Section>

      <Section icon={FiAlertTriangle} title="Alerts">
        <AlertsPanel />
      </Section>
    </aside>
  )
}
