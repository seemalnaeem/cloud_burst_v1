// Timeline warm-up for the Analysis view.
//
// The choropleth hook scores the lead the user is looking at. This one asks the
// backend to score every OTHER published lead in the background, so stepping the
// slider lands on a cache hit instead of a fresh minute-long pass. It does not
// paint anything; it just drives the warm-up and reports progress for a small
// readout. One entry per kind: { ready, total }.
//
// It polls the idempotent warm endpoint, which starts the background pass while
// leads remain and settles to a plain status read once the whole slider is warm.

import { useEffect, useState } from 'react'

import { warmTimeline } from '@/lib/api'

const POLL_MS = 4000

export function useWarmTimeline (kinds, active) {
  const [progress, setProgress] = useState({})
  const kindsKey = [...kinds].sort().join(',')

  useEffect(() => {
    if (!active || !kinds.length) return
    let cancelled = false
    const timers = []

    const tick = async (kind) => {
      try {
        const res = await warmTimeline(kind)
        if (cancelled) return
        setProgress((p) => ({ ...p, [kind]: { ready: res.ready, total: res.total } }))
        if (res.total === 0 || res.ready < res.total) {
          timers.push(setTimeout(() => tick(kind), POLL_MS))
        }
      } catch {
        // A warm-up failure is not fatal: on-demand scoring still fills each lead
        // as the user visits it. Try again on the next poll.
        if (!cancelled) timers.push(setTimeout(() => tick(kind), POLL_MS))
      }
    }

    kinds.forEach(tick)

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindsKey, active])

  return progress
}
