// Basemap selection.
//
// Mapbox GL JS resolves mapbox:// style URLs itself, so this module does almost
// nothing: it picks a style URL out of the contract and reports whether a token
// exists. An earlier version built raster tile URLs by hand to work around
// MapLibre being unable to resolve mapbox:// sources. That workaround is gone
// along with MapLibre.
//
// The token is read at runtime, never baked into the bundle at build time, for
// the same reason the API base is: this portal has to survive being served from
// a different address tomorrow without a rebuild.

import { contractsOrNull } from './contracts.js'

const runtime = (typeof window !== 'undefined' && window.__CBD_CONFIG__) || {}

/** The Mapbox token, or an empty string when none is configured. */
export const mapboxToken = () =>
  runtime.mapboxToken || import.meta.env.VITE_MAPBOX_TOKEN || ''

export const hasMapboxToken = () => Boolean(mapboxToken())

// Deliberately tolerant of being called before the contracts resolve.
const cfg = () => contractsOrNull()?.basemaps ?? null

export function availableBasemaps () {
  return cfg()?.basemaps ?? []
}

export function findBasemap (id) {
  return availableBasemaps().find((b) => b.id === id) || null
}

/** The mapbox:// style URL for a basemap id. */
export function styleUrl (basemapId) {
  const basemap = findBasemap(basemapId) ?? availableBasemaps()[0]
  return basemap?.style ?? null
}

// There was a fetchStyle() here that returned the style document so MapView
// could merge our sources into it and switch basemaps without rebuilding them.
// Mapbox refuses to diff a sprite change, so it rebuilt the style anyway and
// the merge only added a request. Removed. Reasoning kept in MapView so nobody
// tries it a second time.

/**
 * Pick a sensible basemap for a theme.
 *
 * Only used for the first render and when the user has expressed no preference.
 * Once someone chooses a basemap it is theirs, and flipping the theme does not
 * take it away from them.
 */
export function defaultBasemapId (isDark) {
  const c = cfg()
  const list = availableBasemaps()
  if (!c || !list.length) return null
  const wanted = isDark ? c.darkPreference : c.lightPreference
  return list.some((b) => b.id === wanted) ? wanted : list[0].id
}

export function projections () {
  return cfg()?.projections ?? [{ id: 'mercator', label: 'Mercator' }]
}
