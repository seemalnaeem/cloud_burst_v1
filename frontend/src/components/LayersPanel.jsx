// The layers dock.
//
// Dense by default, detail on demand, and read left to right: the name is the
// first thing on every row, and the controls that act on it, framing and the
// on/off toggle, sit together on the right where the thumb expects them. The
// colour mark stays next to the name as the at-a-glance legend; the description,
// the value ramp and the opacity slider live behind a chevron because they
// answer a second question that only comes up once you have found your layer.
//
// Layers are grouped into collapsible sections because they behave differently,
// not because grouping looks tidy. Boundaries are always there. Terrain is
// static. Analysis is computed from a cycle. Forecast is temporal and, unlike
// the rest, comes from several models at once, so it carries a model selector:
// one model is active at a time and drives the map and the timeline, matching
// how the source portal itself behaves. A field that a model serves at several
// pressure levels collapses to one row with a level selector rather than a row
// per level, so the section stays short.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  TbStack2, TbEye, TbEyeOff, TbLayersOff, TbClockPause, TbClockHour4,
  TbChevronRight, TbChevronDown, TbCheck, TbViewfinder, TbGripVertical, TbRadar2
} from 'react-icons/tb'

import { LayerSwatch } from './LayerLegend'
import { Panel, IconButton } from './ui/Panel'

