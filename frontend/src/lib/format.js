// Formatting helpers.
//
// Every one of these handles null, because a missing forecast value is normal
// rather than exceptional. Returning "NaN" or "null" in a stat card is the
// most common way this kind of portal looks broken when it is working fine.

const PLACEHOLDER = '–' // en dash, used only as a visual placeholder

export const isMissing = (value) =>
  value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))

const SUPERSCRIPT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' }

/**
 * A unit string with its exponents raised.
 *
 * Digits in a unit are always powers here (kg/m2, m/s2), so "kg/m2" should read
 * "kg/m²" not "kg/m2". Every place that prints a unit runs it through this so the
 * chart, the legends and the identify card all agree.
 */
export function fmtUnit (unit) {
  if (!unit) return ''
  return String(unit).replace(/\d/g, (d) => SUPERSCRIPT[d])
}

export function fmtNumber (value, decimals = 1) {
  if (isMissing(value)) return PLACEHOLDER
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

export function fmtValue (value, unit, decimals = 1) {
  if (isMissing(value)) return PLACEHOLDER
  return `${fmtNumber(value, decimals)}${unit ? ` ${fmtUnit(unit)}` : ''}`
}

export function fmtPercent (value, decimals = 1) {
  if (isMissing(value)) return PLACEHOLDER
  return `${fmtNumber(value, decimals)}%`
}

/**
 * Forecast lead as something a person reads.
 *
 * Negative leads are history. Saying "24 h ago" rather than "-24 h" removes a
 * moment of confusion every single time.
 */
export function fmtLead (hours) {
  if (isMissing(hours)) return PLACEHOLDER
  if (hours === 0) return 'Now'
  if (hours < 0) {
    const past = Math.abs(hours)
    return past >= 24 ? `${Math.round(past / 24)} d ago` : `${past} h ago`
  }
  if (hours < 24) return `+${hours} h`
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `+${days} d` : `+${days} d ${rest} h`
}

export function fmtDate (value, { withTime = true } = {}) {
  if (isMissing(value)) return PLACEHOLDER
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return PLACEHOLDER

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
  })
}

/**
 * Forecast cycle label.
 *
 * Cycles are identified by their initialization time and there are four a day,
 * so the hour matters as much as the date.
 */
export function fmtCycle (value) {
  if (isMissing(value)) return PLACEHOLDER
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return PLACEHOLDER
  const hour = String(date.getUTCHours()).padStart(2, '0')
  return `${date.toISOString().slice(0, 10)} ${hour}Z`
}

export const fmtCoord = (value, decimals = 4) =>
  isMissing(value) ? PLACEHOLDER : Number(value).toFixed(decimals)

export const fmtCount = (value) =>
  isMissing(value) ? PLACEHOLDER : Number(value).toLocaleString()

export const truncate = (text, max = 40) =>
  !text ? '' : text.length <= max ? text : `${text.slice(0, max - 1)}…`
