import StatusBanner from '@/components/StatusBanner'
import { useAsync } from '@/hooks/useAsync'
import { getAlerts } from '@/lib/api'
import { fmtDate, fmtPercent } from '@/lib/format'

export default function AlertsPanel () {
  const alerts = useAsync((signal) => getAlerts(signal), [])

  if (alerts.isLoading) {
    return <p className="px-2 py-3 text-sm text-muted">Loading alerts…</p>
  }

  if (alerts.isError) {
    const isPending = alerts.error.code === 'NOT_CONFIGURED'
    return (
      <StatusBanner
        kind={isPending ? 'info' : 'warn'}
        title={isPending ? 'Alerts not available yet' : 'Alert feed failed'}
        message={alerts.error.message}
      />
    )
  }

  const { alerts: rows = [], targetDate, count } = alerts.data ?? {}

  if (!count) {
    return (
      <p className="px-2 py-3 text-sm text-muted">
        No districts reach the alert threshold for {fmtDate(targetDate, { withTime: false })}.
      </p>
    )
  }

  return (
    <div className="space-y-2 px-1 py-2">
      <p className="text-xs text-muted">
        {count} district{count === 1 ? '' : 's'} for {fmtDate(targetDate, { withTime: false })}
      </p>

      <ul className="space-y-1">
        {rows.map((row) => (
          <li
            key={row.district_name}
            className="rounded-cb-sm bg-panel-2 p-2"
            style={{ borderLeft: `4px solid ${row.risk_color}` }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium text-text">{row.district_name}</span>
              <span className="shrink-0 text-xs font-semibold" style={{ color: row.risk_color }}>
                {fmtPercent(row.cari)}
              </span>
            </div>
            <p className="text-xs text-muted">
              {row.province} · {row.risk_level}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}
