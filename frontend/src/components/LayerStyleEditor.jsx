// The per-layer style editor.
//
// The colour mark on a boundary row is a button: clicking it opens a small
// overlay card to recolour the layer and adjust its outline and fill (or, for the
// point layer, the dot). The change is handed up as a patch; the panel and the
// map read the overridden def, and App persists it in the browser, so the edit
// survives a reload. The card is portalled to the body and positioned from the
// swatch, so the scrolling layers panel cannot clip it, and it closes on an
// outside press, a scroll or a resize, matching the level and model selectors.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TbArrowBackUp } from 'react-icons/tb'

import { LayerSwatch } from './LayerLegend'

// A sober, distinct spread that reads over both the light and dark basemaps.
// Grouped warm to cool to neutral so a colour is easy to find.
const PRESETS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899',
  '#f43f5e', '#64748b', '#334155', '#e2e8f0'
]

const WIDTH = 236

function Slider ({ label, value, min, max, step, suffix, color, onChange }) {
  return (
    <div className="mt-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10.5px] font-medium text-muted">{label}</span>
        <span className="font-mono text-[10.5px] text-text-2 tabular-nums">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--cb-track)]"
        style={{ accentColor: color }}
      />
    </div>
  )
}

export default function LayerStyleEditor ({ layer, override, onChange, onReset }) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const btnRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setRect(btnRef.current?.getBoundingClientRect() ?? null)
    const close = () => setOpen(false)
    const onDoc = (e) => {
      if (btnRef.current?.contains(e.target)) return
      if (e.target.closest?.('[data-style-menu]')) return
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

  const isPoint = layer.geometryType === 'point'
  const paint = layer.paint ?? {}
  const color = layer.color
  const hasOverride = Boolean(override && Object.keys(override).length)

  const left = rect ? Math.min(rect.left, window.innerWidth - WIDTH - 8) : 0

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Edit ${layer.label} style`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Edit ${layer.label} style`}
        className={`grid h-3.5 w-3.5 shrink-0 cursor-pointer place-items-center rounded-[4px] outline-none transition-shadow ${
          open ? 'ring-2 ring-primary ring-offset-1 ring-offset-panel' : 'hover:ring-2 hover:ring-border-strong'
        }`}
      >
        <LayerSwatch color={color} render={layer.legend?.render} />
      </button>

      {open && rect && createPortal(
        <div
          data-style-menu
          role="dialog"
          aria-label={`${layer.label} style`}
          style={{ position: 'fixed', top: rect.bottom + 6, left: Math.max(8, left), width: WIDTH, boxShadow: '0 12px 32px rgba(16,24,40,0.22)' }}
          className="z-[70] rounded-cb border border-border bg-panel p-3"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="truncate text-[11.5px] font-semibold text-text">{layer.label}</span>
            {hasOverride && (
              <button
                type="button"
                onClick={onReset}
                title="Reset to default style"
                className="inline-flex items-center gap-1 rounded-cb-sm px-1.5 py-0.5 text-[10px] font-medium text-muted transition-colors hover:bg-panel-2 hover:text-text"
              >
                <TbArrowBackUp className="text-[12px]" aria-hidden />
                Reset
              </button>
            )}
          </div>

          <span className="text-[10.5px] font-medium text-muted">Colour</span>
          <div className="mt-1.5 grid grid-cols-8 gap-1.5">
            {PRESETS.map((c) => {
              const active = c.toLowerCase() === String(color).toLowerCase()
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => onChange({ color: c })}
                  aria-label={c}
                  title={c}
                  className={`h-4 w-4 rounded-full transition-transform hover:scale-110 ${active ? 'ring-2 ring-primary ring-offset-1 ring-offset-panel' : 'ring-1 ring-inset ring-[rgba(16,24,40,0.2)]'}`}
                  style={{ background: c }}
                />
              )
            })}
            <label
              title="Custom colour"
              className="relative grid h-4 w-4 cursor-pointer place-items-center overflow-hidden rounded-full ring-1 ring-inset ring-border-strong"
              style={{ background: 'conic-gradient(#ef4444,#eab308,#22c55e,#06b6d4,#6366f1,#ec4899,#ef4444)' }}
            >
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#3b82f6'}
                onChange={(e) => onChange({ color: e.target.value })}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Custom colour"
              />
            </label>
          </div>

          {isPoint ? (
            <Slider
              label="Dot size" suffix="px" color={color}
              value={override?.radius ?? paint.circleRadius ?? 6}
              min={3} max={12} step={1}
              onChange={(v) => onChange({ radius: v })}
            />
          ) : (
            <>
              <Slider
                label="Outline width" suffix="px" color={color}
                value={override?.weight ?? paint.lineWidth ?? 1}
                min={0.5} max={5} step={0.5}
                onChange={(v) => onChange({ weight: v })}
              />
              <Slider
                label="Fill" suffix="%" color={color}
                value={Math.round((override?.fillOpacity ?? paint.fillOpacity ?? 0) * 100)}
                min={0} max={60} step={5}
                onChange={(v) => onChange({ fillOpacity: v / 100 })}
              />
            </>
          )}
        </div>,
        document.body
      )}
    </>
  )
}
