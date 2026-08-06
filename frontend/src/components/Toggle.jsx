export default function Toggle ({ checked, onChange, label, disabled = false }) {
  return (
    <label className={`flex items-center gap-3 py-1.5 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? 'var(--cb-teal-accent)' : 'var(--cb-toggle-off)' }}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full transition-transform"
          style={{
            left: 2,
            transform: checked ? 'translateX(16px)' : 'none',
            background: 'var(--cb-knob)',
            boxShadow: 'var(--cb-knob-shadow)'
          }}
        />
      </button>
      <span className="truncate text-sm text-text-2">{label}</span>
    </label>
  )
}
