// The alerts carousel.
//
// One region at a time. A region shows its real advisory wording and the full
// list of its districts as alert cards; that list scrolls slowly up through a
// fixed window, and when it reaches the end the carousel swipes on to the next
// region and its list begins to scroll. The scroll distance is measured, so the
// duration matches the number of districts (more districts, longer scroll) at a
// steady slow pace. Hovering pauses the scroll. Everything is theme-token styled
// so it reads on the light and dark panel; only the HIGH badge keeps a fixed
// alert colour.

import { useLayoutEffect, useRef, useState } from 'react'

const VIEW_H = 158       // px, the vertical window the district cards scroll through
const MS_PER_PX = 48     // slow, steady pace
const MIN_MS = 5000      // dwell for a region whose list already fits
const PAUSE_MS = 900     // beat at the end of a scroll before the swipe

// The important words to lift out of a region's advisory sentence: the hazard
// itself and the timing. They are drawn in full-contrast text against the muted
// sentence so the reader catches the what and the when at a glance.
const HILITE = /(rain[\s-]?wind(?:\/thundershower)?|thundershowers?|thunderstorms?|windstorms?|dust[\s-]?storms?|isolated\s+heavy\s?falls?|heavy\s?falls?|hot and humid|\d{1,2}(?:st|nd|rd|th)|January|February|March|April|May|June|July|August|September|October|November|December)/gi

function Highlighted ({ text }) {
  // split on a capturing group interleaves the matches at the odd indices.
  return text.split(HILITE).map((part, i) =>
    i % 2 === 1
      ? <span key={i} className="font-semibold text-text">{part}</span>
      : <span key={i}>{part}</span>
  )
}

function DistrictCard ({ name, cari }) {
  return (
    <div className="flex items-center gap-2 rounded-cb-sm border border-border bg-panel-2 px-2.5 py-2">
      <span className="inline-flex h-[15px] shrink-0 items-center justify-center rounded-[3px] bg-[#e8722a] px-1.5 text-[9px] font-bold uppercase leading-none text-white">
        High
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text">{name}</span>
      {cari?.cari != null && (
        <span className="shrink-0 whitespace-nowrap font-mono text-[10px] font-medium uppercase tracking-wide text-muted tabular-nums">
          CARI <span className="text-[12px] font-semibold" style={{ color: cari.color || undefined }}>{Math.round(cari.cari)}</span>
        </span>
      )}
    </div>
  )
}

export default function AlertsCarousel ({ provinces, cari = {} }) {
  const [r, setR] = useState(0)
  const listRef = useRef(null)
  const viewRef = useRef(null)
  const timerRef = useRef(null)

  // Keep the index in range when a new advisory arrives.
  useLayoutEffect(() => { setR((cur) => (cur >= provinces.length ? 0 : cur)) }, [provinces])

  const idx = provinces.length ? Math.min(r, provinces.length - 1) : 0
  const region = provinces[idx]

  // Drive the vertical scroll for the active region, then hand off to the next.
  useLayoutEffect(() => {
    clearTimeout(timerRef.current)
    const list = listRef.current
    const view = viewRef.current
    if (!list || !view || provinces.length === 0) return
    const advance = () => setR((cur) => (cur + 1) % provinces.length)

    const dist = list.scrollHeight - view.clientHeight
    if (dist > 6) {
      list.style.setProperty('--cb-vscroll-end', `-${dist}px`)
      const duration = Math.max(MIN_MS, Math.round(dist * MS_PER_PX))
      list.style.animation = `cb-vscroll ${duration}ms linear both`
      const onEnd = () => { timerRef.current = setTimeout(advance, PAUSE_MS) }
      list.addEventListener('animationend', onEnd, { once: true })
      return () => { list.removeEventListener('animationend', onEnd); clearTimeout(timerRef.current) }
    }
    timerRef.current = setTimeout(advance, MIN_MS)
    return () => clearTimeout(timerRef.current)
  }, [idx, provinces])

  if (!region) return null

  const pause = () => { if (listRef.current) listRef.current.style.animationPlayState = 'paused' }
  const resume = () => { if (listRef.current) listRef.current.style.animationPlayState = 'running' }

  return (
    <div onMouseEnter={pause} onMouseLeave={resume}>
      <div key={idx} className="cb-slide-in px-3">
        <div className="mb-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[11.5px] font-semibold uppercase tracking-[0.06em] text-danger">{region.province}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted tabular-nums">{region.districts.length} districts</span>
          </div>
          {region.text && (
            // A constant height, not a max: long releases scroll inside the shared
            // thin scrollbar, and a short one keeps the same window, so the panel
            // does not jump as the carousel cycles between provinces.
            <div className="mt-1 h-[84px] overflow-y-auto cb-scroll">
              <p className="text-justify text-[10.5px] leading-relaxed text-muted">
                <Highlighted text={region.text} />
              </p>
            </div>
          )}
        </div>

        <div ref={viewRef} className="overflow-hidden" style={{ height: VIEW_H }}>
          <div ref={listRef} className="cb-vscroll-track flex flex-col gap-1.5">
            {region.districts.map((d) => <DistrictCard key={d.code} name={d.name} cari={cari[d.name]} />)}
          </div>
        </div>
      </div>

      {provinces.length > 1 && (
        <div className="mt-2.5 flex items-center justify-center gap-1.5 px-3">
          {provinces.map((p, i) => (
            <span
              key={p.province}
              className="h-1.5 rounded-full transition-all duration-300"
              style={{ width: i === idx ? '14px' : '6px', background: i === idx ? 'var(--cb-danger)' : 'var(--cb-border-strong)' }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
