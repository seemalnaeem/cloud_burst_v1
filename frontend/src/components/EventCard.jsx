// The historic event detail card, top right beside the map controls.
//
// Shown in the Map view when a point on the Historic Cloudburst Events layer is
// clicked. It reads the event behind the point, lays its attributes out with a
// distinct colour per value, and plays the event's photos underneath as an auto
// advancing carousel. Clicking a photo opens a full resolution lightbox that
// plays the same set. Districts and tehsils have their own card (CariCard); this
// one is only ever the events layer.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TbCloudStorm, TbX, TbChevronLeft, TbChevronRight, TbPhotoOff } from 'react-icons/tb'

import { useAsync } from '@/hooks/useAsync'
import { getEvent, eventPhotoUrl } from '@/lib/api'
import { fmtValue, fmtCoord, isMissing } from '@/lib/format'

import { Panel, IconButton } from './ui/Panel'
import { LoadingBar } from './ui/Loading'

// How long each photo holds before the carousel advances.
const AUTOPLAY_MS = 3000

// One row per attribute, in reading order, each with its own colour so the
// values read as a set of distinct facts rather than a grey column. District
// comes from the ingest-time spatial overlay, not the CSV.
const ATTRS = [
  { key: 'district_name', label: 'District', color: '#2563eb', text: true },
  { key: 'rainfall_mm', label: 'Rainfall', unit: 'mm', decimals: 1, color: '#0891b2' },
  { key: 'cape_j_kg', label: 'CAPE', unit: 'J/kg', decimals: 0, color: '#dc2626' },
  { key: 'relative_humidity_pct', label: 'RH 700 hPa', unit: '%', decimals: 1, color: '#059669' },
  { key: 'precipitable_water_mm', label: 'Precipitable water', unit: 'mm', decimals: 1, color: '#7c3aed' },
  { key: 'vertical_velocity', label: 'Vertical velocity 700 hPa', unit: 'Pa/s', decimals: 3, color: '#db2777' },
  { key: 'elevation_m', label: 'Elevation', unit: 'm', decimals: 0, color: '#d97706' },
  { key: 'slope_deg', label: 'Slope', unit: '°', decimals: 1, color: '#65a30d' }
]

export default function EventCard ({ selection, onClose }) {
  // The tile promotes the row id to the feature id, so it arrives as featureId
  // rather than in the properties bag. Fall back to a property for safety.
  const id = selection?.featureId ?? selection?.properties?.id
  const event = useAsync((signal) => getEvent(id, signal), [id], { enabled: id != null })

  return (
    <Panel
      title="Historic cloudburst event"
      icon={TbCloudStorm}
      accent="#ef4444"
      className="max-h-[calc(100vh-7rem)] w-[320px]"
      bodyClassName="px-3 py-3"
      actions={<IconButton icon={TbX} label="Close" size="sm" tone="ghost" onClick={onClose} />}
    >
      <Body id={id} event={event} />
    </Panel>
  )
}

function Body ({ id, event }) {
  if (event.isLoading || (!event.data && !event.isError)) {
    return <LoadingBar label="Loading event…" />
  }

  if (event.isError) {
    return (
      <div className="rounded-cb-sm border border-danger-border bg-danger-soft px-3 py-2.5 text-[11.5px] leading-snug text-danger">
        <p className="font-semibold">Could not load this event</p>
        <p className="mt-0.5 opacity-90">{event.error.message}</p>
      </div>
    )
  }

  const e = event.data
  const photos = (e.photos ?? []).map((p) => ({ ...p, url: eventPhotoUrl(id, p.seq) }))

  return (
    <div className="space-y-3">
      <div className="min-w-0">
        <h3 className="truncate text-[15px] font-semibold leading-tight text-text">{e.location_name}</h3>
        <p className="mt-0.5 truncate text-[11.5px] text-muted">
          {[e.occurrence, coordLabel(e)].filter(Boolean).join(' · ')}
        </p>
      </div>

      <dl className="flex flex-col">
        {ATTRS.map((a) => {
          const raw = e[a.key]
          if (isMissing(raw) || raw === '') return null
          const shown = a.text ? String(raw) : fmtValue(raw, a.unit, a.decimals)
          return (
            <div
              key={a.key}
              className="flex items-baseline justify-between gap-3 border-b border-border/70 py-[6px] last:border-b-0"
            >
              <dt className="shrink-0 text-[11.5px] font-medium text-text-2">{a.label}</dt>
              <dd
                className="min-w-0 truncate text-right text-[13px] font-bold tabular-nums"
                style={{ color: a.color }}
              >
                {shown}
              </dd>
            </div>
          )
        })}
      </dl>

      <Carousel photos={photos} />
    </div>
  )
}

function coordLabel (e) {
  if (isMissing(e.latitude) || isMissing(e.longitude)) return null
  return `${fmtCoord(e.latitude, 3)}, ${fmtCoord(e.longitude, 3)}`
}

