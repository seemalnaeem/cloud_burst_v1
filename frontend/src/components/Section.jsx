import { useState } from 'react'
import { FiChevronDown } from 'react-icons/fi'

/**
 * Collapsible sidebar section.
 *
 * The per state styling lives in index.css as .cb-section, because it is three
 * states across two themes and that does not read well as a string of Tailwind
 * classes. Flat fills plus a left accent bar, no gradient.
 */
export default function Section ({ icon: Icon, title, badge, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-open={open}
        aria-expanded={open}
        className="cb-section flex w-full items-center gap-3 rounded-cb-sm px-3 py-2.5 text-left transition-colors"
      >
        {Icon && (
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
            style={{ background: 'var(--cb-teal-accent)' }}
          >
            <Icon size={15} color="var(--cb-on-dark)" aria-hidden="true" />
          </span>
        )}

        <span className="flex-1 text-sm font-semibold text-text">{title}</span>

        {badge != null && (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ background: 'var(--cb-chip)', color: 'var(--cb-chip-text)' }}
          >
            {badge}
          </span>
        )}

        <FiChevronDown
          size={16}
          className="text-text-2 transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'none' }}
          aria-hidden="true"
        />
      </button>

      {open && <div className="mt-1 pl-2">{children}</div>}
    </section>
  )
}
