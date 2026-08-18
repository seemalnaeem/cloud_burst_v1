// Warm the tiles the timeline slider is about to show.
//
// Moving to a new lead swaps the tile template on the raster source, and Mapbox
// then refetches every visible tile for that hour: two upstream hops each (resolve
// the COG, render the PNG), which is the pause you see when scrubbing or playing.
// The tiles are cacheable though, so this hook fetches the tiles for the upcoming
// leads over the current viewport ahead of time. By the time the slider lands on
// one, its tiles are already in the browser cache and the swap looks instant.
//
// Only plain forecast layers benefit: computed products (the CAR Index raster, the
// hotspot mask) ignore the slider lead and sit on a snapped lead of their own, so
// there is nothing ahead of them to warm.

import { useEffect, useRef } from 'react'

import { tileUrlsForViewport } from '@/lib/map'

// How many leads ahead of the playhead to keep warm while playing. Two to three
// steps is ample at the 1s (1x) play cadence and does not fan out into a flood.
const AHEAD_WHILE_PLAYING = 3
// At most this many prefetch requests in flight, so warming a future lead never
// starves the tiles the visible lead still needs.
const MAX_IN_FLIGHT = 6

// The lead indices to warm, given where the playhead is and whether it is moving.
// Playing: the next few, wrapping at the end so a looping animation stays warm.
// Paused: the immediate neighbours, so a manual step either way is instant.
function targetIndices (index, count, playing) {
  if (count <= 1) return []
  const out = []
  if (playing) {
    for (let i = 1; i <= AHEAD_WHILE_PLAYING; i++) out.push((index + i) % count)
  } else {
    out.push((index + 1) % count, (index - 1 + count) % count)
  }
  return [...new Set(out)].filter((i) => i !== index)
}

export function useRasterPrefetch ({
  map,
  rasterLayers,
  visibleLayers,
  leads,
  leadIndex,
  playing,
  creationTime
}) {
  // The layers worth warming: forecast temporal layers that are currently on.
  const targets = rasterLayers.filter(
    (def) => def.temporal && def.source !== 'computed' && visibleLayers.has(def.id)
  )
  const targetIds = targets.map((d) => d.id).join(',')

  // A stable dependency: re-warm when the playhead, the run, the play state, the
  // visible forecast layers or the lead set changes. Viewport changes are handled
  // by the moveend listener below rather than a dependency.
  const key = `${targetIds}@${creationTime}@${leadIndex}@${playing ? 'play' : 'pause'}@${leads.length}`

  const abortRef = useRef(null)

  useEffect(() => {
    if (!map || !creationTime || targets.length === 0 || leads.length <= 1) return

    const warm = () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      const indices = targetIndices(leadIndex, leads.length, playing)
      const urls = []
      for (const i of indices) {
        for (const def of targets) {
          urls.push(...tileUrlsForViewport(map, def, { creationTime, leadHours: leads[i] }))
        }
      }
      if (urls.length === 0) return

      // Drain the URL list through a small pool so at most MAX_IN_FLIGHT fetches
      // run at once. Each fetch is fire and forget: it only needs to land in the
      // browser cache, and a low priority keeps it out of the visible tiles' way.
      let cursor = 0
      const pump = () => {
        if (controller.signal.aborted || cursor >= urls.length) return
        const url = urls[cursor++]
        fetch(url, { priority: 'low', signal: controller.signal })
          .catch(() => {})
          .finally(() => { if (!controller.signal.aborted) pump() })
      }
      for (let i = 0; i < Math.min(MAX_IN_FLIGHT, urls.length); i++) pump()
    }

    warm()
    map.on('moveend', warm)
    return () => {
      map.off('moveend', warm)
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key])
}
