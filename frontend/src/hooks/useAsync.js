// Data fetching hook.
//
// One hook for every request, because the abort handling is the part everyone
// forgets. A user clicking through districts fires a request per click, and
// without an abort the slowest response wins and the panel shows a district the
// user has already moved past.

import { useCallback, useEffect, useRef, useState } from 'react'

const IDLE = { status: 'idle', data: null, error: null }

export function useAsync (fn, deps, { enabled = true } = {}) {
  const [state, setState] = useState(IDLE)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const run = useCallback(() => {
    if (!enabled) {
      setState(IDLE)
      return () => {}
    }

    const controller = new AbortController()
    setState((prev) => ({ ...prev, status: 'loading', error: null }))

    fnRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data, error: null })
      })
      .catch((error) => {
        // An abort is the expected outcome when the user moves on, not a
        // failure worth showing.
        if (error.name === 'AbortError' || controller.signal.aborted) return
        setState({ status: 'error', data: null, error })
      })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])

  useEffect(() => run(), [run])

  return {
    ...state,
    isLoading: state.status === 'loading',
    isReady: state.status === 'ready',
    isError: state.status === 'error',
    refetch: run
  }
}
