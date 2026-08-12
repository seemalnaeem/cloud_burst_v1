// An indeterminate loading bar for the detail cards.
//
// A slim highlight sweeps across a track (the animation lives in index.css, so it
// respects prefers-reduced-motion). Used wherever a card is waiting on a fetch or
// a score, in place of a static line of text.

export function LoadingBar ({ label }) {
  return (
    <div className="px-2 py-8">
      <div
        className="relative mx-auto h-1 w-40 overflow-hidden rounded-full"
        style={{ background: 'var(--cb-track)' }}
        role="progressbar"
        aria-label={label || 'Loading'}
      >
        <span
          className="cb-loadbar absolute top-0 bottom-0 rounded-full"
          style={{ background: 'var(--cb-primary)', left: '-42%', width: '42%' }}
        />
      </div>
      {label && <p className="mt-3 text-center text-[12px] text-muted">{label}</p>}
    </div>
  )
}
