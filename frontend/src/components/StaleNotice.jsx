// A calm inline notice for graceful degradation.
//
// Distinct from an error toast: stale means the portal has usable data, just not
// the freshest cut, because the live source could not be reached and the last
// known good result is shown instead. Sober by design, amber not red, and inline
// rather than a modal or toast so it never blocks the data it is describing.

import { TbAlertTriangle } from 'react-icons/tb'

const PKT_FORMAT = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' }

function formatAsOf (asOf) {
  return `${new Date(asOf).toLocaleString('en-GB', PKT_FORMAT)} PKT`
}

// Whole days once the age clears 48 hours, otherwise the hour count. A "2 days
// old" reads faster than "48 h old" past that point, and a "32 h old" is more
// honest than rounding a day and a third up to "1 day old".
function formatAge (ageHours) {
  return ageHours >= 48 ? `${Math.round(ageHours / 24)} days old` : `${Math.round(ageHours)} h old`
}

export default function StaleNotice ({ asOf, ageHours, label, className = '' }) {
  if (!asOf && ageHours == null) return null

  const text = asOf
    ? `Showing ${label} from ${formatAsOf(asOf)}. Live source unreachable, retrying.`
    : `Showing the latest available ${label} (${formatAge(ageHours)}). Live source unreachable.`

  return (
    <div className={`flex items-center gap-2 rounded-cb-sm border border-amber-border bg-amber-soft px-3 py-2 ${className}`}>
      <TbAlertTriangle className="shrink-0 text-[14px] text-amber" aria-hidden />
      <span className="text-[11.5px] font-medium text-amber">{text}</span>
    </div>
  )
}
