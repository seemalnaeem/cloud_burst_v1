// Which raster layers can currently serve a tile.
//
// Raster layers are declared in the contract long before their data arrives, so
// the panel would otherwise show five toggles of which two work. Asking the API
// what is catalogued turns that into a visible state: the row is there, it is
// disabled, and it says why.
//
// A layer is available when its band is catalogued. A cycle driven layer needs a
// forecast run as well, and none exists yet, which is a different sentence from
// "the file is missing" and worth saying differently.

import { useEffect, useState } from 'react'

import { getRasterCatalog } from '@/lib/api'

export function useRasterAvailability (rasterLayers) {
  const [bands, setBands] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const controller = new AbortController()

    getRasterCatalog(controller.signal)
      .then((payload) => setBands(payload?.bands ?? []))
      .catch((err) => {
        if (err.name === 'AbortError') return
        // Not fatal. An unreachable catalogue means we cannot say what is
        // available, so nothing is offered rather than everything being offered
        // and failing one tile at a time.
        setBands([])
        setError(err)
      })

    return () => controller.abort()
  }, [])

  // Keyed on band and model together, because the same band exists under several
  // models now (pmd_cape under GRAPES and WRFPRS), and a layer is available only
  // when its own model has that band. Static bands carry no model, so they key on
  // the band alone.
  const catKey = (band, model) => `${band}::${model ?? ''}`
  const byKey = new Map((bands ?? []).map((b) => [catKey(b.band_key ?? b.bandKey, b.model), b]))

  const availability = {}
  for (const layer of rasterLayers ?? []) {
    const entry = layer.band ? byKey.get(catKey(layer.band, layer.model)) : null

    if (layer.bandDriven) {
      // The forecast layer has no single band, it takes whichever one is
      // selected, so it is available once any cycle driven band is catalogued.
      const anyCycle = (bands ?? []).some((b) => !b.is_static && Number(b.cycles) > 0)
      availability[layer.id] = anyCycle
        ? { ok: true }
        : { ok: false, reason: 'No forecast cycle ingested yet' }
      continue
    }

    if (!entry) {
      availability[layer.id] = {
        ok: false,
        reason: layer.source === 'computed'
          ? 'Computed from a forecast cycle, none ingested yet'
          : 'Not ingested yet'
      }
      continue
    }

    if (layer.requiresCycle && !entry.is_static && Number(entry.cycles) === 0) {
      availability[layer.id] = { ok: false, reason: 'No forecast cycle ingested yet' }
      continue
    }

    availability[layer.id] = { ok: true }
  }

  return { availability, loading: bands === null, error }
}
