// Daily "Extreme Events" data for the Convective Alerts panel.
//
// Two jobs in one hook. Whenever an active kind is set it fetches the list of
// upcoming forecast days so the dropdown can populate. When a day is selected it
// polls that day until the background pass turns "ready", the same shape as the
// choropleth: the first request for a cold day comes back "computing" and this
// keeps asking until the class array lands. Finished days are cached per
// (kind, day) so re-selecting one repaints instantly.
//
// Returns { status, days, features, extremeKeys, extremeCount }. extremeKeys is
// the set of join values (district_name / tehsil_code) to flash on the map.

import { useEffect, useRef, useState } from 'react'

import { getExtremeEvents } from '@/lib/api'

const POLL_MS = 4000
const EMPTY = { status: 'idle', days: [], features: [], extremeKeys: [], extremeCount: 0 }

export function useExtremeEvents (kind, day) {
  const [state, setState] = useState(EMPTY)
  const cacheRef = useRef(new Map()) // `${kind}:${day}` -> { features, extremeCount }

  useEffect(() => {
    if (!kind) {
      setState(EMPTY)
      return
    }
    let cancelled = false
    let timer

    const settle = (res, features, extremeCount) => ({
      status: 'ready',
      days: res.days || [],
      features,
      extremeKeys: features.filter((f) => f.extreme).map((f) => f.key),
      extremeCount
    })

    const poll = async () => {
      try {
        const res = await getExtremeEvents(kind, day)
        if (cancelled) return

        // No day selected: we only wanted the day list. Keep any features empty.
        if (day === null || day === undefined) {
          setState({ status: 'ready', days: res.days || [], features: [], extremeKeys: [], extremeCount: 0 })
          return
        }

        if (res.status === 'ready') {
          const features = res.features || []
          cacheRef.current.set(`${kind}:${day}`, { features, extremeCount: res.extremeCount || 0 })
          setState(settle(res, features, res.extremeCount || 0))
        } else {
          setState((s) => ({ ...s, status: 'computing', days: res.days || s.days }))
          timer = setTimeout(poll, POLL_MS)
        }
      } catch (error) {
        if (!cancelled) setState((s) => ({ ...s, status: 'error', error }))
      }
    }

    const hit = day != null ? cacheRef.current.get(`${kind}:${day}`) : null
    if (hit) {
      setState((s) => ({
        status: 'ready',
        days: s.days,
        features: hit.features,
        extremeKeys: hit.features.filter((f) => f.extreme).map((f) => f.key),
        extremeCount: hit.extremeCount
      }))
    } else {
      setState((s) => ({ ...s, status: 'computing' }))
    }
    poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [kind, day])

  return state
}
