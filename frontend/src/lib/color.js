// Data color helpers.
//
// These resolve a value to a color using the shared palettes. Nothing here
// touches theme tokens: a Very High risk district is #d7191c in light and dark
// alike, because the color describes the data rather than the chrome.

import { cariClasses, paletteByName, susceptibilityClasses } from './contracts.js'
import { isMissing } from './format.js'

const NO_DATA = 'rgba(148, 163, 184, 0.35)'

/** CARI percentage to its class. Seven classes. */
export function cariClass (percent) {
  if (isMissing(percent)) return null
  const classes = cariClasses()
  return classes.find((c) => percent <= c.max) ?? classes[classes.length - 1]
}

export const cariColor = (percent) => cariClass(percent)?.color ?? NO_DATA

/**
 * Susceptibility score to its class. Five classes.
 *
 * Deliberately separate from the CARI classes even though several hex values
 * match. #fdae61 is High here and Moderately High there.
 */
export function susceptibilityClass (score) {
  if (isMissing(score)) return null
  const classes = susceptibilityClasses()
  return classes.find((c) => score >= c.min && score <= c.max) ?? classes[classes.length - 1]
}

export const susceptibilityColor = (score) => susceptibilityClass(score)?.color ?? NO_DATA

/** Sample a continuous palette at a position between min and max. */
export function rampColor (value, min, max, paletteName = 'continuous') {
  if (isMissing(value)) return NO_DATA

  const palette = paletteByName(paletteName)
  if (!palette?.colors?.length) return NO_DATA

  const clamped = Math.min(Math.max(value, min), max)
  const t = max === min ? 0 : (clamped - min) / (max - min)
  const index = Math.min(palette.colors.length - 1, Math.floor(t * palette.colors.length))
  return palette.colors[index]
}

/** Categorical lookup, for precipitation type. */
export function categoryColor (code, paletteName) {
  const palette = paletteByName(paletteName)
  if (palette?.kind !== 'categorical') return NO_DATA
  return palette.entries.find((e) => e.code === code)?.color ?? palette.fallback
}

/** Binned lookup, for the radar legends. Bins are upper bounds, descending. */
export function binColor (value, paletteName) {
  if (isMissing(value)) return NO_DATA
  const palette = paletteByName(paletteName)
  if (palette?.kind !== 'binned') return NO_DATA

  const sorted = [...palette.bins].sort((a, b) => a.max - b.max)
  return sorted.find((b) => value <= b.max)?.color ?? sorted[sorted.length - 1].color
}

/** CSS gradient string for a legend bar. */
/**
 * The colours of a palette, in order, for rendering a scale as discrete blocks.
 *
 * There is deliberately no gradient helper here. No gradients anywhere is a
 * project rule, so a continuous palette is drawn as a row of touching solid
 * blocks instead. That is also the more honest rendering: these palettes are
 * defined as a fixed list of stops, and a CSS gradient invents the colours in
 * between, implying a smoothness the data does not have.
 */
export function paletteColors (paletteName) {
  return paletteByName(paletteName)?.colors ?? []
}

/**
 * Evenly spaced legend ticks.
 *
 * Count matches the palette stop count so a tick lines up with each color
 * boundary rather than floating between them.
 */
export function legendTicks (min, max, count = 8, decimals = 0) {
  const step = (max - min) / (count - 1)
  return Array.from({ length: count }, (_, i) => Number((min + i * step).toFixed(decimals)))
}

/**
 * Readable text color over an arbitrary background.
 *
 * Relative luminance rather than a simple average, because the eye is far more
 * sensitive to green than to blue and averaging picks the wrong text color on
 * yellows.
 */
export function contrastText (hex) {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return luminance > 0.55 ? '#14181d' : '#ffffff'
}

export { NO_DATA }
