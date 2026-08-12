// CARI choropleth data for the Analysis view.
//
// Scoring a whole layer takes seconds for districts and minutes for tehsils, so
// the endpoint answers immediately with either the finished class array or a
// "computing" marker while a background pass runs. This hook polls each active
// kind until it turns ready and refetches when the lead changes, so the map
// colours follow the timeline. One entry per kind: { status, features }.

import { useEffect, useState } from 'react'

import { getCariChoropleth } from '@/lib/api'

const POLL_MS = 4000

export function useCariChoropleth (kinds, leadHours) {
  const [data, setData] = useState({})
  const kindsKey = [...kinds].sort().join(',')

  useEffect(() => {
    if (!kinds.length || leadHours == null) return
    let cancelled = false
    const timers = []

    const poll = async (kind) => {
      try {
        const res = await getCariChoropleth(kind, leadHours)
        if (cancelled) return
        if (res.status === 'ready') {
          setData((d) => ({ ...d, [kind]: { status: 'ready', features: res.features, leadHours } }))
        } else {
          setData((d) => ({ ...d, [kind]: { status: 'computing', leadHours } }))
          timers.push(setTimeout(() => poll(kind), POLL_MS))
        }
      } catch (error) {
        if (!cancelled) setData((d) => ({ ...d, [kind]: { status: 'error', error, leadHours } }))
      }
    }

    kinds.forEach((kind) => {
      // Mark computing right away unless this kind is already ready for this
      // exact lead, so a lead change repaints from a clean loading state rather
      // than showing the previous lead's colours as if current.
      setData((d) => {
        const cur = d[kind]
        if (cur?.status === 'ready' && cur.leadHours === leadHours) return d
        return { ...d, [kind]: { status: 'computing', leadHours } }
      })
      poll(kind)
    })

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindsKey, leadHours])

  return data
}
