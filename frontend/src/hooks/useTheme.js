// Theme toggle.
//
// The initial value is read in index.html before React mounts, which is what
// stops a dark mode user seeing a flash of light theme on every load. This hook
// only handles switching afterwards.

import { useCallback, useEffect, useState } from 'react'

import { getTheme, setTheme as persistTheme } from '@/lib/storage'

const readCurrent = () =>
  document.documentElement.getAttribute('data-theme') || getTheme() || 'light'

export function useTheme () {
  const [theme, setThemeState] = useState(readCurrent)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    persistTheme(theme)
  }, [theme])

  const toggle = useCallback(() => {
    setThemeState((current) => (current === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, isDark: theme === 'dark', toggle, setTheme: setThemeState }
}
