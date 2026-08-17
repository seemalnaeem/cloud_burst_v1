// API client.
//
// This module is the reason the portal survives a DHCP address change. The base
// URL is computed in the browser at page load from the address the page was
// served on, not substituted at build time. Load the page from a new address
// tomorrow and every request follows it, with no rebuild and no config edit.
//
// Never call fetch directly in a component. Everything goes through here so the
// host resolution, the request id, the error envelope handling and abort
// support exist in one place.

const runtime = (typeof window !== 'undefined' && window.__CBD_CONFIG__) || {}

const resolveBase = () => {
  // Explicit override wins. Only used when the gateway lives somewhere other
  // than the host that served this page.
  if (runtime.apiBase) return runtime.apiBase
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE

  const port = runtime.gatewayPort || import.meta.env.VITE_GATEWAY_PORT || '3090'
  const { protocol, hostname } = window.location
  return `${protocol}//${hostname}:${port}`
}

export const API_BASE = resolveBase()

export class ApiError extends Error {
  constructor (code, message, status, detail) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

const buildUrl = (path, params) => {
  const url = new URL(path.startsWith('http') ? path : `${API_BASE}${path}`)
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  })
  return url.toString()
}

async function request (path, params, options = {}) {
  const url = buildUrl(path, params)

  let response
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    // A network level failure here usually means the gateway is not reachable,
    // which on a fresh machine is a firewall rather than a bug.
    throw new ApiError(
      'NETWORK',
      `Could not reach the gateway at ${API_BASE}. Check that the stack is running and the port is open.`,
      0
    )
  }

  if (response.status === 204) return null

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('json') ? await response.json() : null

  if (!response.ok) {
    const envelope = payload?.error
    throw new ApiError(
      envelope?.code || 'INTERNAL',
      envelope?.message || `Request failed with ${response.status}`,
      response.status,
      envelope?.detail
    )
  }

  return payload
}

export const api = {
  get: (path, params, options) => request(path, params, options),
  post: (path, body, options) => request(path, null, { ...options, method: 'POST', body })
}

// Named calls. Components use these, not raw paths, so a route change is a one
// line edit here rather than a search across the codebase.

export const getBands = (signal) => api.get('/api/meta/bands', null, { signal })
export const getLayers = (signal) => api.get('/api/meta/layers', null, { signal })
export const getLayerExtent = (layerId, signal) =>
  api.get('/api/meta/layer-extent', { layer: layerId }, { signal })
export const getBasemaps = (signal) => api.get('/api/meta/basemaps', null, { signal })
export const getPalettes = (signal) => api.get('/api/meta/palettes', null, { signal })
export const getModels = (signal) => api.get('/api/meta/models', null, { signal })
export const getForecastMeta = (model, signal) =>
  api.get('/api/meta/forecast', model ? { model } : null, { signal })

export const getDistricts = (province, signal) =>
  api.get('/api/districts', { province }, { signal })
export const getDistrict = (name, signal) =>
  api.get(`/api/districts/${encodeURIComponent(name)}`, null, { signal })
export const suggestDistricts = (q, signal) =>
  api.get('/api/districts/suggest', { q }, { signal })

export const getCari = (district, forecastHours, matrix, signal) =>
  api.get('/api/score/cari', { district, forecast_hours: forecastHours, matrix }, { signal })
export const getCariTehsil = (tehsilCode, forecastHours, matrix, signal) =>
  api.get('/api/score/cari/tehsil', { tehsil_code: tehsilCode, forecast_hours: forecastHours, matrix }, { signal })
export const getCariAll = (forecastHours, matrix, signal) =>
  api.get('/api/score/cari/all', { forecast_hours: forecastHours, matrix }, { signal })
// The CARI class per feature for a whole layer, for the Analysis choropleth.
// Returns status "ready" with features, or "computing" while a background pass
// runs; the caller polls until ready. kind is "district" or "tehsil".
export const getCariChoropleth = (kind, forecastHours, signal) =>
  api.get('/api/score/cari/choropleth', { kind, forecast_hours: forecastHours }, { signal })
export const getSusceptibility = (forecastHours, signal) =>
  api.get('/api/score/susceptibility', { forecast_hours: forecastHours }, { signal })