// A rod-and-thumb switch: a thin fixed rod with a large thumb that rides along
// it, a hollow ring when off and a solid disc when on. The thumb is SVG, not a
// bordered div, so its stroke rasterises symmetrically about the geometry rather
// than snapping to the device pixel grid one edge at a time, which is what drifts
// a CSS-bordered dot off centre at Windows display scaling of 125 or 150 percent.
function Toggle ({ checked, onChange, color, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`relative h-5 w-10 shrink-0 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
    >
      <span
        className="pointer-events-none absolute left-[5px] right-[5px] top-[9px] h-[2px] rounded-full"
        style={{ background: 'var(--cb-border-strong)' }}
      />
      <svg
        className="pointer-events-none absolute top-[1px] transition-[left] duration-300 ease-in-out"
        style={{ left: checked ? '21px' : '1px' }}
        width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"
      >
        <circle
          cx="9" cy="9" r="6" strokeWidth="3"
          style={{
            fill: checked ? color : 'var(--cb-panel)',
            stroke: checked ? color : 'var(--cb-muted)',
            transition: 'fill 300ms ease-in-out, stroke 300ms ease-in-out'
          }}
        />
      </svg>
    </button>
  )
}

// A palette shown as one small chip, no gradient, so a raster layer's row reads
// as "this is a scaled field" the way a swatch says "this is an outline".
function RampChip ({ colors }) {
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 overflow-hidden rounded-[3px] ring-1 ring-inset ring-[rgba(16,24,40,0.16)]">
      {colors.map((c, i) => <span key={`${c}-${i}`} className="flex-1" style={{ background: c }} />)}
    </span>
  )
}

function DetailScale ({ scale }) {
  if (!scale) return null

  if (scale.kind === 'classes') {
    return (
      <ul className="mt-1.5 flex flex-col gap-1">
        {scale.classes.map((c) => (
          <li key={c.name ?? c.label ?? c.color} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: c.color, border: '1px solid rgba(16,24,40,0.14)' }} />
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-text-2">{c.name ?? c.label}</span>
            {c.min !== undefined && c.max !== undefined
              ? <span className="shrink-0 font-mono text-[9.5px] text-muted">{`${c.min}-${c.max}%`}</span>
              : c.max !== undefined && <span className="shrink-0 font-mono text-[9.5px] text-muted">{`<= ${c.max}`}</span>}
          </li>
        ))}
      </ul>
    )
  }

  if (scale.kind === 'steps') {
    return (
      <div className="mt-1.5">
        <div className="flex h-2 overflow-hidden rounded-[2px] ring-1 ring-inset ring-[rgba(16,24,40,0.1)]">
          {scale.colors.map((c, i) => <span key={`${c}-${i}`} className="flex-1" style={{ background: c }} />)}
        </div>
        <div className="mt-0.5 flex items-center justify-between font-mono text-[9.5px] text-muted">
          <span>{scale.min}</span>
          {scale.unit && <span className="font-sans">{scale.unit}</span>}
          <span>{scale.max}</span>
        </div>
      </div>
    )
  }

  return null
}

// The disclosure body shared by every row: description, value scale, opacity.
function RowDetail ({ description, scale, opacity, onOpacity, color }) {
  return (
    <div className="px-2 pb-2.5 pl-[38px] pr-3">
      {description && <p className="text-[11px] leading-snug text-muted">{description}</p>}
      <DetailScale scale={scale} />
      {onOpacity && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[10px] text-muted">Opacity</span>
          <input
            type="range"
            min="10"
            max="100"
            value={Math.round(opacity * 100)}
            onChange={(e) => onOpacity(Number(e.target.value) / 100)}
            className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--cb-track)]"
            style={{ accentColor: color }}
          />
          <span className="w-7 shrink-0 text-right font-mono text-[10px] text-muted tabular-nums">
            {Math.round(opacity * 100)}%
          </span>
        </div>
      )}
    </div>
  )
}

// A generic row for vector, terrain and analysis layers. When `reorder` is
// supplied the row grows a drag handle and becomes a drop target, so the
// boundary layers can be restacked from within the panel: the row's position in
// the list is its stacking on the map, top of the list on top of the map.
function LayerRow ({ layer, visible, onToggle, onZoom, count, scale, opacity, onOpacity, unavailable, temporal, reorder, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const disabled = Boolean(unavailable)
  const active = visible && !disabled

  const mark = scale?.kind === 'steps'
    ? <RampChip colors={scale.colors} />
    : scale?.kind === 'classes'
      ? <RampChip colors={scale.classes.map((c) => c.color)} />
      : <LayerSwatch color={layer.color} render={layer.legend?.render} />

  const description = layer.legend?.description
  const hasDetail = !disabled && Boolean(description || scale || onOpacity)

  return (
    <li
      className={`border-b border-border/60 last:border-b-0 ${reorder?.over ? 'bg-primary-soft' : ''} ${reorder?.dragging ? 'opacity-40' : ''}`}
      onDragOver={reorder ? reorder.onDragOver : undefined}
      onDrop={reorder ? reorder.onDrop : undefined}
    >
      <div className={`flex h-9 items-center gap-1.5 px-2 ${disabled ? 'opacity-55' : ''}`}>
        {reorder && (
          <span
            draggable
            onDragStart={reorder.onDragStart}
            onDragEnd={reorder.onDragEnd}
            title="Drag to reorder"
            aria-label={`Reorder ${layer.label}`}
            className="grid h-5 w-3.5 shrink-0 cursor-grab place-items-center text-muted transition-colors hover:text-text active:cursor-grabbing"
          >
            <TbGripVertical className="text-[13px]" aria-hidden />
          </span>
        )}
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Hide details' : 'Show details'}
            aria-expanded={open}
            className="grid h-5 w-4 shrink-0 place-items-center text-muted transition-colors hover:text-text"
          >
            <TbChevronRight className={`text-[12px] transition-transform duration-200 ${open ? 'rotate-90' : ''}`} aria-hidden />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        <MarkWithBadge mark={mark} temporal={temporal} />

        <button
          type="button"
          onClick={hasDetail ? () => setOpen((v) => !v) : undefined}
          title={description || layer.label}
          className={`min-w-0 flex-1 truncate text-left text-[12.5px] font-medium ${active ? 'text-text' : 'text-text-2'} ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
        >
          {layer.label}
        </button>

        {count != null && (
          <span className="shrink-0 font-mono text-[10px] text-muted tabular-nums">{count}</span>
        )}

        {disabled ? (
          <TbClockPause className="mr-1 shrink-0 text-[13px] text-muted" aria-hidden title={unavailable} />
        ) : (
          <>
            {onZoom && (
              <IconButton icon={TbViewfinder} label={`Zoom to ${layer.label}`} size="sm" tone="ghost" onClick={onZoom} />
            )}
            <Toggle checked={active} onChange={onToggle} color={layer.color} label={`Toggle ${layer.label}`} />
          </>
        )}
      </div>

      {open && hasDetail && (
        <RowDetail description={description} scale={scale} opacity={opacity} onOpacity={onOpacity} color={layer.color} />
      )}
    </li>
  )
}

