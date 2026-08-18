// Contract loader for the browser.
//
// The backend serves the same JSON files it reads itself, so the client can
// never disagree with the server about a threshold, a display range or a class
// boundary. Fetched once at startup and cached in module scope.
//
// A fallback copy lives in src/contracts/ for the case where the app renders
// before the meta call resolves. It is the same file, copied at build time.

import { getBands, getBasemaps, getLayers, getModels, getPalettes, getRadar } from './api.js'

let loaded = null

export async function loadContracts (signal) {
  if (loaded) return loaded

  const [bands, layers, palettes, models, basemaps, radar] = await Promise.all([
    getBands(signal),
    getLayers(signal),
    getPalettes(signal),
    getModels(signal),
    getBasemaps(signal),
    getRadar(signal)
  ])

  loaded = {
    bands: bands.bands,
    bandCategories: bands.categories,
    layers: layers.layers,
    rasterLayers: layers.rasterLayers,
    palettes,
    basemaps,
    cari: models.cari,
    hotspot: models.hotspot,
    susceptibility: models.susceptibility,
    radar
  }

  return loaded
}

export const contracts = () => {
  if (!loaded) {
    throw new Error('Contracts are not loaded yet. Await loadContracts() before reading them.')
  }
  return loaded
}

/** Whatever has loaded so far, or null. For code that runs before the gate. */
export const contractsOrNull = () => loaded

export const bandByKey = (key) => contracts().bands.find((b) => b.key === key)
export const layerById = (id) => contracts().layers.find((l) => l.id === id)
export const paletteByName = (name) => contracts().palettes[name]

export const rasterLayerById = (id) => contracts().rasterLayers.find((l) => l.id === id)

/**
 * The value scale a raster layer's legend draws.
 *
 * The colours and the range come from the same two contracts the gateway uses to
 * build the TiTiler colormap, so the blocks in the legend cover the same
 * intervals as the colours on the map. Reading them from anywhere else is how a
 * legend starts describing a map it no longer matches.
 */
export const rasterScale = (def) => {
  const palette = def.palette ? paletteByName(def.palette) : null
  if (!palette) return null

  // A classed palette that names explicit classes (the Hotspot Mask) draws its
  // legend as those classes, not a continuous ramp, so the blocks read High, Very
  // High and Extreme in words rather than a 0 to 100 bar that hides which colour
  // means what. The map, this legend and the identify card all read these.
  if (Array.isArray(palette.classes)) {
    return { kind: 'classes', classes: palette.classes }
  }

  if (!palette.colors) return null

  const band = def.band ? bandByKey(def.band) : null
  const min = def.min ?? band?.min
  const max = def.max ?? band?.max
  if (min == null || max == null) return null

  // Mirror the tile colormap: a transparentFirst palette renders its lowest
  // bucket see-through on the map, so the legend shows that block as transparent
  // too rather than a colour the map never draws.
  const colors = palette.transparentFirst
    ? ['transparent', ...palette.colors.slice(1)]
    : palette.colors

  return { kind: 'steps', colors, min, max, unit: band?.unit }
}

export const cariClasses = () => contracts().cari.classes
export const susceptibilityClasses = () => contracts().susceptibility.classes

// ------------------------------------------------------------------- radar
//
// The radar catalogue is a small cross product: each site carries the same three
// products. One flat layer per (site, product), because that is what the panel
// toggles and the map draws. The live frame URL is not here; it is fetched from
// the gateway, which discovers the newest scan. Everything static, the placement
// and the legend, comes from the contract.

export const radar = () => contracts().radar

export const radarLayers = () => {
  const r = contracts().radar
  return r.sites.flatMap((site) =>
    r.products.map((product) => ({
      id: `radar:${site.id}:${product.id}`,
      site: site.id,
      siteLabel: site.label,
      product: product.id,
      label: product.label,
      description: product.description,
      center: site.center,
      rangeKm: product.rangeKm,
      legend: product.legend
    }))
  )
}

/**
 * A radar layer's legend as a classed value scale, the same shape the layer
 * rows already know how to draw. Kind 'levels' so the row renders a colour ramp
 * chip beside the name and the panel lists each class with its threshold and
 * unit, matching the source legend rather than a continuous bar.
 */
export const radarScale = (layer) => {
  const legend = contracts().radar.legends[layer.legend]
  if (!legend) return null
  return { kind: 'levels', title: legend.title, unit: legend.unit, classes: legend.classes }
}

/**
 * The four map corners a radar frame is pinned to, as [lng, lat] pairs.
 *
 * The frame is a square that reaches its stated range in every direction from
 * the radar, so its half width in kilometres is the range. Kilometres convert to
 * degrees with the usual 111.32 per degree of latitude and the cosine narrowing
 * of longitude at this latitude. It is the plate-carree approximation of the
 * source's azimuthal grid, close enough that the coastline lines up; the map
 * warps the image onto these corners.
 */
export const radarBounds = (center, rangeKm) => {
  const dLat = rangeKm / 111.32
  const dLon = rangeKm / (111.32 * Math.cos((center.lat * Math.PI) / 180))
  const w = center.lon - dLon
  const e = center.lon + dLon
  const n = center.lat + dLat
  const s = center.lat - dLat
  return [[w, n], [e, n], [e, s], [w, s]]
}

/**
 * The coverage ring: the circle of the radar's range, as a GeoJSON line.
 *
 * This is the black extent circle the source draws around each site, inscribed
 * in the frame square and touching its edges. Rebuilt here so it is our own thin
 * outline rather than part of the image.
 */
export const radarRing = (center, rangeKm, points = 128) => {
  const dLat = rangeKm / 111.32
  const dLon = rangeKm / (111.32 * Math.cos((center.lat * Math.PI) / 180))
  const coords = []
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * 2 * Math.PI
    coords.push([center.lon + dLon * Math.cos(a), center.lat + dLat * Math.sin(a)])
  }
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }
}

// Group bands for the sidebar. Categories and their accent colors come from
// the contract too, so adding a band is a JSON edit rather than a component
// change.
export const bandsByCategory = () => {
  const { bands, bandCategories } = contracts()
  return bandCategories.map((category) => ({
    ...category,
    bands: bands.filter((b) => b.category === category.key && !b.internal)
  }))
}
