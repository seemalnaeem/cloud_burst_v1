// PMD press-release parsing for the High-Alert Districts feature.
//
// The source is a list page of RAIN-WIND press releases linking to detail pages;
// each detail body names the at-risk districts in free text, grouped by region,
// with the region layout varying between releases. So rather than parse PMD's
// headings, we take the newest release, match every canonical district name (and
// a small set of source-spelling aliases) that appears anywhere in its body, and
// bucket the matches by the district's own province. Unmatched or ambiguous names
// are dropped, never guessed. Names and aliases come from the shared contracts
// districts.json and alert-lut.json, so the science is not hard-coded here.

// Lower case, punctuation to single spaces, collapsed. "D.I Khan" -> "d i khan",
// so the text and the patterns compare on the same footing.
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()

// Named entities the releases actually use. Dashes decode to a hyphen, not an
// em/en dash, to keep the source text within the no-em-dash rule.
const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&apos;': "'",
  '&ldquo;': '"', '&rdquo;': '"', '&lsquo;': "'", '&rsquo;': "'",
  '&hellip;': '...', '&deg;': '°', '&ndash;': '-', '&mdash;': '-'
}

const stripTags = (html) => {
  let t = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  for (const [k, v] of Object.entries(ENTITIES)) t = t.split(k).join(v)
  return t.replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()
}

// The advisory prose itself, from already-stripped page text. It starts after
// the category tabs (which end in REBUTTAL) and ends where the source's sign-off
// or the "Archive Press Releases" list begins. If the start marker is missing the
// whole text is returned rather than nothing, so a layout change never blanks it.
export function sliceBody (fullText) {
  let t = fullText
  const start = t.lastIndexOf('REBUTTAL')
  if (start !== -1) t = t.slice(start + 'REBUTTAL'.length)
  for (const marker of ['For daily weather updates', 'Archive Press Releases']) {
    const i = t.indexOf(marker)
    if (i !== -1) t = t.slice(0, i)
  }
  return t.trim()
}

// The releases are listed newest first and their ids grow with time, so the
// largest RAIN-WIND id is the current advisory.
export function newestReleaseId (listHtml) {
  const ids = [...listHtml.matchAll(/all-press-releases\/(\d+)\?type=RAIN-WIND/gi)].map((m) => Number(m[1]))
  return ids.length ? Math.max(...ids) : null
}

// Title and date for a release, from its card on the list page. The card's text
// is the title followed by a "DD Mon, YYYY" stamp; split the stamp off the end.
export function releaseFromList (listHtml, id) {
  const re = new RegExp(`<a[^>]*all-press-releases/${id}\\?type=[^"']*["'][^>]*>([\\s\\S]*?)</a>`, 'i')
  const inner = stripTags(listHtml.match(re)?.[1] ?? '')
  const date = inner.match(/\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}/)?.[0] ?? null
  const title = (date ? inner.replace(date, '') : inner).replace(/\s+/g, ' ').trim()
  return { title: title || null, date }
}

// Every district named in the body, canonical names first then aliases. Returns
// the district records (code, name, province), de-duplicated by code.
export function matchDistricts (bodyText, districts, lut) {
  const hay = ` ${norm(bodyText)} `
  const byName = new Map(districts.map((d) => [norm(d.name), d]))
  const stop = new Set((lut.stoplist ?? []).map(norm))
  const found = new Map()

  for (const d of districts) {
    const p = norm(d.name)
    if (!stop.has(p) && hay.includes(` ${p} `)) found.set(d.code, d)
  }
  for (const [alias, targets] of Object.entries(lut.aliases ?? {})) {
    const p = norm(alias)
    if (stop.has(p) || !hay.includes(` ${p} `)) continue
    for (const name of targets) {
      const d = byName.get(norm(name))
      if (d) found.set(d.code, d)
    }
  }
  return [...found.values()]
}

// The source groups its forecast by region; these headings map each region to the
// DB provinces it covers, so the real sentence the release writes for a region can
// be attached to those provinces. Absent headings (some releases run the regions
// inline) just leave a province without text; the districts still stand on their
// own.
const SECTION_HEADINGS = [
  { re: /Kashmir\s*:/i, provinces: ['Azad Kashmir'] },
  { re: /(?:Upper\s+)?Khyber[-\s]?Pakhtunkhwa\s*:/i, provinces: ['Khyber Pakhtunkhwa'] },
  { re: /Islamabad(?:\s*\/\s*Upper\s+Punjab)?\s*:/i, provinces: ['Islamabad', 'Punjab'] },
  { re: /Gilgit[-\s]?Baltistan\s*:/i, provinces: ['Gilgit Baltistan'] },
  { re: /Sindh\s*&\s*Balochistan\s*:/i, provinces: ['Sindh', 'Balochistan'] }
]

