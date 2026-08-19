// High-Alert Districts advisory, polled from the gateway.
//
// The gateway reads the newest PMD RAIN-WIND press release, matches our districts
// against it and returns them bucketed by province. Press releases change on the
// order of hours, so a slow poll keeps the overlay current without hammering the
// source (the gateway also caches). The last good advisory is kept between polls
// so the overlay never blanks on a transient failure. A 501 means the source is
// not wired, which the panel shows as a configuration state rather than an error.

import { useEffect, useState } from 'react'

import { getAdvisories } from '@/lib/api'

const REFRESH_MS = 5 * 60 * 1000

export function useAdvisories (enabled = true, type = 'RAIN-WIND') {
  const [data, setData] = useState({ release: null, provinces: [], byCode: {} })
  const [error, setError] = useState(null)
  const [configured, setConfigured] = useState(true)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer = null

    const poll = async () => {
      try {
        const res = await getAdvisories(type)
        if (cancelled) return
        setData({ release: res.release ?? null, provinces: res.provinces ?? [], byCode: res.byCode ?? {} })
        setError(null)
        setConfigured(true)
      } catch (err) {
        if (cancelled) return
        if (err?.status === 501 || err?.code === 'NOT_CONFIGURED') {
          setConfigured(false)
          setError(null)
        } else {
          setError(err?.message || 'Advisories are unavailable right now.')
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, REFRESH_MS)
      }
    }

    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [enabled, type])

  return { ...data, error, configured }
}
