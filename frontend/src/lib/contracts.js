// Contract loader for the browser.
//
// The backend serves the same JSON files it reads itself, so the client can
// never disagree with the server about a threshold, a display range or a class
// boundary. Fetched once at startup and cached in module scope.
//
// A fallback copy lives in src/contracts/ for the case where the app renders
// before the meta call resolves. It is the same file, copied at build time.

import { getBands, getBasemaps, getLayers, getModels, getPalettes } from './api.js'

let loaded = null

export async function loadContracts (signal) {
  if (loaded) return loaded

  const [bands, layers, palettes, models, basemaps] = await Promise.all([
    getBands(signal),
    getLayers(signal),
    getPalettes(signal),
    getModels(signal),
    getBasemaps(signal)
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
    susceptibility: models.susceptibility
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