// The region slices in document order: each heading's forecast text and the DB
// provinces it covers. Both the per-province prose and the per-region place lists
// derive from these, so the two can never disagree about where a region ends.
export function sectionSlices (body) {
  const marks = []
  for (const h of SECTION_HEADINGS) {
    const m = body.match(h.re)
    if (m && m.index != null) marks.push({ provinces: h.provinces, start: m.index, headEnd: m.index + m[0].length })
  }
  marks.sort((a, b) => a.start - b.start)
  const impacts = body.search(/Possible\s+Impacts/i)
  const endAll = impacts >= 0 ? impacts : body.length
  return marks.map((mk, i) => ({
    provinces: mk.provinces,
    text: body.slice(mk.headEnd, i + 1 < marks.length ? marks[i + 1].start : endAll).replace(/^[\s:.\-]+/, '').trim()
  }))
}

// The real sentence the release writes for each region, keyed by DB province.
export function sectionTexts (body) {
  const out = {}
  for (const s of sectionSlices(body)) for (const p of s.provinces) if (!out[p]) out[p] = s.text
  return out
}

// Fragments that are date, weather or boilerplate rather than a place, so an
// overshoot in the capture never adds a fake entry to the count. Matched only as
// whole words: a bare substring rule would eat real districts (Mardan and Lakki
// Marwat both contain "mar", the March abbreviation).
const NOT_A_PLACE = /\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|night|evening|morning|weekend|gaps?|isolated|heavyfalls?|thundershowers?|thunderstorms?|rain|wind|weather|expected|during|period)\b/i

// The place names a region sentence lists, verbatim and in document order. PMD
// writes "... expected in (A, B, C) from <date>" and sometimes a second "while in
// D, E on <date>"; take every comma or "and" separated name inside those "in ..."
// clauses, up to the date or gap wording that closes each list. This is the count
// the panel shows, so it mirrors exactly what PMD names, no more and no fewer.
export function extractNames (sectionText) {
  const out = []
  const seen = new Set()
  const re = /(?:expected in|while in)\s*\(?\s*([\s\S]*?)(?=\)|\bfrom\b|\bon\b|\bduring\b|\bwith\s+occasional\b|$)/gi
  for (const m of sectionText.matchAll(re)) {
    for (const raw of m[1].split(/\s*,\s*|\s+and\s+/i)) {
      const name = raw.replace(/[()]/g, '').replace(/\s+/g, ' ').trim()
      if (name.length < 2 || NOT_A_PLACE.test(name)) continue
      const k = name.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push(name)
    }
  }
  return out
}

// The DB district a PMD place name flags on the map, or null when it is a region
// umbrella (Dir, Kohistan) or a locality that is not a district (Murree): those
// are still listed and counted, they just do not light a polygon. Canonical match
// first, then the alias table (spellings, abbreviations, a town to its parent).
function resolveName (name, byName, aliases, stop) {
  const p = norm(name)
  if (stop.has(p)) return null
  const direct = byName.get(p)
  if (direct) return direct
  const targets = aliases[p]
  if (targets && targets.length) return byName.get(norm(targets[0])) || null
  return null
}

// The full advisory payload the gateway returns. Each province carries the places
// PMD named for its region, verbatim and in order, so the count matches the press
// release exactly; each entry keeps the DB district `code` it resolves to (or null
// for an umbrella or non-district name) for the map overlay, and byCode indexes the
// resolved codes so a clicked flashing district knows what to show.
export function buildAdvisory ({ listHtml, detailHtml, detailUrl, id }, districts, lut) {
  const fullText = stripTags(detailHtml)
  const body = sliceBody(fullText)

  const byName = new Map(districts.map((d) => [norm(d.name), d]))
  const aliases = lut.aliases ?? {}
  const stop = new Set((lut.stoplist ?? []).map(norm))

  const byProvince = new Map()
  const byCode = {}
  for (const s of sectionSlices(body)) {
    // Names that do not resolve fall to the region's broader province (the last in
    // its list): Islamabad/Upper Punjab -> Punjab, Sindh & Balochistan -> Balochistan.
    const fallback = s.provinces[s.provinces.length - 1]
    for (const name of extractNames(s.text)) {
      const d = resolveName(name, byName, aliases, stop)
      const province = d && s.provinces.includes(d.province) ? d.province : fallback
      if (!byProvince.has(province)) byProvince.set(province, [])
      byProvince.get(province).push({ name, code: d ? d.code : null })
      if (d) byCode[d.code] = { name: d.name, province: d.province }
    }
  }

  const texts = sectionTexts(body)
  const provinces = [...byProvince.entries()]
    .map(([province, list]) => ({ province, text: texts[province] || '', districts: list }))
    .sort((a, b) => a.province.localeCompare(b.province))

  const { title, date } = releaseFromList(listHtml, id)
  return {
    release: { id, url: detailUrl, title, date, body },
    provinces,
    byCode
  }
}
