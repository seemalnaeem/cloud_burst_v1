// The "Update data" control in the header.
//
// Idle it is a small button that starts a manual forecast ingest; while a run is
// in flight (whether started here or by the daily scheduler) it becomes a single
// wide bar that fills with overall progress and names the model and field it is on
// with a step count. It sits on the fixed teal header, so its colours are the
// header's cream on translucent white in both themes.

import { useMemo, useState } from 'react'
import { TbRefresh, TbLoader2, TbAlertTriangle, TbCheck } from 'react-icons/tb'

const fmt = (iso) => {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi'
    })
  } catch {
    return null
  }
}

export default function IngestControl ({ status, error, onRun }) {
  const [armed, setArmed] = useState(false)
  const running = Boolean(status?.running)
  const configured = status?.configured !== false
  const fieldIndex = status?.fieldIndex ?? 0
  const totalFields = status?.totalFields ?? 0
  const current = status?.current ?? null

  // Overall fraction: whole fields already done, plus the current field's part.
  const pct = useMemo(() => {
    if (!totalFields) return 0
    const frac = current?.total ? current.done / current.total : 0
    return Math.round(Math.max(0, Math.min(1, ((fieldIndex - 1) + frac) / totalFields)) * 100)
  }, [fieldIndex, totalFields, current])

  if (running) {
    return (
      <div
        className="relative hidden h-7 w-[240px] shrink-0 overflow-hidden rounded-full border xl:block xl:w-[320px]"
        style={{ borderColor: 'var(--cb-header-pill-border)', background: 'rgba(255,255,255,0.12)' }}
        title={`Updating forecast data — field ${fieldIndex} of ${totalFields}`}
      >
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%`, background: 'rgba(255,255,255,0.30)' }}
        />
        <div className="relative flex h-full items-center gap-2 pl-2.5 pr-3">
          <TbLoader2 className="shrink-0 animate-spin text-[13px] text-cream" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[11px]">
            {current
              ? (
                <>
                  <span className="font-semibold tracking-tight text-cream">{current.modelLabel}</span>
                  <span className="mx-1 text-cream/40" aria-hidden>·</span>
                  <span className="font-normal text-cream/75">{current.label}</span>
                </>
                )
              : <span className="font-medium text-cream/80">Preparing…</span>}
          </span>
          {current && (
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-cream/90">
              {current.done}/{current.total}
            </span>
          )}
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-cream/70">
            {fieldIndex}/{totalFields}
          </span>
        </div>
      </div>
    )
  }

  const failed = Boolean(error || status?.error)
  // Fresh means we already hold data newer than the most recent daily slot, so a
  // re-fetch would only churn the layers. The backend decides this; a run stays
  // available when it failed, so a broken cycle can be retried.
  const fresh = status?.stale === false && !failed
  const lastRefresh = fmt(status?.lastRefresh) || fmt(status?.finishedAt)
  const nextScheduled = fmt(status?.nextScheduled)

  // Confirmation before a manual run, because it re-catalogues every band and the
  // layers vanish and refill while it runs. One armed click, then Run or Cancel.
  if (armed && configured && !fresh) {
    return (
      <div
        className="hidden items-center gap-1 rounded-full py-0.5 pl-2.5 pr-0.5 text-[11px] text-cream lg:flex"
        style={{ background: 'rgba(255,255,255,0.10)' }}
      >
        <span className="font-medium">Refetch all data?</span>
        <button
          type="button"
          onClick={() => { setArmed(false); onRun?.() }}
          className="ml-1 cursor-pointer rounded-full px-2 py-1 text-[11px] font-semibold text-teal transition-colors hover:brightness-105"
          style={{ background: 'var(--cb-cream)' }}
        >
          Run
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          className="cursor-pointer rounded-full px-2 py-1 text-[11px] font-medium text-cream/80 transition-colors hover:text-cream"
        >
          Cancel
        </button>
      </div>
    )
  }

  const Icon = failed ? TbAlertTriangle : fresh ? TbCheck : TbRefresh
  const label = fresh ? 'Up to date' : 'Update data'
  const title = !configured
    ? 'Forecast data source is not configured'
    : status?.error
      ? `Last run failed: ${status.error}`
      : fresh
        ? `Data is up to date${lastRefresh ? ` (updated ${lastRefresh})` : ''}.${nextScheduled ? ` Next automatic refresh ${nextScheduled} PKT.` : ''}`
        : lastRefresh
          ? `Fetch the latest forecast data. Last updated ${lastRefresh}.`
          : 'Fetch the latest forecast data'

  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      disabled={!configured || fresh}
      title={title}
      className="hidden items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11.5px] font-medium text-cream transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45 lg:flex"
      style={{ background: 'rgba(255,255,255,0.10)' }}
    >
      <Icon className="text-[14px]" aria-hidden />
      <span className="hidden xl:inline">{label}</span>
    </button>
  )
}
