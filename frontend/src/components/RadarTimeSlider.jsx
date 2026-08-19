// The radar animation slider.
//
// The forecast slider scrubs a model's leads; this one scrubs the radar loop: a
// list of real scan times, ten minutes apart, discovered from the source. It
// mirrors the forecast slider's look (transport, drawn track, readout) but its
// axis is wall-clock time, not a forecast lead, and it owns its own play loop so
// the two timelines never fight. Shown only in the Radar tab.

import { useEffect, useRef, useState } from 'react'
import {
  TbPlayerPlayFilled, TbPlayerPauseFilled, TbPlayerSkipBackFilled, TbChevronLeft, TbChevronRight
} from 'react-icons/tb'

import { IconButton } from './ui/Panel'

const PKT = 'Asia/Karachi'
const SPEEDS = [0.5, 1, 2, 3]
// Radar loops read best a touch quicker than the forecast slider's one second.
const BASE_INTERVAL_MS = 600

// "YYYYMMDDHHMM" (UTC) to a Date. The source stamps every filename in UTC.
export function parseStamp (s) {
  return new Date(Date.UTC(
    +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)
  ))
}

const fmt = (date, timeZone) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date)

// The finest cadence we will ever grid at, so one stray short gap cannot shatter
// the axis into two-minute steps.
const MIN_GRID_MS = 5 * 60 * 1000
const DEFAULT_IV_MS = 10 * 60 * 1000

const medianGapMs = (frames) => {
  if (frames.length < 2) return DEFAULT_IV_MS
  const gaps = []
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i].ms - frames[i - 1].ms)
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] || DEFAULT_IV_MS
}

/**
 * One shared animation timeline for the active radar layers.
 *
 * The naive axis, a sorted union of every raw scan time, breaks in two ways the
 * source makes common: products scan on their own phase (Surface at :01, CAPPI at
 * :07) so their times interleave and each step moves only one layer, and the two
 * sites' feeds can cover different windows (one may have stalled hours ago) so a
 * long dead gap strands the live feed in one half of the bar.
 *
 * So instead: snap every scan onto one grid at the finest active cadence, and let
 * the axis be only the steps some layer actually scanned (a gap no layer scanned
 * is simply not a step, which collapses the dead stretch). At each step a layer
 * shows its most recent scan at or before that time, but only while that scan is
 * still fresh for its own cadence; a feed that stalled goes blank rather than
 * smearing an hours-old frame across a newer moment.
 *
 * Returns { ticks: number[] (ms, ascending), shown: { [layerId]: (url|null)[] }
 * aligned to ticks, intervalMin }.
 */
export function buildRadarTimeline (activeLayers, framesById) {
  const layers = activeLayers
    .map((l) => {
      const frames = (framesById[l.id]?.frames ?? [])
        .map((f) => ({ ms: parseStamp(f.timestamp).getTime(), imageUrl: f.imageUrl }))
        .sort((a, b) => a.ms - b.ms)
      return { id: l.id, frames, iv: medianGapMs(frames) }
    })
    .filter((l) => l.frames.length)

  if (!layers.length) return { ticks: [], shown: {}, intervalMin: 10 }

  const grid = Math.max(MIN_GRID_MS, Math.min(...layers.map((l) => l.iv)))
  const snap = (ms) => Math.round(ms / grid) * grid

  const tickSet = new Set()
  for (const l of layers) for (const f of l.frames) tickSet.add(snap(f.ms))
  const ticks = [...tickSet].sort((a, b) => a - b)

  const shown = {}
  for (const l of layers) {
    // Hold a scan across steps up to its own cadence plus a little slack; older
    // than that the feed has stalled, so paint nothing instead of a stale frame.
    const hold = Math.max(grid, Math.round(1.5 * l.iv))
    shown[l.id] = ticks.map((t) => {
      let pick = null
      for (const f of l.frames) {
        if (snap(f.ms) <= t) pick = f
        else break
      }
      if (!pick || t - snap(pick.ms) > hold) return null
      return pick.imageUrl
    })
  }

  return { ticks, shown, intervalMin: Math.round(grid / 60000) }
}

function Readout ({ label, value, emphasis = false, minW = '' }) {
  return (
    <div className={`flex flex-col items-end px-2.5 py-1 ${minW} ${emphasis ? 'bg-primary-soft' : ''}`}>
      <span className={`text-[9px] uppercase tracking-[0.07em] ${emphasis ? 'text-primary' : 'text-muted'}`}>{label}</span>
      <span className={`whitespace-nowrap font-mono text-[12px] tabular-nums ${emphasis ? 'font-semibold text-primary' : 'text-text'}`}>{value}</span>
    </div>
  )
}

