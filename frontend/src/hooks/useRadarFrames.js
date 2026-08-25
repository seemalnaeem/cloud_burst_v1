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
// Returns { frames: { [layerId]: { frames: [{ timestamp, imageUrl }] } }, error,
// stale, asOf }. The last known series is kept between refreshes so the loop
// never blanks. stale/asOf come from the gateway falling back to the last-known
// listing when a site's live directory is unreachable: true if any active site
// is currently stale, and asOf the oldest of those sites' fallback timestamps.

import { useEffect, useState } from 'react'

import { getRadarFrames, radarImageUrl } from '@/lib/api'
import { radar } from '@/lib/contracts'

export function useRadarFrames (activeLayers) {
  const [frames, setFrames] = useState({})
  const [error, setError] = useState(null)
  // The most recent successful poll's stale/asOf per site, so the overall flag
  // can be derived across every active site rather than just the last one to
  // resolve.
  const [siteStatus, setSiteStatus] = useState({})
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
        setSiteStatus((prev) => ({ ...prev, [site]: { stale: Boolean(res.stale), asOf: res.asOf ?? null } }))
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

  // Drop status for a site that is no longer active, so a stale flag from a
  // hidden site's controls cannot linger into the notice.
  useEffect(() => {
    setSiteStatus((prev) => {
      const next = {}
      for (const site of sites) if (prev[site]) next[site] = prev[site]
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sitesKey])

  const activeStatuses = sites.map((s) => siteStatus[s]).filter(Boolean)
  const staleStatuses = activeStatuses.filter((s) => s.stale)
  const stale = staleStatuses.length > 0
  const asOf = staleStatuses.reduce((oldest, s) => {
    if (!s.asOf) return oldest
    if (!oldest) return s.asOf
    return new Date(s.asOf) < new Date(oldest) ? s.asOf : oldest
  }, null)

  return { frames, error, stale, asOf }
}
