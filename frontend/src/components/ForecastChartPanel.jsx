// The forecast trend chart.
//
// Opened from a selected boundary in the Map view. It reduces one temporal layer
// over that region at every published lead (server side, the same geometry the
// map draws) and plots the trend. The model, the variable, the reducer and the
// chart type are all switchable here, and the fill is a gradient ramp chosen for
// the parameter, blue to green for rain, amber to red for temperature and so on.
// Charts are the one place a gradient is wanted here, at the owner's request.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ResponsiveContainer, ComposedChart, Area, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip
} from 'recharts'
import { TbX, TbChartLine, TbChartArea, TbChartBar, TbChevronDown, TbCheck, TbClockPause } from 'react-icons/tb'

import { useAsync } from '@/hooks/useAsync'
import { getForecastTimeseries } from '@/lib/api'
import { fmtNumber, fmtUnit } from '@/lib/format'

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

// Axis and grid colours for the chart, keyed on the theme. Derived from the
// isDark flag rather than read off the DOM: the theme attribute is applied in an
// effect after render, so reading a CSS variable mid-toggle returns the previous
// theme's value and the recharts strokes, being literal colours, would stay
// stale. The grid is kept faint on purpose so it sits behind the trend, while the
// tick text stays readable.
function themeColors (isDark) {
  return isDark
    ? { axis: '#b6bfcd', grid: 'rgba(255,255,255,0.08)' }
    : { axis: '#5b6672', grid: 'rgba(15,23,42,0.08)' }
}

const kindLabel = (kind) => (kind === 'iiojk' ? 'IIOJK district' : kind === 'tehsil' ? 'Tehsil' : 'District')

const variableLabel = (l) => `${l.label}${l.level ? ` ${l.levelLabel}` : ''}`

// Switching model keeps the variable where it can: the same band first, then the
// same element at any level, so moving GRAPES -> WRFPRS on CAPE stays on CAPE
// rather than snapping back to the first row.
function pickLayerForModel (layers, modelId, prev) {
  const inModel = layers.filter((l) => l.modelId === modelId)
  if (!inModel.length) return null
  if (prev) {
    return (
      inModel.find((l) => l.band === prev.band) ||
      inModel.find((l) => l.element === prev.element && l.level === prev.level) ||
      inModel.find((l) => l.element === prev.element) ||
      inModel[0]
    ).id
  }
  return inModel[0].id
}

export default function ForecastChartPanel ({
  region, layers, models = [], availability = {}, initialModelId, initialLayerId, isDark = false, onClose
}) {
  const initialLayer = layers.find((l) => l.id === initialLayerId)
  const [modelId, setModelId] = useState(
    initialLayer?.modelId || initialModelId || models[0]?.modelId
  )
  const [layerId, setLayerId] = useState(
    () => initialLayerId || pickLayerForModel(layers, initialLayer?.modelId || initialModelId || models[0]?.modelId, null)
  )
  const [reducer, setReducer] = useState('mean')
  const [chartType, setChartType] = useState('area')

  const modelHasCycle = (mid) => layers.some((l) => l.modelId === mid && availability[l.id]?.ok !== false)
  const variables = useMemo(() => layers.filter((l) => l.modelId === modelId), [layers, modelId])

  const changeModel = (mid) => {
    const prev = layers.find((l) => l.id === layerId)
    setModelId(mid)
    setLayerId(pickLayerForModel(layers, mid, prev))
  }

  const modelOptions = models.map((m) => ({
    value: m.modelId,
    label: m.modelLabel,
    disabled: !modelHasCycle(m.modelId),
    title: modelHasCycle(m.modelId) ? m.modelLabel : `${m.modelLabel} (no cycle ingested yet)`
  }))
  const variableOptions = variables.map((l) => ({
    value: l.id,
    label: variableLabel(l),
    disabled: availability[l.id]?.ok === false,
    title: availability[l.id]?.ok === false ? `${variableLabel(l)} (no cycle ingested yet)` : variableLabel(l)
  }))

  const series = useAsync(
    (signal) => getForecastTimeseries(layerId, region.kind, region.key, reducer, signal),
    [layerId, region.kind, region.key, reducer],
    { enabled: Boolean(layerId && region.key) }
  )

  return (
    <Panel
      title="Forecast trend"
      icon={TbChartArea}
      className="max-h-[calc(100vh-9rem)] w-[min(920px,calc(100vw-2rem))]"
      bodyClassName="px-3 py-3"
      actions={<IconButton icon={TbX} label="Close" size="sm" tone="ghost" onClick={onClose} />}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-bold leading-tight text-text">{region.name}</p>
          <p className="text-[11px] font-medium text-muted">{kindLabel(region.kind)}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ThemedSelect tag="Model" ariaLabel="Forecast model" value={modelId} options={modelOptions} onChange={changeModel} className="min-w-[8.5rem]" />
          <ThemedSelect tag="Variable" ariaLabel="Forecast variable" value={layerId} options={variableOptions} onChange={setLayerId} className="min-w-[12rem]" />
          <Segmented options={REDUCERS} value={reducer} onChange={setReducer} />
          <Segmented options={CHART_TYPES} value={chartType} onChange={setChartType} iconOnly />
        </div>
      </div>

      <Body series={series} chartType={chartType} isDark={isDark} />
    </Panel>
  )
}