// The colour mark, with a small clock riding its top-right corner when the layer
// varies over time. A superscript badge rather than another control on the
// right: it is a property of the layer, read alongside the name.
function MarkWithBadge ({ mark, temporal }) {
  return (
    <span className="relative grid h-3.5 w-3.5 shrink-0 place-items-center">
      {mark}
      {temporal && (
        <span
          className="absolute -right-1.5 -top-1.5 grid h-[11px] w-[11px] place-items-center rounded-full bg-panel text-primary ring-1 ring-inset ring-[var(--cb-border-strong)]"
          title="Time-varying layer, driven by the forecast timeline"
        >
          <TbClockHour4 className="text-[8px]" aria-hidden />
        </span>
      )}
    </span>
  )
}

// A themed level selector. A native select cannot be styled past its trigger,
// the option list is drawn by the operating system, so this is a custom listbox.
// The menu is portalled to the body and positioned from the trigger's rect, so
// the scrolling layers panel cannot clip it, and it closes on an outside press,
// a scroll or a resize.
function LevelSelect ({ levels, value, onChange, label }) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const btnRef = useRef(null)
  const current = levels.find((l) => l.level === value) ?? levels[0]

  useEffect(() => {
    if (!open) return
    setRect(btnRef.current?.getBoundingClientRect() ?? null)
    const close = () => setOpen(false)
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target)) return
      if (e.target.closest?.('[data-level-menu]')) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const WIDTH = 116

  return (
    <div className="shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className={`flex items-center gap-1 rounded-cb-sm border py-0.5 pl-2 pr-1 text-[10.5px] font-semibold transition-colors ${
          open
            ? 'border-primary bg-primary-soft text-primary'
            : 'border-border bg-panel-2 text-text-2 hover:border-border-strong hover:text-text'
        }`}
      >
        <span className="tabular-nums">{current.levelLabel}</span>
        <TbChevronDown className={`text-[11px] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && rect && createPortal(
        <ul
          data-level-menu
          role="listbox"
          aria-label={label}
          style={{
            position: 'fixed',
            top: rect.bottom + 4,
            left: Math.max(8, rect.right - WIDTH),
            width: WIDTH,
            boxShadow: '0 8px 24px rgba(16,24,40,0.16)'
          }}
          className="z-[60] overflow-hidden rounded-cb-sm border border-border bg-panel"
        >
          {levels.map((l) => {
            const active = l.level === value
            return (
              <li key={l.level} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => { onChange(l.level); setOpen(false) }}
                  className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                    active ? 'bg-primary-soft font-semibold text-primary' : 'text-text-2 hover:bg-panel-2 hover:text-text'
                  }`}
                >
                  <span className="tabular-nums">{l.levelLabel}</span>
                  {active && <TbCheck className="text-[11px]" aria-hidden />}
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

// The model selector, a themed dropdown. One model is active at a time and it
// drives the map and the timeline, so this is a single choice, not a row of
// tags. Models without an ingested cycle are listed but disabled, so the absence
// reads as pending rather than missing. Same portaled listbox as the level
// selector, full width, so the scrolling panel cannot clip it.
function ModelSelect ({ models, value, available, onSelect }) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const btnRef = useRef(null)
  const current = models.find((m) => m.modelId === value) ?? models[0]

  useEffect(() => {
    if (!open) return
    setRect(btnRef.current?.getBoundingClientRect() ?? null)
    const close = () => setOpen(false)
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target)) return
      if (e.target.closest?.('[data-model-menu]')) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <div>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Forecast model"
        className={`flex w-full items-center gap-2 rounded-cb-sm border px-2.5 py-1.5 text-left transition-colors ${
          open ? 'border-primary bg-primary-soft' : 'border-border bg-panel-2 hover:border-border-strong'
        }`}
      >
        <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">Model</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-text">{current?.modelLabel}</span>
        <TbChevronDown className={`shrink-0 text-[13px] text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && rect && createPortal(
        <ul
          data-model-menu
          role="listbox"
          aria-label="Forecast model"
          style={{
            position: 'fixed',
            top: rect.bottom + 4,
            left: rect.left,
            width: rect.width,
            boxShadow: '0 8px 24px rgba(16,24,40,0.16)'
          }}
          className="z-[60] overflow-hidden rounded-cb-sm border border-border bg-panel"
        >
          {models.map((m) => {
            const active = m.modelId === value
            const ok = available(m.modelId)
            return (
              <li key={m.modelId} role="option" aria-selected={active}>
                <button
                  type="button"
                  disabled={!ok}
                  onClick={() => { onSelect(m.modelId); setOpen(false) }}
                  title={ok ? m.modelFull : `${m.modelFull} (no cycle ingested yet)`}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                    active
                      ? 'bg-primary-soft font-semibold text-primary'
                      : ok
                        ? 'text-text-2 hover:bg-panel-2 hover:text-text'
                        : 'cursor-not-allowed text-muted opacity-60'
                  }`}
                >
                  {!ok && <TbClockPause className="shrink-0 text-[12px]" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{m.modelLabel}</span>
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

// A forecast element row. One element of the active model, collapsing its levels
// into a single row with a level selector when it has more than one.
function ForecastRow ({ element, activeDef, levels, activeLevel, onLevel, visible, onToggle, scale, opacity, onOpacity, unavailable }) {
  const [open, setOpen] = useState(false)
  const disabled = Boolean(unavailable)
  const active = visible && !disabled
  const mark = scale?.kind === 'steps'
    ? <RampChip colors={scale.colors} />
    : <LayerSwatch color={activeDef.color} render="steps" />
  const description = activeDef.legend?.description
  const hasDetail = !disabled && Boolean(description || scale || onOpacity)

  return (
    <li className="border-b border-border/60 last:border-b-0">
      <div className={`flex h-9 items-center gap-1.5 px-2 ${disabled ? 'opacity-55' : ''}`}>
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Hide details' : 'Show details'}
            aria-expanded={open}
            className="grid h-5 w-4 shrink-0 place-items-center text-muted transition-colors hover:text-text"
          >
            <TbChevronRight className={`text-[12px] transition-transform duration-200 ${open ? 'rotate-90' : ''}`} aria-hidden />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}

        <MarkWithBadge mark={mark} temporal />

        <button
          type="button"
          onClick={hasDetail ? () => setOpen((v) => !v) : undefined}
          title={description || element.label}
          className={`min-w-0 flex-1 truncate text-left text-[12.5px] font-medium ${active ? 'text-text' : 'text-text-2'} ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
        >
          {element.label}
        </button>

        {levels.length > 1 && (
          <LevelSelect
            levels={levels}
            value={activeLevel}
            onChange={onLevel}
            label={`${element.label} level`}
          />
        )}

        {disabled ? (
          <TbClockPause className="mr-1 shrink-0 text-[13px] text-muted" aria-hidden title={unavailable} />
        ) : (
          <Toggle checked={active} onChange={onToggle} color={activeDef.color} label={`Toggle ${element.label}`} />
        )}
      </div>

      {open && hasDetail && (
        <RowDetail description={description} scale={scale} opacity={opacity} onOpacity={onOpacity} color={activeDef.color} />
      )}
    </li>
  )
}

// A CARI layer row for the Analysis view. Unlike a boundary row, its colour is
// not one swatch but a class ramp, so the legend that explains the choropleth
// sits under the name where it is read alongside it, always visible rather than
// tucked behind a chevron. A quiet "scoring" note rides the row while the layer
// is still being computed.
function CariLayerRow ({ layer, visible, onToggle, classes, status }) {
  return (
    <li className="border-b border-border/60 last:border-b-0">
      <div className="flex h-9 items-center gap-1.5 px-2">
        <span className="w-4 shrink-0" />
        <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
          <LayerSwatch color={layer.color} />
        </span>
        <span className={`min-w-0 flex-1 truncate text-[12.5px] font-medium ${visible ? 'text-text' : 'text-text-2'}`}>
          {layer.label}
        </span>
        {visible && status === 'computing' && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-panel-2 px-2 py-[3px] text-[10.5px] font-semibold text-text">
            {/* A CSS ring spinner: a full border in the current (dark) text colour
                with the top edge cut out, spun continuously. Reads clearly as work
                in progress, unlike the faint pulsing text it replaces. */}
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
            Scoring
          </span>
        )}
        <Toggle checked={visible} onChange={onToggle} color={layer.color} label={`Toggle ${layer.label}`} />
      </div>

      {classes.length > 0 && (
        <ul className="flex flex-col gap-0.5 px-2 pb-2 pl-[32px] pr-3">
          {classes.map((c) => (
            <li key={c.idx ?? c.name} className="flex items-center gap-1.5 text-[10px] text-text-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: c.color, border: '1px solid rgba(16,24,40,0.14)' }}
              />
              <span className="truncate">{c.name}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

// A collapsible group. The header carries the section name, a count and a chevron
// that turns the whole group off screen without losing its state.
function Section ({ label, count, children, defaultOpen = true, right }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <li>
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-panel-2 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-muted transition-colors hover:text-text"
        >
          <TbChevronDown className={`shrink-0 text-[12px] transition-transform duration-200 ${open ? '' : '-rotate-90'}`} aria-hidden />
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em]">{label}</span>
        </button>
        {right}
        {count != null && <span className="shrink-0 font-mono text-[9.5px] text-muted tabular-nums">{count}</span>}
      </div>
      {open && <ul>{children}</ul>}
    </li>
  )
}

export default function LayersPanel ({
  layers,
  rasterLayers = [],
  availability = {},
  visibleLayers,
  onToggleLayer,
  onZoomToLayer,
  onShowAll,
  onHideAll,
  onReorderLayers,
  counts = {},
  scales = {},
  opacities = {},
  onOpacity,
  activeModelId,
  onSelectModel,
  levelChoice = {},
  onSelectLevel,
  collapsed,
  onCollapse,
  view = 'map',
  cariLayers = [],
  cariClasses = [],
  cariStatus = {}
}) {
  // Drag reorder for the boundary layers, in the Boundaries section below. The
  // list order is the map stacking, so dropping one row onto another moves that
  // layer in the stack. The handlers are handed to each boundary row.
  const [dragIndex, setDragIndex] = useState(null)
  const [overIndex, setOverIndex] = useState(null)
  const dropReorder = (to) => {
    const from = dragIndex
    setDragIndex(null)
    setOverIndex(null)
    if (!onReorderLayers || from == null || to == null || from === to) return
    const ids = layers.map((l) => l.id)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    onReorderLayers(ids)
  }
  const reorderFor = (i) => (onReorderLayers ? {
    dragging: dragIndex === i,
    over: overIndex === i && dragIndex !== null && dragIndex !== i,
    onDragStart: () => setDragIndex(i),
    onDragOver: (e) => { e.preventDefault(); setOverIndex(i) },
    onDrop: (e) => { e.preventDefault(); dropReorder(i) },
    onDragEnd: () => { setDragIndex(null); setOverIndex(null) }
  } : undefined)
  // Split the raster layers into their behavioural groups. A forecast layer is
  // any that names a model (PMD or GFS); those are grouped under the model
  // selector. The rest are terrain (static) or analysis (computed).
  const forecastLayers = rasterLayers.filter((l) => l.modelId)
  const analysisLayers = rasterLayers.filter((l) => !l.modelId && (l.bandDriven || l.source === 'computed'))
  const terrainLayers = rasterLayers.filter(
    (l) => !l.modelId && !l.bandDriven && l.source !== 'computed'
  )

  const toggleable = [...layers, ...rasterLayers.filter((l) => availability[l.id]?.ok)]
  const visibleCount = toggleable.filter((l) => visibleLayers.has(l.id)).length
  const allVisible = toggleable.length > 0 && visibleCount === toggleable.length

  // Models, in contract order, each with whether it has any available layer.
  const models = []
  const seen = new Set()
  for (const l of forecastLayers) {
    if (seen.has(l.modelId)) continue
    seen.add(l.modelId)
    models.push({ modelId: l.modelId, modelLabel: l.modelLabel, modelFull: l.modelFull, model: l.model })
  }
  const modelAvailable = (modelId) => forecastLayers.some((l) => l.modelId === modelId && availability[l.id]?.ok)

  // The active model's fields, grouped by element, each sorted by level.
  const activeModelLayers = forecastLayers.filter((l) => l.modelId === activeModelId)
  const elementOrder = []
  const byElement = new Map()
  for (const l of activeModelLayers) {
    if (!byElement.has(l.element)) { byElement.set(l.element, []); elementOrder.push(l.element) }
    byElement.get(l.element).push(l)
  }
  // Surface first, then by altitude: a lower pressure is higher up, so 700 hPa
  // comes before 500 hPa. Level 0 is the surface and always leads.
  for (const list of byElement.values()) {
    list.sort((a, b) => (a.level === 0 ? -1 : b.level === 0 ? 1 : b.level - a.level))
  }

  const genericRow = (layer, withOpacity, temporal, reorder, defaultOpen = false) => {
    const state = availability[layer.id]
    return (
      <LayerRow
        key={layer.id}
        layer={layer}
        visible={visibleLayers.has(layer.id)}
        onToggle={() => onToggleLayer(layer.id)}
        onZoom={onZoomToLayer ? () => onZoomToLayer(layer.id) : undefined}
        count={counts[layer.id]}
        scale={scales[layer.id]}
        opacity={opacities[layer.id] ?? layer.opacity ?? 1}
        onOpacity={withOpacity ? (v) => onOpacity(layer.id, v) : undefined}
        unavailable={state && !state.ok ? state.reason : null}
        temporal={temporal}
        reorder={reorder}
        defaultOpen={defaultOpen}
      />
    )
  }

  // Each tab shows only its own layer groups: the Map tab the boundaries and
  // terrain, the Forecast tab the model selector and its fields, the Analysis tab
  // the CARI choropleth units and the per pixel products. The map itself always
  // draws the union of everything toggled on, so a layer switched on here stays on
  // when another tab is opened; only its own toggle takes it off.
  const TITLES = { map: 'Layers', forecast: 'Forecast', analysis: 'Analysis', radar: 'Radar' }
  const hasBody =
    (view === 'map' && (layers.length > 0 || terrainLayers.length > 0)) ||
    (view === 'forecast' && models.length > 0) ||
    (view === 'analysis' && (cariLayers.length > 0 || analysisLayers.length > 0))

  return (
    <Panel
      title={TITLES[view] ?? 'Layers'}
      icon={TbStack2}
      collapsed={collapsed}
      onToggle={onCollapse}
      className="max-h-[calc(100vh-8.5rem)] w-[288px]"
      actions={view === 'map'
        ? (
          <IconButton
            icon={allVisible ? TbEye : TbEyeOff}
            label={allVisible ? 'Hide all layers' : 'Show all layers'}
            size="sm"
            tone="ghost"
            onClick={allVisible ? onHideAll : onShowAll}
          />
          )
        : undefined}
      footer={
        <div className="flex items-center justify-between text-[10.5px] text-muted">
          <span>{visibleCount} of {toggleable.length} visible</span>
          <span className="font-mono">EPSG:4326</span>
        </div>
      }
    >
      {view === 'radar' ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <TbRadar2 className="text-2xl text-muted" aria-hidden />
          <p className="text-[12px] text-muted">Radar controls are coming soon.</p>
        </div>
      ) : !hasBody ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <TbLayersOff className="text-2xl text-muted" aria-hidden />
          <p className="text-[12px] text-muted">
            {view === 'forecast' ? 'No forecast models are published yet.' : 'No layers are published yet.'}
          </p>
        </div>
      ) : (
        <ul>
          {view === 'map' && layers.length > 0 && (
            <Section label="Boundaries" count={layers.length}>
              {layers.map((l, i) => genericRow(l, false, false, reorderFor(i)))}
            </Section>
          )}

          {view === 'map' && terrainLayers.length > 0 && (
            <Section label="Terrain" count={terrainLayers.length}>
              {terrainLayers.map((l) => genericRow(l, true, false))}
            </Section>
          )}

          {view === 'analysis' && cariLayers.length > 0 && (
            <Section label="Administrative units" count={cariLayers.length}>
              {cariLayers.map((l) => (
                <CariLayerRow
                  key={l.id}
                  layer={l}
                  visible={visibleLayers.has(l.id)}
                  onToggle={() => onToggleLayer(l.id)}
                  classes={cariClasses}
                  status={cariStatus[l.id]}
                />
              ))}
            </Section>
          )}

          {view === 'analysis' && analysisLayers.length > 0 && (
            <Section label="Per pixel" count={analysisLayers.length}>
              {/* Detail open by default here: the Hotspot Mask legend names the
                  three classes, which is the point of the layer, so it should not
                  hide behind a chevron in the Analysis tab. */}
              {analysisLayers.map((l) => genericRow(l, true, Boolean(l.temporal), undefined, true))}
            </Section>
          )}

          {view === 'forecast' && models.length > 0 && (
            <Section label="Forecast models" count={elementOrder.length}>
              <li className="border-b border-border/60 px-2 py-2">
                <ModelSelect
                  models={models}
                  value={activeModelId}
                  available={modelAvailable}
                  onSelect={onSelectModel}
                />
              </li>

              {elementOrder.map((el) => {
                const variants = byElement.get(el)
                const key = `${activeModelId}:${el}`
                const chosen = levelChoice[key]
                const activeDef = variants.find((v) => v.level === chosen)
                  ?? variants.find((v) => v.level === 0)
                  ?? variants[0]
                const state = availability[activeDef.id]
                return (
                  <ForecastRow
                    key={key}
                    element={activeDef}
                    activeDef={activeDef}
                    levels={variants}
                    activeLevel={activeDef.level}
                    onLevel={(lv) => onSelectLevel(activeModelId, el, lv)}
                    visible={visibleLayers.has(activeDef.id)}
                    onToggle={() => onToggleLayer(activeDef.id)}
                    scale={scales[activeDef.id]}
                    opacity={opacities[activeDef.id] ?? activeDef.opacity ?? 1}
                    onOpacity={(v) => onOpacity(activeDef.id, v)}
                    unavailable={state && !state.ok ? state.reason : null}
                  />
                )
              })}
            </Section>
          )}
        </ul>
      )}
    </Panel>
  )
}
