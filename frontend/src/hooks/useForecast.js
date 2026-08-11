// The forecast cycle that drives the timeline, for the active model.
//
// One model is active at a time. This asks the API for that model's newest
// cycle, its model code, and the lead hours it actually published; the slider
// scrubs those leads and the raster tiles carry the model, cycle and lead. It
// also returns availableModels, the set of models that have a cycle at all, so
// the panel can offer a selector.
//
// It reloads on two triggers: the active model changing, and raster availability
// changing. The second matters because the cycle is discovered by the same
// ingest that makes the layers available, so without it the slider would stay
// empty until a full page refresh even though the data had just landed.

import { useCallback, useEffect, useState } from 'react'

import { getForecastMeta } from '@/lib/api'

const EMPTY = { status: 'loading', creationTime: null, model: null, leads: [], availableModels: [] }

export function useForecast (model, availabilitySignal) {
  const [state, setState] = useState(EMPTY)

  const load = useCallback((signal) => {
    getForecastMeta(model, signal)
      .then((meta) => {
        const availableModels = meta?.availableModels || []
        if (meta?.status === 'ok') {
          setState({
            status: 'ok',
            creationTime: meta.creationTime,
            model: meta.model,
            leads: (meta.publishedLeads || []).slice().sort((a, b) => a - b),
            availableModels
          })
        } else {
          setState({ status: 'no_data', creationTime: null, model: meta?.model ?? null, leads: [], availableModels })
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        setState({ status: 'error', creationTime: null, model: null, leads: [], availableModels: [] })
      })
  }, [model])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
    // model and availabilitySignal are both reload triggers.
  }, [load, availabilitySignal])

  return state
}
