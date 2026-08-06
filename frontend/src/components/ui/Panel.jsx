// The floating panel shell.
//
// Every dock on the map is one of these, which is what keeps the corner radius,
// the border weight, the header height and the collapse behaviour identical
// across the portal. A panel that styles itself is a panel that drifts.
//
// Surfaces are flat fills. No gradients anywhere in this project, by owner's
// rule, so depth comes from the border and the shadow instead.

import { TbChevronDown } from 'react-icons/tb'

export function Panel ({
  title,
  icon: Icon,
  accent,
  actions,
  collapsed = false,
  onToggle,
  children,
  className = '',
  bodyClassName = '',
  footer
}) {
  const collapsible = typeof onToggle === 'function'

  return (
    <section
      className={`pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-cb border border-border bg-panel shadow-cb-lg backdrop-blur-[2px] ${className}`}
    >
      <header
        className={`flex h-11 shrink-0 items-center gap-2.5 border-b border-border bg-panel-2 pl-3 pr-2 ${collapsible ? 'cursor-pointer select-none' : ''}`}
        onClick={collapsible ? onToggle : undefined}
      >
        {/* A 3px bar rather than a tinted header. Same job, no gradient. */}
        {accent && <span className="h-4 w-[3px] shrink-0 rounded-full" style={{ background: accent }} />}

        {Icon && <Icon className="shrink-0 text-[15px] text-primary" aria-hidden />}

        <h2 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-wide text-text uppercase">
          {title}
        </h2>

        {actions && (
          <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}

        {collapsible && (
          <TbChevronDown
            className={`shrink-0 text-[15px] text-muted transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
            aria-hidden
          />
        )}
      </header>

      {!collapsed && (
        <div className={`cb-scroll min-h-0 flex-1 overflow-y-auto ${bodyClassName}`}>{children}</div>
      )}

      {!collapsed && footer && (
        <div className="shrink-0 border-t border-border bg-panel-2 px-3 py-2">{footer}</div>
      )}
    </section>
  )
}

/**
 * Square icon button, the unit every map control and panel action is built from.
 *
 * `active` is a real state rather than a hover style, because half these
 * buttons are toggles and a toggle that looks identical whether it is on or off
 * is not a toggle.
 */
export function IconButton ({
  icon: Icon,
  label,
  onClick,
  active = false,
  disabled = false,
  size = 'md',
  tone = 'default',
  className = ''
}) {
  const dims = size === 'sm' ? 'h-7 w-7 text-[14px]' : size === 'lg' ? 'h-10 w-10 text-[18px]' : 'h-8 w-8 text-[16px]'

  const tones = {
    default: active
      ? 'bg-primary-soft text-primary border-primary-border'
      : 'bg-panel text-text-2 border-border hover:bg-panel-3 hover:text-text',
    ghost: active
      ? 'bg-primary-soft text-primary border-transparent'
      : 'bg-transparent text-muted border-transparent hover:bg-panel-3 hover:text-text',
    brand: 'border-transparent text-cream hover:bg-[rgba(255,255,255,0.12)]'
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex shrink-0 items-center justify-center rounded-cb-sm border transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${dims} ${tones[tone]} ${className}`}
    >
      <Icon aria-hidden />
    </button>
  )
}

/** A vertical stack of IconButtons that reads as one control, like a keypad. */
export function ControlGroup ({ children, className = '' }) {
  return (
    <div
      className={`pointer-events-auto flex flex-col overflow-hidden rounded-cb-sm border border-border bg-panel shadow-cb-lg [&>button]:rounded-none [&>button]:border-0 [&>button+button]:border-t [&>button+button]:border-border ${className}`}
    >
      {children}
    </div>
  )
}

export function Chip ({ children, color, className = '' }) {
  if (color) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}
        style={{ background: `${color}1f`, color, border: `1px solid ${color}59` }}
      >
        {children}
      </span>
    )
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-chip px-2 py-0.5 text-[11px] font-medium text-chip-text ${className}`}>
      {children}
    </span>
  )
}
