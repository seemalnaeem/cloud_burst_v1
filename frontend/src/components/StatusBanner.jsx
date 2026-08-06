import { FiAlertCircle, FiAlertTriangle, FiCheckCircle, FiInfo } from 'react-icons/fi'

// Status colors come from the semantic token triplets: a saturated base for the
// icon and text, a soft fill, and a matching border.
const KINDS = {
  info: { Icon: FiInfo, base: 'var(--cb-primary)', fill: 'var(--cb-primary-soft)', border: 'var(--cb-primary-border)' },
  ok: { Icon: FiCheckCircle, base: 'var(--cb-green)', fill: 'var(--cb-green-soft)', border: 'var(--cb-green-border)' },
  warn: { Icon: FiAlertTriangle, base: 'var(--cb-amber)', fill: 'var(--cb-amber-soft)', border: 'var(--cb-amber-border)' },
  danger: { Icon: FiAlertCircle, base: 'var(--cb-danger)', fill: 'var(--cb-danger-soft)', border: 'var(--cb-danger-border)' }
}

export default function StatusBanner ({ kind = 'info', title, message, detail }) {
  const { Icon, base, fill, border } = KINDS[kind] ?? KINDS.info

  return (
    <div
      role={kind === 'danger' ? 'alert' : 'status'}
      className="flex max-w-xl items-start gap-3 rounded-cb p-4"
      style={{ background: fill, border: `1px solid ${border}` }}
    >
      <Icon size={20} style={{ color: base, flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
      <div className="min-w-0">
        {title && <p className="font-semibold" style={{ color: base }}>{title}</p>}
        {message && <p className="mt-1 text-sm text-text-2">{message}</p>}
        {detail && <p className="mt-2 text-xs text-muted">{detail}</p>}
      </div>
    </div>
  )
}
