// Live status of the forecast ingest, for the header's "Update data" control.
//
// Polls the status endpoint slowly while idle and quickly while a run is in
// flight, so the progress bar moves without hammering the API the rest of the
// time. Exposes a trigger that starts a manual run and switches to fast polling
// straight away, so the bar appears the moment the button is pressed.

import { useCallback, useEffect, useRef, useState } from 'react'

import { getIngestStatus, runIngest } from '@/lib/api'

const IDLE_MS = 20000
const BUSY_MS = 1500

export function useIngestStatus () {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(false)
  const timerRef = useRef(null)

  const poll = useCallback(async () => {
    try {
      const s = await getIngestStatus()
      setStatus(s)
      setError(false)
      return s
    } catch {
      setError(true)
      return null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const s = await poll()
      if (cancelled) return
      timerRef.current = setTimeout(tick, s?.running ? BUSY_MS : IDLE_MS)
    }
    tick()
    return () => { cancelled = true; clearTimeout(timerRef.current) }
  }, [poll])

  const trigger = useCallback(async () => {
    try {
      const res = await runIngest()
      setStatus(res)
      setError(false)
      // Switch to fast polling immediately so the bar tracks the new run.
      clearTimeout(timerRef.current)
      const fast = async () => {
        const s = await poll()
        timerRef.current = setTimeout(s?.running ? fast : () => {}, s?.running ? BUSY_MS : IDLE_MS)
        if (!s?.running) timerRef.current = setTimeout(poll, IDLE_MS)
      }
      timerRef.current = setTimeout(fast, BUSY_MS)
      return res
    } catch {
      setError(true)
      return null
    }
  }, [poll])

  return { status, error, trigger }
}
