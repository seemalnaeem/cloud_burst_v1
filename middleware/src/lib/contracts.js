// Loader for shared/contracts.
//
// Same files the backend and the frontend read. The gateway needs them for
// parameter validation, so a bad band key is rejected at the edge instead of
// travelling to FastAPI and coming back as a 500.

import fs from 'node:fs'
import path from 'node:path'

const CONTRACTS_DIR = process.env.CONTRACTS_DIR || '/shared/contracts'

const stripComments = (node) => {
  if (Array.isArray(node)) return node.map(stripComments)
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => !k.startsWith('$'))
        .map(([k, v]) => [k, stripComments(v)])
    )
  }
  return node
}

// Keyed by name, holding the parsed contract and the mtime it was parsed at.
//
// Caching on the name alone is correct in production, where the files never
// change under a running process, and quietly wrong in development, where
// ./shared is bind mounted: editing a contract had no effect until the
// container restarted. The backend had the identical bug and it cost an
// afternoon, because the frontend was served a stale basemap catalogue and
// rendered a blank map with no error anywhere. A stat per call is cheap next to
// the parse it still avoids.
const cache = new Map()

export function load (name) {
  const file = path.join(CONTRACTS_DIR, `${name}.json`)
  if (!fs.existsSync(file)) {
    throw new Error(`Contract ${name}.json not found at ${file}. Is ./shared mounted into the container?`)
  }

  const mtime = fs.statSync(file).mtimeMs
  const hit = cache.get(name)
  if (hit && hit.mtime === mtime) return hit.value

  const value = stripComments(JSON.parse(fs.readFileSync(file, 'utf8')))
  cache.set(name, { mtime, value })
  return value
}

export const bands = () => load('bands')
export const layers = () => load('layers')
export const palettes = () => load('palettes')
export const ports = () => load('ports')

export const bandKeys = () => new Set(bands().bands.map((b) => b.key))
export const layerIds = () => new Set(layers().layers.map((l) => l.id))
export const rasterLayerIds = () => new Set(layers().rasterLayers.map((l) => l.id))