// A themed dropdown matching the model/level selectors in the layers panel: a
// bordered trigger with an uppercase tag and the current value, and a menu
// rendered in a portal so the panel's own scroll and overflow never clip it.
export function ThemedSelect ({ tag, ariaLabel, value, options, onChange, className = '' }) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const btnRef = useRef(null)
  const current = options.find((o) => o.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    setRect(btnRef.current?.getBoundingClientRect() ?? null)
    const close = () => setOpen(false)
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target)) return
      if (e.target.closest?.('[data-themed-menu]')) return
      setOpen(false)
    }
    // Close on an outside scroll (the panel or the page moving under a pinned
    // menu), but not when the scroll is the menu's own list scrolling: that is
    // the user reading a long variable list, not leaving it.
    const onScroll = (e) => {
      if (e.target?.closest?.('[data-themed-menu]')) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <div className={className}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`flex w-full items-center gap-2 rounded-cb-sm border px-2.5 py-1.5 text-left transition-colors ${
          open ? 'border-primary bg-primary-soft' : 'border-border bg-panel-2 hover:border-border-strong'
        }`}
      >
        <span className="shrink-0 leading-none text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">{tag}</span>
        <span className="min-w-0 flex-1 truncate leading-none text-[12.5px] font-semibold text-text">{current?.label}</span>
        <TbChevronDown className={`shrink-0 text-[13px] text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && rect && createPortal(
        <ul
          data-themed-menu
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: 'fixed',
            top: rect.bottom + 4,
            left: rect.left,
            width: rect.width,
            boxShadow: '0 8px 24px rgba(16,24,40,0.16)'
          }}
          className="z-[70] max-h-[18rem] overflow-auto rounded-cb-sm border border-border bg-panel"
        >
          {options.map((o) => {
            const active = o.value === value
            return (
              <li key={o.value} role="option" aria-selected={active}>
                <button
                  type="button"
                  disabled={o.disabled}
                  onClick={() => { onChange(o.value); setOpen(false) }}
                  title={o.title || o.label}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                    active
                      ? 'bg-primary-soft font-semibold text-primary'
                      : o.disabled
                        ? 'cursor-not-allowed text-muted opacity-60'
                        : 'text-text-2 hover:bg-panel-2 hover:text-text'
                  }`}
                >
                  {o.disabled && <TbClockPause className="shrink-0 text-[12px]" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {active && <TbCheck className="shrink-0 text-[12px]" aria-hidden />}
                </button>
              </li>
            )
          })}
        </ul>,
        document.body
      )}
    </div>
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
            className={`flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] font-semibold transition-colors ${
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

function Body ({ series, chartType, isDark }) {
  const result = series.data
  // The cycle comes from the series itself, so a chart of one model's run reads
  // its own time base even after the map's active model has moved elsewhere.
  const cycleMs = useMemo(
    () => (result?.creationTime ? new Date(result.creationTime).getTime() : 0),
    [result?.creationTime]
  )
  const data = useMemo(
    () => (result?.points ?? []).map((p) => ({ value: p.value, ms: cycleMs + p.lead * 3600_000 })),
    [result, cycleMs]
  )

  // Only the very first load shows the loading bar. A model, variable or reducer
  // change keeps the last chart on screen (dimmed) while the next series loads,
  // so the panel never collapses to a short spinner and snaps back: switching
  // Mean/Max now behaves exactly like switching the chart type.
  if (!result) {
    if (series.isError) {
      return (
        <div className="rounded-cb-sm border border-danger-border bg-danger-soft px-3 py-2.5 text-[11.5px] text-danger">
          <p className="font-semibold">Could not load the trend</p>
          <p className="mt-0.5 opacity-90">{series.error.message}</p>
        </div>
      )
    }
    return <LoadingBar label="Loading forecast trend…" />
  }

  const theme = themeColors(isDark)
  const [lowC, highC] = RAMP[result.category] || DEFAULT_RAMP
  const gid = `fc-grad-${result.band}`
  const unit = result.unit
  const withData = data.some((d) => d.value != null)

  const fmtTick = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' })

  return (
    <div className={series.isLoading ? 'opacity-55 transition-opacity duration-150' : 'transition-opacity duration-150'}>
      <p className="mb-2 text-[12px] text-text-2">
        <span className="font-bold text-text">{result.modelLabel || result.model}</span> cycle
        {' · '}reduced over the region boundary
        {unit ? <> {' · '}<span className="font-semibold text-text">{fmtUnit(unit)}</span></> : null}
      </p>

      {!withData ? (
        <p className="py-10 text-center text-[12px] text-muted">No values for this variable over this region.</p>
      ) : (
        <ResponsiveContainer width="100%" height={222}>
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
              tick={{ fill: theme.axis, fontSize: 11, fontWeight: 600 }}
              minTickGap={54}
              tickLine={false}
              stroke={theme.grid}
            />
            <YAxis
              tick={{ fill: theme.axis, fontSize: 11, fontWeight: 600 }}
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
      <div className="font-semibold text-text">{fmtNumber(p.value, 2)}{unit ? ` ${fmtUnit(unit)}` : ''}</div>
    </div>
  )
}