// The inline carousel plus the lightbox it opens. Index is shared so the two
// stay on the same photo. Auto advance runs on both; manual navigation just
// jumps the index and the timer keeps its own cadence.
function Carousel ({ photos }) {
  const [index, setIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const count = photos.length

  // Reset to the first photo whenever the event (and so the photo set) changes.
  const key = photos.map((p) => p.url).join('|')
  useEffect(() => { setIndex(0); setOpen(false) }, [key])

  useEffect(() => {
    if (count < 2) return undefined
    const t = setInterval(() => setIndex((i) => (i + 1) % count), AUTOPLAY_MS)
    return () => clearInterval(t)
  }, [count, key])

  if (count === 0) {
    return (
      <div className="flex items-center gap-2 rounded-cb-sm border border-border bg-panel-2 px-2.5 py-2 text-[11px] text-muted">
        <TbPhotoOff className="shrink-0 text-[13px]" aria-hidden />
        No images filed for this event.
      </div>
    )
  }

  const go = (next) => setIndex((i) => (i + next + count) % count)

  return (
    <>
      <div className="select-none">
        <Frame
          photos={photos}
          index={index}
          onGo={go}
          onOpen={() => setOpen(true)}
          count={count}
          height="h-[150px]"
          fit="object-cover"
          rounded="rounded-cb-sm"
        />
        {count > 1 && <Dots count={count} index={index} onDot={setIndex} />}
      </div>

      {open && createPortal(
        <Lightbox photos={photos} index={index} onGo={go} onClose={() => setOpen(false)} />,
        document.body
      )}
    </>
  )
}

// The sliding image track. A flex row translated by the index reads as a swipe,
// and there is no gradient anywhere on it, in keeping with the theme.
function Frame ({ photos, index, onGo, onOpen, count, height, fit, rounded, onClose }) {
  return (
    <div className={`relative overflow-hidden bg-panel-2 ${rounded}`}>
      <div
        className={`flex ${height} transition-transform duration-500 ease-out ${onOpen ? 'cursor-zoom-in' : ''}`}
        style={{ transform: `translateX(-${index * 100}%)` }}
        onClick={onOpen}
      >
        {photos.map((p) => (
          <img
            key={p.seq}
            src={p.url}
            alt={p.filename}
            draggable={false}
            className={`w-full shrink-0 ${fit}`}
            style={height === 'h-full' ? { maxHeight: '100%' } : undefined}
          />
        ))}
      </div>

      {count > 1 && (
        <>
          <ArrowButton side="left" onClick={(ev) => { ev.stopPropagation(); onGo(-1) }} />
          <ArrowButton side="right" onClick={(ev) => { ev.stopPropagation(); onGo(1) }} />
        </>
      )}

      <span className="pointer-events-none absolute bottom-1.5 right-2 rounded-full bg-[rgba(6,10,16,0.62)] px-1.5 py-0.5 text-[9.5px] font-medium text-white tabular-nums">
        {index + 1} / {count}
      </span>

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close full screen"
          className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-[rgba(6,10,16,0.62)] text-white transition-colors hover:bg-[rgba(6,10,16,0.85)]"
        >
          <TbX className="text-[16px]" aria-hidden />
        </button>
      )}
    </div>
  )
}

function ArrowButton ({ side, onClick }) {
  const Icon = side === 'left' ? TbChevronLeft : TbChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? 'Previous image' : 'Next image'}
      className={`absolute top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-[rgba(6,10,16,0.55)] text-white transition-colors hover:bg-[rgba(6,10,16,0.8)] ${
        side === 'left' ? 'left-1.5' : 'right-1.5'
      }`}
    >
      <Icon className="text-[16px]" aria-hidden />
    </button>
  )
}

function Dots ({ count, index, onDot }) {
  return (
    <div className="mt-1.5 flex items-center justify-center gap-1.5">
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onDot(i)}
          aria-label={`Go to image ${i + 1}`}
          className="h-1.5 rounded-full transition-all duration-200"
          style={{
            width: i === index ? 16 : 6,
            background: i === index ? 'var(--cb-primary)' : 'var(--cb-border-strong)'
          }}
        />
      ))}
    </div>
  )
}

// The full resolution lightbox. A sober dark scrim, the image contained so it is
// never cropped, and the same navigation as the inline strip. Escape closes it
// and the arrow keys move through the set.
function Lightbox ({ photos, index, onGo, onClose }) {
  const backdropRef = useRef(null)

  useEffect(() => {
    const onKey = (ev) => {
      if (ev.key === 'Escape') onClose()
      else if (ev.key === 'ArrowLeft') onGo(-1)
      else if (ev.key === 'ArrowRight') onGo(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onGo, onClose])

  const count = photos.length
  const current = photos[index]

  return (
    <div
      ref={backdropRef}
      onClick={(ev) => { if (ev.target === backdropRef.current) onClose() }}
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center p-6"
      style={{ background: 'rgba(6,10,16,0.86)', backdropFilter: 'blur(2px)' }}
    >
      <div className="relative flex max-h-[86vh] w-full max-w-[1100px] items-center justify-center">
        <img
          src={current.url}
          alt={current.filename}
          draggable={false}
          className="max-h-[86vh] max-w-full rounded-cb border border-[rgba(255,255,255,0.14)] object-contain shadow-cb-lg"
        />

        {count > 1 && (
          <>
            <ArrowButton side="left" onClick={(ev) => { ev.stopPropagation(); onGo(-1) }} />
            <ArrowButton side="right" onClick={(ev) => { ev.stopPropagation(); onGo(1) }} />
          </>
        )}

        <button
          type="button"
          onClick={onClose}
          aria-label="Close full screen"
          className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-[rgba(6,10,16,0.62)] text-white transition-colors hover:bg-[rgba(6,10,16,0.9)]"
        >
          <TbX className="text-[18px]" aria-hidden />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-3 text-[11.5px] text-white/80">
        <span className="truncate">{current.filename}</span>
        <span className="tabular-nums">{index + 1} / {count}</span>
      </div>
    </div>
  )
}
