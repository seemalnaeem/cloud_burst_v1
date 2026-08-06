// localStorage with a namespace and a guard.
//
// Private browsing and some corporate policies make localStorage throw rather
// than return null. Every read and write here degrades to an in-memory fallback
// instead of taking the app down over a saved preference.

const PREFIX = 'cbd-'
const memory = new Map()

let available = null

function usable () {
  if (available !== null) return available
  try {
    const probe = `${PREFIX}__probe`
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    available = true
  } catch {
    available = false
  }
  return available
}

export function getStored (key, fallback = null) {
  const full = `${PREFIX}${key}`
  try {
    const raw = usable() ? window.localStorage.getItem(full) : memory.get(full)
    return raw === null || raw === undefined ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function setStored (key, value) {
  const full = `${PREFIX}${key}`
  const raw = JSON.stringify(value)
  try {
    if (usable()) window.localStorage.setItem(full, raw)
    else memory.set(full, raw)
  } catch {
    memory.set(full, raw)
  }
}

export function removeStored (key) {
  const full = `${PREFIX}${key}`
  try {
    if (usable()) window.localStorage.removeItem(full)
  } catch {
    // ignore
  }
  memory.delete(full)
}

// Theme is stored raw rather than as JSON, because index.html reads it in an
// inline script before any bundle loads and JSON.parse there would be noise.
export const THEME_KEY = `${PREFIX}theme`

export function getTheme () {
  try {
    return window.localStorage.getItem(THEME_KEY)
  } catch {
    return null
  }
}

export function setTheme (theme) {
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // A preference that does not persist is a smaller problem than a crash.
  }
}
