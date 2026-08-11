// The forecast time slider.
//
// A forecast is a cube: a variable, a place, and a time. The layers panel picks
// the variable, the map is the place, and this is the time. It scrubs the leads
// the cycle actually published, so it can never point at an hour that was not
// ingested, and every temporal layer on the map moves together because they all
// share this one lead.
//
// The track is drawn, not a native range. A native input put its thumb on its
// own baseline, half a pixel off the bar, and gave nowhere to hang ticks. Here
// the bar, the elapsed fill, the day and step ticks and the thumb are all placed
// from the same percentage, so they line up exactly; a transparent range sits on
// top only to keep drag and keyboard control. No gradient anywhere, the project
// rule.

import { useEffect, useRef, useState } from 'react'
import {
  TbPlayerPlayFilled, TbPlayerPauseFilled, TbChevronLeft, TbChevronRight
} from 'react-icons/tb'

import { IconButton } from './ui/Panel'

const PKT = 'Asia/Karachi'
const SPEEDS = [0.5, 1, 2, 3]
const BASE_INTERVAL_MS = 1000

const fmt = (date, timeZone) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date)

const cycleLabel = (date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', hour12: false
  }).format(date).replace(':00', '') + 'Z'

/** "+0h", "+18h", "+3d 06h". The forecaster's mental unit, not raw hours. */
function leadText (h) {
  if (h == null) return ''
  if (h < 24) return `+${h}h`
  const d = Math.floor(h / 24)
  const r = h % 24
  return r ? `+${d}d ${String(r).padStart(2, '0')}h` : `+${d}d`
}

/** One cell of the readout group. Lead is emphasised, it is what changes most. */
function Readout ({ label, value, emphasis = false }) {
  return (
    <div className={`flex flex-col items-end px-2.5 py-1 ${emphasis ? 'bg-primary-soft' : ''}`}>
      <span className={`text-[9px] uppercase tracking-[0.07em] ${emphasis ? 'text-primary' : 'text-muted'}`}>
        {label}
      </span>
      <span className={`font-mono text-[12px] tabular-nums ${emphasis ? 'font-semibold text-primary' : 'text-text'}`}>
        {value}
      </span>
    </div>
  )
}

export default function TimeSlider ({
  cycle,             // ISO string, cycle initialization (UTC)
  model,
  leads,             // sorted array of lead hours
  index,
  onIndex,
  playing,
  onPlayToggle,
  activeLayers = []  // labels of temporal layers currently shown
}) {
  const timer = useRef(null)
  const [speed, setSpeed] = useState(1)
  const count = leads.length
  const lead = leads[index] ?? 0
  const cycleDate = cycle ? new Date(cycle) : null
  const validDate = cycleDate ? new Date(cycleDate.getTime() + lead * 3600_000) : null
  const pct = count > 1 ? (index / (count - 1)) * 100 : 0

  // Advance on a timer while playing, wrapping at the end so a loop keeps
  // looping. The interval is the base divided by the speed multiplier, so 2x is
  // twice as fast. Re-created whenever speed changes.
  useEffect(() => {
    if (!playing || count === 0) return
    timer.current = setInterval(() => {
      onIndex((i) => (i + 1) % count)
    }, BASE_INTERVAL_MS / speed)
    return () => clearInterval(timer.current)
  }, [playing, count, speed, onIndex])

  if (!cycleDate || count === 0) return null

  // Classify each step: a major tick at every 00Z day boundary, a minor tick at
  // everything else. Both highlight once elapsed, so the filled part of the bar
  // reads as time already stepped through.
  const ticks = leads.map((h, i) => {
    const hourUTC = new Date(cycleDate.getTime() + h * 3600_000).getUTCHours()
    return { i, pct: count > 1 ? (i / (count - 1)) * 100 : 0, major: hourUTC === 0, elapsed: i <= index }
  })

  const cycleSpeed = () => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])

  return (
    <div className="pointer-events-auto w-[min(920px,calc(100vw-2rem))] rounded-cb border border-border bg-panel px-3 py-2.5 shadow-cb-lg">
      <div className="flex items-center gap-3">
        {/* Transport */}
        <div className="flex shrink-0 items-center gap-1">
          <IconButton icon={TbChevronLeft} label="Previous step" size="sm" tone="ghost"
            onClick={() => onIndex((i) => Math.max(0, i - 1))} disabled={index === 0} />
          <IconButton icon={playing ? TbPlayerPauseFilled : TbPlayerPlayFilled}
            label={playing ? 'Pause' : 'Play'} onClick={onPlayToggle} active={playing} />
          <IconButton icon={TbChevronRight} label="Next step" size="sm" tone="ghost"
            onClick={() => onIndex((i) => Math.min(count - 1, i + 1))} disabled={index === count - 1} />

          {/* Speed. Cycles 0.5x, 1x, 2x, 3x. Active when not the default, so it
              is obvious the playback is off normal speed. */}
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

        {/* Scrubber, drawn. */}
        <div className="relative h-6 min-w-0 flex-1">
          {/* Base bar, centered. */}
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--cb-track)]" />
          {/* Elapsed fill. */}
          <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
          {/* Ticks. Major cross the bar taller than minor; both colour once elapsed. */}
          {ticks.map((t) => (
            <span
              key={t.i}
              className="absolute top-1/2 w-px -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${t.pct}%`,
                height: t.major ? '11px' : '5px',
                background: t.elapsed
                  ? 'var(--cb-primary)'
                  : t.major ? 'var(--cb-border-strong)' : 'var(--cb-border)'
              }}
            />
          ))}
          {/* Thumb, centered on the bar and on the current step. */}
          <div
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-panel"
            style={{ left: `${pct}%`, boxShadow: '0 1px 3px rgba(16,24,40,0.35)' }}
          />
          {/* Interaction only: an invisible native range for drag and keyboard. */}
          <input
            type="range"
            min="0"
            max={count - 1}
            value={index}
            onChange={(e) => onIndex(Number(e.target.value))}
            aria-label="Forecast lead time"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </div>

        {/* Readout group, a bordered strip of cells with the lead picked out. */}
        <div className="flex shrink-0 items-stretch divide-x divide-border overflow-hidden rounded-cb-sm border border-border">
          <Readout label="Valid PKT" value={fmt(validDate, PKT)} />
          <Readout label="UTC" value={fmt(validDate, 'UTC')} />
          <Readout label="Lead" value={leadText(lead)} emphasis />
        </div>
      </div>

      {/* Footer: what this cycle is, and which layers the time applies to. */}
      <div className="mt-2 flex items-center justify-between border-t border-border pt-1.5 text-[10.5px] text-muted">
        <span>
          <span className="font-medium text-text-2">{model}</span>
          {'  cycle '}
          <span className="font-mono">{cycleLabel(cycleDate)}</span>
          {`  step ${index + 1}/${count}`}
        </span>
        <span className="truncate pl-3 text-right">
          {activeLayers.length
            ? <>Applies to: <span className="text-text-2">{activeLayers.join(', ')}</span></>
            : 'No temporal layer shown yet'}
        </span>
      </div>
    </div>
  )
}
