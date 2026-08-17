// The forecast trend chart.
//
// Opened from a selected boundary in the Map view. It reduces one temporal layer
// over that region at every published lead (server side, the same geometry the
// map draws) and plots the trend. The variable, the reducer and the chart type
// are all switchable, and the fill is a gradient ramp chosen for the parameter,
// blue to green for rain, amber to red for temperature and so on. Charts are the
// one place a gradient is wanted here, at the owner's request.

import { useMemo, useState } from 'react'
import {
  ResponsiveContainer, ComposedChart, Area, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip
} from 'recharts'
import { TbX, TbChartLine, TbChartArea, TbChartBar } from 'react-icons/tb'

import { useAsync } from '@/hooks/useAsync'
import { getForecastTimeseries } from '@/lib/api'
import { fmtNumber } from '@/lib/format'

import { Panel, IconButton } from './ui/Panel'
import { LoadingBar } from './ui/Loading'

// Low value colour to high value colour, per parameter family. The gradient runs
// from the high colour at the top to a faded low colour at the baseline.
const RAMP = {
  rainfall: ['#2563eb', '#10b981'],   // blue to green
  moisture: ['#0891b2', '#2563eb'],   // cyan to blue
  instability: ['#f59e0b', '#dc2626'], // amber to red
  dynamics: ['#8b5cf6', '#6d28d9'],   // violet
  orographic: ['#84cc16', '#166534']  // lime to deep green
}
const DEFAULT_RAMP = ['#2563eb', '#7c3aed']

const CHART_TYPES = [
  { id: 'area', label: 'Area', icon: TbChartArea },
  { id: 'line', label: 'Line', icon: TbChartLine },
  { id: 'bar', label: 'Bars', icon: TbChartBar }
]
const REDUCERS = [
  { id: 'mean', label: 'Mean' },
  { id: 'max', label: 'Max' }
]

// Read the theme tokens so the axes and grid follow light and dark. Captured at
// render, and the panel re-renders on a theme toggle, so it stays in step.
function themeColors () {
  const css = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null
  const get = (name, fb) => (css ? css.getPropertyValue(name).trim() : '') || fb
  return {
    muted: get('--cb-muted', '#94a3b8'),
    grid: get('--cb-border', '#e2e8f0')
  }
}

const kindLabel = (kind) => (kind === 'iiojk' ? 'IIOJK district' : kind === 'tehsil' ? 'Tehsil' : 'District')

export default function ForecastChartPanel ({ region, layers, initialLayerId, creationTime, onClose }) {
  const [layerId, setLayerId] = useState(initialLayerId || layers[0]?.id)
  const [reducer, setReducer] = useState('mean')
  const [chartType, setChartType] = useState('area')

  const series = useAsync(
    (signal) => getForecastTimeseries(layerId, region.kind, region.key, reducer, signal),
    [layerId, region.kind, region.key, reducer],
    { enabled: Boolean(layerId && region.key) }
  )

  return (
    <Panel
      title="Forecast trend"
      icon={TbChartArea}
      className="max-h-[calc(100vh-9rem)] w-[min(860px,calc(100vw-1.5rem))]"
      bodyClassName="px-3 py-3"
      actions={<IconButton icon={TbX} label="Close" size="sm" tone="ghost" onClick={onClose} />}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold leading-tight text-text">{region.name}</p>
          <p className="text-[11px] text-muted">{kindLabel(region.kind)}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            value={layerId}
            onChange={(e) => setLayerId(e.target.value)}
            aria-label="Forecast variable"
            className="rounded-cb-sm border border-border bg-panel-2 px-2 py-1 text-[12px] font-medium text-text"
          >
            {layers.map((l) => (
              <option key={l.id} value={l.id}>{l.label}{l.level ? ` ${l.levelLabel}` : ''}</option>
            ))}
          </select>
          <Segmented options={REDUCERS} value={reducer} onChange={setReducer} />
          <Segmented options={CHART_TYPES} value={chartType} onChange={setChartType} iconOnly />
        </div>
      </div>

      <Body series={series} chartType={chartType} creationTime={creationTime} />
    </Panel>
  )
}