export default function RadarTimeSlider ({ times, index, onIndex, products = [], intervalMin = 10 }) {
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const trackRef = useRef(null)
  const draggingRef = useRef(false)
  const timer = useRef(null)

  const count = times.length
  const at = Math.min(index, Math.max(0, count - 1))
  const current = count ? times[at] : null

  useEffect(() => {
    if (!playing || count === 0) return
    timer.current = setInterval(() => onIndex((i) => (i + 1) % count), BASE_INTERVAL_MS / speed)
    return () => clearInterval(timer.current)
  }, [playing, count, speed, onIndex])

  if (count === 0) {
    return (
      <div className="pointer-events-auto flex items-center gap-2 rounded-cb-sm border border-amber-border bg-amber-soft px-3 py-2">
        <span className="text-[11.5px] font-medium text-amber">Turn on a radar layer to load its animation.</span>
      </div>
    )
  }

  const pct = count > 1 ? (at / (count - 1)) * 100 : 0
  const ticks = times.map((d, i) => ({
    i,
    pct: count > 1 ? (i / (count - 1)) * 100 : 0,
    // A heavier tick where the hour rolls over, as a coarse time guide.
    major: i === 0 || d.getUTCHours() !== times[i - 1].getUTCHours(),
    elapsed: i <= at
  }))

  const cycleSpeed = () => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])

  const seek = (clientX) => {
    const el = trackRef.current
    if (!el || count <= 1) return
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    onIndex(Math.round(ratio * (count - 1)))
  }
  const onPointerDown = (e) => {
    if (count <= 1) return
    draggingRef.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    seek(e.clientX)
  }
  const onPointerMove = (e) => { if (draggingRef.current) seek(e.clientX) }
  const endDrag = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }
  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { onIndex((i) => Math.max(0, i - 1)); e.preventDefault() }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { onIndex((i) => Math.min(count - 1, i + 1)); e.preventDefault() }
    else if (e.key === 'Home') { onIndex(0); e.preventDefault() }
    else if (e.key === 'End') { onIndex(count - 1); e.preventDefault() }
  }

  const atLive = at === count - 1

  return (
    <div className="pointer-events-auto w-[min(920px,calc(100vw-2rem))] rounded-cb border border-border bg-panel px-3 py-2.5 shadow-cb-lg">
      <div className="flex items-center gap-3">
        <div className="flex shrink-0 items-center gap-1">
          <IconButton icon={TbPlayerSkipBackFilled} label="Reset to start" size="sm" tone="ghost"
            onClick={() => onIndex(0)} disabled={at === 0} />
          <IconButton icon={TbChevronLeft} label="Previous frame" size="sm" tone="ghost"
            onClick={() => onIndex((i) => Math.max(0, i - 1))} disabled={at === 0} />
          <IconButton icon={playing ? TbPlayerPauseFilled : TbPlayerPlayFilled}
            label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((v) => !v)} active={playing} />
          <IconButton icon={TbChevronRight} label="Next frame" size="sm" tone="ghost"
            onClick={() => onIndex((i) => Math.min(count - 1, i + 1))} disabled={at === count - 1} />
          <button
            type="button"
            onClick={cycleSpeed}
            title="Playback speed"
            aria-label={`Playback speed ${speed}x`}
            className={`ml-0.5 h-7 min-w-[2.4rem] rounded-cb-sm border px-1.5 font-mono text-[11px] font-semibold tabular-nums transition-colors ${
              speed === 1
                ? 'border-border bg-panel text-text-2 hover:bg-panel-3'
                : 'border-primary-border bg-primary-soft text-primary'
            }`}
          >
            {speed}x
          </button>
        </div>

        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Radar animation time"
          aria-valuemin={0}
          aria-valuemax={count - 1}
          aria-valuenow={at}
          aria-valuetext={current ? fmt(current, PKT) : ''}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          className="relative h-6 min-w-0 flex-1 cursor-pointer touch-none select-none outline-none"
        >
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--cb-track)]" />
          <div className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
          {ticks.map((t) => (
            <span
              key={t.i}
              className="pointer-events-none absolute top-1/2 w-px -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${t.pct}%`,
                height: t.major ? '11px' : '5px',
                background: t.elapsed ? 'var(--cb-primary)' : t.major ? 'var(--cb-border-strong)' : 'var(--cb-border)'
              }}
            />
          ))}
          <div
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-panel"
            style={{ left: `${pct}%`, boxShadow: '0 1px 3px rgba(16,24,40,0.35)' }}
          />
        </div>

        <div className="flex shrink-0 items-stretch divide-x divide-border overflow-hidden rounded-cb-sm border border-border">
          <Readout label="Valid PKT" value={current ? fmt(current, PKT) : '--'} minW="min-w-[7rem]" />
          <Readout label="UTC" value={current ? fmt(current, 'UTC') : '--'} minW="min-w-[7rem]" />
          <Readout label="Frame" value={`${at + 1}/${count}`} emphasis minW="min-w-[3.5rem]" />
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-border pt-1.5 text-[10.5px] text-muted">
        <span>
          <span className="font-medium text-text-2">PMD radar</span>
          {products.length ? <>{'  '}{products.join(', ')}</> : null}
          {`  every ${intervalMin} min`}
        </span>
        <span className="pl-3 text-right">
          {atLive
            ? <span className="inline-flex items-center gap-1.5 font-medium text-primary"><span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />Live edge</span>
            : <>Showing an earlier scan</>}
        </span>
      </div>
    </div>
  )
}
