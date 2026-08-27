// The Alerts panel.
//
// A standing panel in the Analysis tab, bottom right, that presents the latest
// PMD rain-wind advisory as a running carousel of convective-activity alerts
// rather than sending the user to the source page. It is always present while the
// Analysis tab is open, so it also carries the "not configured", "no advisory" and
// "feed down" states. Every surface is theme-token styled, so it reads on both the
// light and dark panel.

import { TbAlertTriangle, TbChevronLeft, TbChevronRight } from 'react-icons/tb'

import AlertsCarousel from './AlertsCarousel'
import { Panel } from './ui/Panel'

const ALERT_RED = '#ef4444'

function Empty ({ children }) {
  return <p className="px-3 py-5 text-center text-[11.5px] leading-snug text-muted">{children}</p>
}

// Walk the advisory provinces one at a time: each step focuses a single province,
// flashing only its districts and flying the map to it. Shown only when there is
// more than one province to step between.
function Stepper ({ provinces, provincesOn, onStep }) {
  if (!onStep || provinces.length < 2) return null
  const focused = provincesOn?.size === 1 ? [...provincesOn][0] : null
  const btn = 'grid h-6 w-6 shrink-0 place-items-center rounded-cb-sm border border-border bg-panel text-text-2 transition-colors hover:border-border-strong hover:text-text'
  return (
    <div className="mx-3 mb-2 flex items-center gap-2 rounded-cb-sm border border-border bg-panel-2/50 px-2 py-1.5">
      <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-[0.07em] text-muted">Review</span>
      <span className="min-w-0 flex-1 truncate text-center text-[11px] font-medium text-text">
        {focused || 'Step through provinces'}
      </span>
      <button type="button" onClick={() => onStep(-1)} aria-label="Previous province" className={btn}>
        <TbChevronLeft className="text-[13px]" aria-hidden />
      </button>
      <button type="button" onClick={() => onStep(1)} aria-label="Next province" className={btn}>
        <TbChevronRight className="text-[13px]" aria-hidden />
      </button>
    </div>
  )
}

export default function AlertsPanel ({ release, provinces = [], cari = {}, configured = true, error, provincesOn, onStepAlert }) {
  const total = provinces.reduce((n, p) => n + p.districts.length, 0)
  const has = Boolean(release) && provinces.length > 0

  return (
    <Panel
      title="Convective Alerts"
      icon={TbAlertTriangle}
      accent={ALERT_RED}
      className="w-[min(360px,calc(100vw-2rem))]"
      bodyClassName="py-3"
      actions={has
        ? (
          <span className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-danger-soft px-1.5 py-0.5 text-[10.5px] font-bold text-danger tabular-nums">
            {total}
          </span>
          )
        : undefined}
      footer={has && release?.date
        ? (
          <div className="flex items-center justify-between text-[10px] text-muted">
            <span className="font-medium text-danger">PMD rain-wind advisory</span>
            <span>Issued {release.date}</span>
          </div>
          )
        : undefined}
    >
      {!configured ? (
        <Empty>The advisory source is not configured.</Empty>
      ) : !has ? (
        <Empty>{error ? 'The advisory feed is unavailable right now.' : 'No active rain-wind advisory right now.'}</Empty>
      ) : (
        <>
          <Stepper provinces={provinces} provincesOn={provincesOn} onStep={onStepAlert} />
          <AlertsCarousel provinces={provinces} cari={cari} />
        </>
      )}
    </Panel>
  )
}
