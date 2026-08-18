// The CARI detail card, top right beside the map controls.
//
// Shown in the Analysis view when a district or tehsil is clicked. It scores the
// clicked feature at the current lead and lays the result out as a headline risk
// block over a per variable breakdown, so the number on the choropleth and the
// reason for it are read in the same place. Districts and tehsils share this one
// card; only which endpoint is called differs.

import { useEffect, useMemo, useState } from 'react'
import { TbCloudStorm, TbX } from 'react-icons/tb'

import { useAsync } from '@/hooks/useAsync'
import { getCari, getCariTehsil } from '@/lib/api'
import { contrastText } from '@/lib/color'
import { cariClasses } from '@/lib/contracts'
import { fmtPercent } from '@/lib/format'

import { Panel, IconButton } from './ui/Panel'
import { LoadingBar } from './ui/Loading'

const TEHSIL_LAYERS = new Set(['pak_tehsils'])

// What was clicked, reduced to what the score endpoints need: a kind, the key
// to score by, and a label to show. Tehsils score by tehsil_code because the
// name is not unique; districts score by district_name, the join key.
function featureOf (selection) {
  const layerId = selection?.layer?.id
  const props = selection?.properties
  if (!layerId || !props) return null
  if (TEHSIL_LAYERS.has(layerId)) {
    return { kind: 'tehsil', key: props.tehsil_code, label: props.tehsil, sub: props.district_src }
  }
  return { kind: 'district', key: props.district_name, label: props.district_name, sub: props.province }
}

export default function CariCard ({ selection, leadHours, onClose }) {
  const feature = useMemo(() => featureOf(selection), [selection])

  const cari = useAsync(
    (signal) =>
      feature.kind === 'tehsil'
        ? getCariTehsil(feature.key, leadHours, null, signal)
        : getCari(feature.key, leadHours, null, signal),
    [feature?.kind, feature?.key, leadHours],
    { enabled: Boolean(feature?.key) }
  )

  // The score currently on screen. Stepping the timeline refetches, but rather
  // than collapse the whole card to a loading bar each slot, the last result is
  // held and its numbers update in place when the next lands, so the card looks
  // steady. Cleared when the selected feature changes, where a clean load is
  // right: a new district should not briefly wear the previous one's score.
  const [shown, setShown] = useState(null)
  useEffect(() => { setShown(null) }, [feature?.kind, feature?.key])
  useEffect(() => {
    if (cari.isReady && cari.data) setShown(cari.data)
  }, [cari.isReady, cari.data])

  if (!feature) return null

  return (
    <Panel
      title={<span className="normal-case">CAR Index</span>}
      icon={TbCloudStorm}
      accent={shown?.riskColor}
      className="max-h-[calc(100vh-7rem)] w-[300px]"
      bodyClassName="px-3 py-3"
      actions={<IconButton icon={TbX} label="Close" size="sm" tone="ghost" onClick={onClose} />}
    >
      <Body feature={feature} shown={shown} cari={cari} />
    </Panel>
  )
}

function Body ({ feature, shown, cari }) {
  // No held score yet: this is the first load of the selected feature (or it
  // errored before any result). Once a score is held, a lead change keeps it on
  // screen and only its numbers change, so the card never collapses mid-scrub.
  if (!shown) {
    if (cari.isError) {
      const pending = cari.error.code === 'NOT_CONFIGURED'
      return (
        <div className={`rounded-cb-sm border px-3 py-2.5 text-[11.5px] leading-snug ${
          pending ? 'border-amber-border bg-amber-soft text-amber' : 'border-danger-border bg-danger-soft text-danger'
        }`}
        >
          <p className="font-semibold">{pending ? 'Not scored yet' : 'Could not score this feature'}</p>
          <p className="mt-0.5 opacity-90">{cari.error.message}</p>
        </div>
      )
    }
    return <LoadingBar label={`Scoring ${feature.label}…`} />
  }

  const result = shown

  return (
    <div className="space-y-3">
      <div className="min-w-0">
        <h3 className="truncate text-[15px] font-semibold leading-tight text-text">{feature.label}</h3>
        <div className="mt-0.5 flex items-center gap-2">
          {feature.sub && (
            <p className="min-w-0 truncate text-[11.5px] text-muted">{feature.sub}</p>
          )}
          <span className="ml-auto inline-flex shrink-0 items-center justify-center rounded-full border border-primary-border bg-primary-soft px-2.5 py-1 text-[10px] font-semibold leading-none text-primary">
            {result.matrix === 'terrain' ? 'Terrain' : 'Lowland'}
          </span>
        </div>
      </div>

      <div
        className="rounded-cb-sm px-3 py-3 text-center"
        style={{ background: result.riskColor, color: contrastText(result.riskColor) }}
      >
        <p className="text-[26px] font-bold leading-none">{fmtPercent(result.cari)}</p>
        <p className="mt-1 text-[12.5px] font-medium">{result.riskLevel}</p>
        {result.overrideApplied && (
          <p className="mt-1 text-[10.5px] opacity-90">Raised by the primary extreme rule</p>
        )}
      </div>

      <ClassLegend classes={cariClasses()} activeIdx={result.classIdx} />
    </div>
  )
}

function ClassLegend ({ classes, activeIdx }) {
  return (
    <div>
      <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted">Risk classes</p>
      <ul className="flex flex-col gap-0.5">
        {classes.map((c) => {
          const active = c.idx === activeIdx
          return (
            <li
              key={c.idx}
              className="flex items-center gap-2 rounded-[5px] px-1.5 py-[3px] text-[10.5px] transition-colors"
              style={active ? { background: `${c.color}22`, boxShadow: `inset 0 0 0 1px ${c.color}66` } : undefined}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: c.color, border: '1px solid rgba(16,24,40,0.14)' }}
              />
              <span className={`min-w-0 flex-1 truncate ${active ? 'font-semibold text-text' : 'text-text-2'}`}>{c.name}</span>
              {active && <span className="shrink-0 text-[9px] font-semibold text-text-2">current</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
