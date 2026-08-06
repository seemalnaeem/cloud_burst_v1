import { FiChevronLeft, FiChevronRight } from 'react-icons/fi'

import { fmtLead } from '@/lib/format'

/**
 * Forecast lead selector.
 *
 * Steps between leads the cycle actually published rather than along the
 * theoretical grid. A cycle publishes incrementally and skips grid points, so
 * stepping by 3 hours would land on leads that do not exist and return nothing.
 */
export default function LeadSlider ({ value, onChange, publishedLeads = [], minLead = -168 }) {
  const leads = publishedLeads.length ? publishedLeads : [0]
  const index = Math.max(0, leads.indexOf(value))

  const step = (direction) => {
    const next = Math.min(leads.length - 1, Math.max(0, index + direction))
    onChange(leads[next])
  }

  return (
    <div
      className="flex items-center gap-2 rounded-full px-2 py-1"
      style={{ background: 'var(--cb-header-pill-bg)', border: '1px solid var(--cb-header-pill-border)' }}
    >
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={index <= 0}
        aria-label="Previous forecast hour"
        className="rounded-full p-1 disabled:opacity-40"
        style={{ color: 'var(--cb-cream)' }}
      >
        <FiChevronLeft size={16} aria-hidden="true" />
      </button>

      <input
        type="range"
        min={0}
        max={leads.length - 1}
        value={index}
        onChange={(event) => onChange(leads[Number(event.target.value)])}
        aria-label={`Forecast lead, currently ${fmtLead(value)}`}
        className="w-32"
        style={{ accentColor: 'var(--cb-teal)' }}
      />

      <span className="min-w-16 text-center text-xs font-medium" style={{ color: 'var(--cb-cream)' }}>
        {fmtLead(value)}
      </span>

      <button
        type="button"
        onClick={() => step(1)}
        disabled={index >= leads.length - 1}
        aria-label="Next forecast hour"
        className="rounded-full p-1 disabled:opacity-40"
        style={{ color: 'var(--cb-cream)' }}
      >
        <FiChevronRight size={16} aria-hidden="true" />
      </button>

      <span className="sr-only">History reaches back to {fmtLead(minLead)}</span>
    </div>
  )
}