export const getPrioritized = (top, signal) =>
  api.get('/api/score/susceptibility/prioritized', { top }, { signal })
// Which raster bands can actually resolve to a tile right now. Drives the
// enabled state of the raster rows in the layers panel, so an uningested source
// reads as pending rather than as a toggle that does nothing.
export const getRasterCatalog = (signal) => api.get('/api/raster/catalog', null, { signal })
// A coarse wind-vector grid for the barb overlay: points with a from-direction
// and a 5-knot bucket, sampled from the model's u/v at 850 for a cycle and lead.
export const getWindField = (model, creationTime, leadHours, signal) =>
  api.get('/api/raster/windfield', { model, creation_time: creationTime, lead: leadHours }, { signal })
// The value of one raster layer at a coordinate, for the identify tool.
export const getRasterPoint = (layer, { model, creationTime, leadHours, lon, lat } = {}, signal) =>
  api.get('/api/raster/point', { layer, model, creation_time: creationTime, lead: leadHours, lon, lat }, { signal })

// One historic event, with its physical values, the district it fell in and a
// photo manifest. The map draws the point from tiles; this backs the detail card.
export const getEvent = (id, signal) =>
  api.get(`/api/events/${encodeURIComponent(id)}`, null, { signal })
// The URL of one event image, by sequence. A plain URL, not a fetch, so it can go
// straight into an <img src>; it moves with the host like every other request.
export const eventPhotoUrl = (id, seq) =>
  `${API_BASE}/api/events/${encodeURIComponent(id)}/photos/${seq}`
// The events as a GeoJSON FeatureCollection, for a Mapbox geojson source. Points
// are served this way rather than as vector tiles, by exception: the set is tiny
// and a geojson source draws every marker at every zoom with no tiling. Each
// feature carries its own id, so feature-state still works.
export const eventsGeoJsonUrl = () => `${API_BASE}/api/events/geojson`

// One temporal layer reduced over a region boundary at every published lead, for
// the forecast chart. kind is district | tehsil | iiojk; key is the matching join
// value; reducer is how the raster collapses over the polygon (mean, max, ...).
export const getForecastTimeseries = (layer, kind, key, reducer, signal) =>
  api.get('/api/raster/timeseries', { layer, kind, key, reducer }, { signal })

// Prepare a computed raster (the per pixel CAR Index, the hotspot mask) for a
// lead. These are graded on every forecast cell, too slow to do inside a tile, so
// the API generates them on demand and this returns "ready" once the COG exists
// or "computing" while a background pass builds it. The returned creationTime and
// leadHours are what the tiles must resolve against: the lead is snapped to what
// the WRFPRS grid publishes, so the caller points the layer at the snapped value.
export const getComputeStatus = (layer, forecastHours, signal) =>
  api.get('/api/raster/compute', { layer, forecast_hours: forecastHours }, { signal })

export const getAlerts = (signal) => api.get('/api/alerts', null, { signal })
export const getUpstreamStatus = (signal) => api.get('/api/upstream/status', null, { signal })

// Tile URL templates. Relative to the resolved base, so they move with the
// host exactly like every other request.
export const vectorTileUrl = (layerId) => `${API_BASE}/tiles/${layerId}/{z}/{x}/{y}.pbf`

export const rasterTileUrl = (layerId, { band, model, creationTime, leadHours, style } = {}) => {
  const params = new URLSearchParams()
  if (band) params.set('band', band)
  // The model selects which forecast run backs a temporal layer, since the same
  // band exists under several models. Absent for static and computed layers.
  if (model) params.set('model', model)
  if (creationTime) params.set('creation_time', creationTime)
  if (leadHours !== undefined && leadHours !== null) params.set('lead', String(leadHours))
  // A cache discriminator, not read by the server: a raster tile's colours are
  // decided server side from the band's palette, and tiles are cached for hours
  // under this URL. Folding the palette in means changing it (this layer moving
  // from the full ramp to the top three classes) yields a new URL, so the browser
  // cannot keep serving the old, differently coloured tiles.
  if (style) params.set('style', style)
  const query = params.toString()
  return `${API_BASE}/raster/${layerId}/{z}/{x}/{y}.png${query ? `?${query}` : ''}`
}
