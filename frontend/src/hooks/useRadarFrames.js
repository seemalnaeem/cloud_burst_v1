// Radar frame series for the Radar view.
//
// The radar imagery is real time: the source publishes a new scan every ten
// minutes under a timestamped filename. The gateway discovers the whole ordered
// series per product from the directory listing and proxies it, so this hook
// polls the gateway per active site and hands back, for each layer, the full list
// of frames (timestamp plus a proxied image URL). The Radar timeline slider then
// animates and scrubs that series; a frame that has rolled off 404s and the
// gateway serves it transparent, so only a genuine listing failure surfaces here
// as an error for a toast.
//
// Returns { frames: { [layerId]: { frames: [{ timestamp, imageUrl }] } }, error }.
// The last known series is kept between refreshes so the loop never blanks.

import { useEffect, useState } from 'react'

import { getRadarFrames, radarImageUrl } from '@/lib/api'
import { radar } from '@/lib/contracts'

export function useRadarFrames (activeLayers) {
  const [frames, setFrames] = useState({})
  const [error, setError] = useState(null)
  const sites = [...new Set(activeLayers.map((l) => l.site))].sort()
  const sitesKey = sites.join(',')

  useEffect(() => {
    if (!sites.length) { setError(null); return }
    let cancelled = false
    const timers = []
    const refreshMs = (radar().refreshSeconds ?? 180) * 1000

    const poll = async (site) => {
      try {
        const res = await getRadarFrames(site)
        if (cancelled) return
        setError(null)
        setFrames((prev) => {
          const next = { ...prev }
          for (const p of res.products) {
            next[`radar:${site}:${p.product}`] = {
              frames: p.frames.map((f) => ({ timestamp: f.timestamp, imageUrl: radarImageUrl(f.path) }))
            }
          }
          return next
        })
      } catch (err) {
        // A refresh failure keeps the previous series on the map; surface it for a
        // toast so the user knows the loop may be stale, and try again next tick.
        if (!cancelled) setError(err.message || 'Radar imagery is unavailable right now.')
      } finally {
        if (!cancelled) timers.push(setTimeout(() => poll(site), refreshMs))
      }
    }

    sites.forEach(poll)

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sitesKey])

  return { frames, error }
}
