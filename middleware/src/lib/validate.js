// Parameter validation at the edge.
//
// Catching a bad tile coordinate here saves a database round trip and stops a
// nonsense zoom from turning into real CPU work.

import { AppError } from './errors.js'
import { bandKeys, layerIds, rasterLayerIds } from './contracts.js'

export function tileCoords (z, x, y) {
  const zi = Number.parseInt(z, 10)
  const xi = Number.parseInt(x, 10)
  const yi = Number.parseInt(y, 10)

  if (!Number.isInteger(zi) || zi < 0 || zi > 18) {
    throw new AppError('VALIDATION_FAILED', `Zoom ${z} is outside 0 to 18.`)
  }

  // At zoom z the grid is 2^z by 2^z. Out of range coordinates would otherwise
  // produce an empty tile after doing all the work to find that out.
  const max = 2 ** zi
  if (!Number.isInteger(xi) || xi < 0 || xi >= max) {
    throw new AppError('VALIDATION_FAILED', `Tile x ${x} is outside 0 to ${max - 1} at zoom ${zi}.`)
  }
  if (!Number.isInteger(yi) || yi < 0 || yi >= max) {
    throw new AppError('VALIDATION_FAILED', `Tile y ${y} is outside 0 to ${max - 1} at zoom ${zi}.`)
  }

  return { z: zi, x: xi, y: yi }
}

export function vectorLayer (id) {
  if (!layerIds().has(id)) {
    throw new AppError('VALIDATION_FAILED', `Unknown layer ${id}. See /api/meta/layers.`)
  }
  return id
}

export function rasterLayer (id) {
  if (!rasterLayerIds().has(id)) {
    throw new AppError('VALIDATION_FAILED', `Unknown raster layer ${id}. See /api/meta/layers.`)
  }
  return id
}

export function bandKey (key) {
  if (!bandKeys().has(key)) {
    throw new AppError('VALIDATION_FAILED', `Unknown band ${key}. See /api/meta/bands.`)
  }
  return key
}

export function leadHours (value, { min = -168, max = 360 } = {}) {
  const n = Number.parseInt(value ?? '0', 10)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError('VALIDATION_FAILED', `forecast_hours must be an integer between ${min} and ${max}.`)
  }
  return n
}

/**
 * Guard a caller supplied path before it reaches an upstream fetch.
 *
 * Without this a proxy route is an open relay and an SSRF vector into the
 * Docker network, where it can reach the database. The old radar proxy did
 * exactly this check and it was right to.
 */
export function upstreamPath (value, allowedPrefix) {
  const p = String(value ?? '')
  if (!p || !p.startsWith(allowedPrefix) || p.includes('..') || p.includes('\\')) {
    throw new AppError('VALIDATION_FAILED', `Path must start with ${allowedPrefix} and contain no traversal.`)
  }
  return p
}
