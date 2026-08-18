// Live radar frames for the Radar view.
//
// The radar imagery is real time: the source publishes a new scan every few
// minutes under a timestamped filename. The gateway discovers the newest frame
// per product and proxies it, so this hook only has to poll the gateway per
// active site and hand back the current image URL for each layer.
//
// One request per site returns all three products, so polling is keyed by the
// set of active sites, not by layer. Returns { [layerId]: { imageUrl, timestamp } },
// the last known frame kept between refreshes so the overlay never blanks.

import { useEffect, useState } from 'react'

import { getRadarFrames, radarImageUrl } from '@/lib/api'
import { radar } from '@/lib/contracts'

export function useRadarFrames (activeLayers) {
  const [frames, setFrames] = useState({})
  const sites = [...new Set(activeLayers.map((l) => l.site))].sort()
  const sitesKey = sites.join(',')

  useEffect(() => {
    if (!sites.length) return
    let cancelled = false
    const timers = []
    const refreshMs = (radar().refreshSeconds ?? 180) * 1000

    const poll = async (site) => {
      try {
        const res = await getRadarFrames(site)
        if (cancelled) return
        setFrames((prev) => {
          const next = { ...prev }
          for (const f of res.frames) {
            next[`radar:${site}:${f.product}`] = { imageUrl: radarImageUrl(f.path), timestamp: f.timestamp }
          }
          return next
        })
      } catch {
        // A refresh failure is not fatal: the previous frame stays on the map and
        // the next tick tries again.
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

  return frames
}
