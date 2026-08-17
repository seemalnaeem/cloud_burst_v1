// Prepare the computed raster layers before the map draws them.
//
// The per pixel CAR Index and the hotspot mask are graded on every forecast cell,
// which is far too slow to do inside a tile request, so the API generates them on
// demand and catalogues the result. This hook drives that from the client: for
// each visible computed layer at the current lead it asks the API to prepare the
// product, and polls while a background pass runs, exactly the way the choropleth
// waits for its class array.
//
// It returns a map from layer id to { status, creationTime, leadHours }. The map
// only shows a computed layer once its entry reads "ready", and points the tiles
// at the returned cycle and lead rather than the active model's, because these
// products live on the WRFPRS grid and the lead is snapped to what it publishes.

import { useEffect, useRef, useState } from 'react'

import { getComputeStatus } from '@/lib/api'

const POLL_MS = 1500

export function useComputedRasters (computedIds, forecastHours) {
  const [status, setStatus] = useState({})
  // A stable key so the effect re-runs when the set of layers or the lead
  // changes, but not when the array identity changes with the same contents.
  const key = `${[...computedIds].sort().join(',')}@${forecastHours}`
  const timers = useRef([])

  useEffect(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []

    if (!computedIds.length || forecastHours == null) {
      setStatus({})
      return
    }

    const controller = new AbortController()
    let cancelled = false

    const poll = (id) => {
      getComputeStatus(id, forecastHours, controller.signal)
        .then((res) => {
          if (cancelled) return
          setStatus((prev) => ({ ...prev, [id]: res }))
          // Keep asking until the COG is catalogued, then stop: a ready layer is
          // steady until the lead or cycle moves, which re-runs this effect.
          if (res.status !== 'ready') {
            timers.current.push(setTimeout(() => poll(id), POLL_MS))
          }
        })
        .catch((err) => {
          if (cancelled || err.name === 'AbortError') return
          setStatus((prev) => ({ ...prev, [id]: { status: 'error', message: err.message } }))
        })
    }

    computedIds.forEach(poll)

    return () => {
      cancelled = true
      controller.abort()
      timers.current.forEach(clearTimeout)
      timers.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return status
}
