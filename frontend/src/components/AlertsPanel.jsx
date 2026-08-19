// The Alerts panel.
//
// A standing panel in the Analysis tab, bottom right, that presents the latest
// PMD rain-wind advisory as a running carousel of convective-activity alerts
// rather than sending the user to the source page. It is always present while the
// Analysis tab is open, so it also carries the "not configured", "no advisory" and
// "feed down" states. Every surface is theme-token styled, so it reads on both the
// light and dark panel.

import { TbAlertTriangle } from 'react-icons/tb'

import AlertsCarousel from './AlertsCarousel'
import { Panel } from './ui/Panel'

const ALERT_RED = '#ef4444'

function Empty ({ children }) {
  return <p className="px-3 py-5 text-center text-[11.5px] leading-snug text-muted">{children}</p>
}

export default function AlertsPanel ({ release, provinces = [], cari = {}, configured = true, error }) {
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
        <AlertsCarousel provinces={provinces} cari={cari} />
      )}
    </Panel>
  )
}