function Segmented ({ options, value, onChange, iconOnly }) {
  return (
    <div className="flex items-center gap-0.5 rounded-cb-sm border border-border bg-panel-2 p-0.5">
      {options.map((o) => {
        const active = o.id === value
        const Icon = o.icon
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            title={o.label}
            aria-label={o.label}
            aria-pressed={active}
            className={`flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] font-medium transition-colors ${
              active ? 'bg-primary-soft text-primary' : 'text-text-2 hover:text-text'
            }`}
          >
            {iconOnly && Icon ? <Icon className="text-[14px]" aria-hidden /> : o.label}
          </button>
        )
      })}
    </div>
  )
}

function Body ({ series, chartType, creationTime }) {
  const result = series.data
  const cycleMs = useMemo(() => (creationTime ? new Date(creationTime).getTime() : 0), [creationTime])
  const data = useMemo(
    () => (result?.points ?? []).map((p) => ({ value: p.value, ms: cycleMs + p.lead * 3600_000 })),
    [result, cycleMs]
  )

  if (series.isLoading || (!series.data && !series.isError)) {
    return <LoadingBar label="Loading forecast trend…" />
  }
  if (series.isError) {
    return (
      <div className="rounded-cb-sm border border-danger-border bg-danger-soft px-3 py-2.5 text-[11.5px] text-danger">
        <p className="font-semibold">Could not load the trend</p>
        <p className="mt-0.5 opacity-90">{series.error.message}</p>
      </div>
    )
  }

  const theme = themeColors()
  const [lowC, highC] = RAMP[result.category] || DEFAULT_RAMP
  const gid = `fc-grad-${result.band}`
  const unit = result.unit
  const withData = data.some((d) => d.value != null)

  const fmtTick = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })

  return (
    <div>
      <p className="mb-1.5 text-[11px] text-muted">
        {result.modelLabel || result.model} cycle · reduced over the region boundary
        {unit ? ` · ${unit}` : ''}
      </p>

      {!withData ? (
        <p className="py-10 text-center text-[12px] text-muted">No values for this variable over this region.</p>
      ) : (
        <ResponsiveContainer width="100%" height={296}>
          <ComposedChart data={data} margin={{ top: 8, right: 14, bottom: 2, left: -6 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={highC} stopOpacity={0.85} />
                <stop offset="100%" stopColor={lowC} stopOpacity={0.12} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={theme.grid} strokeDasharray="2 3" vertical={false} />
            <XAxis
              dataKey="ms"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={fmtTick}
              tick={{ fill: theme.muted, fontSize: 10 }}
              minTickGap={54}
              tickLine={false}
              stroke={theme.grid}
            />
            <YAxis
              tick={{ fill: theme.muted, fontSize: 10 }}
              tickFormatter={(v) => fmtNumber(v, 0)}
              tickLine={false}
              width={46}
              stroke={theme.grid}
            />
            <Tooltip content={<ChartTooltip unit={unit} />} />
            {chartType === 'area' && (
              <Area type="monotone" dataKey="value" stroke={highC} strokeWidth={2} fill={`url(#${gid})`} connectNulls dot={false} activeDot={{ r: 3 }} />
            )}
            {chartType === 'line' && (
              <Line type="monotone" dataKey="value" stroke={highC} strokeWidth={2} dot={false} connectNulls activeDot={{ r: 3 }} />
            )}
            {chartType === 'bar' && (
              <Bar dataKey="value" fill={`url(#${gid})`} radius={[2, 2, 0, 0]} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

function ChartTooltip ({ active, payload, unit }) {
  if (!active || !payload?.length) return null
  const p = payload[0]
  if (p.value == null) return null
  const when = new Date(p.payload.ms).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
  return (
    <div className="rounded-cb-sm border border-border bg-panel px-2.5 py-1.5 text-[11px] shadow-cb-lg">
      <div className="text-muted">{when}</div>
      <div className="font-semibold text-text">{fmtNumber(p.value, 2)}{unit ? ` ${unit}` : ''}</div>
    </div>
  )
}
