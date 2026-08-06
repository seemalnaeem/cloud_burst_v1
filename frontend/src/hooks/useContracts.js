// Load the shared contracts once at startup.
//
// Everything downstream depends on these, so the app shell waits for them
// rather than rendering components that would immediately throw on a missing
// palette.

import { useEffect, useState } from 'react'

import { loadContracts } from '@/lib/contracts'

export function useContracts () {
  const [state, setState] = useState({ status: 'loading', error: null })

  useEffect(() => {
    const controller = new AbortController()

    loadContracts(controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setState({ status: 'ready', error: null })
      })
      .catch((error) => {
        if (error.name === 'AbortError') return
        setState({ status: 'error', error })
      })

    return () => controller.abort()
  }, [])

  return state
}
