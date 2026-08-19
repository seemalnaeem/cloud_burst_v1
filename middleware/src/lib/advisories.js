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

// The real sentence the release writes for each region, keyed by DB province. Each
// section runs from its heading to the next heading, or to the "Possible Impacts"
// block that closes the regional forecast.
export function sectionTexts (body) {
  const marks = []
  for (const h of SECTION_HEADINGS) {
    const m = body.match(h.re)
    if (m && m.index != null) marks.push({ provinces: h.provinces, start: m.index, headEnd: m.index + m[0].length })
  }
  marks.sort((a, b) => a.start - b.start)
  const impacts = body.search(/Possible\s+Impacts/i)
  const endAll = impacts >= 0 ? impacts : body.length
  const out = {}
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : endAll
    const text = body.slice(mk.headEnd, end).replace(/^[\s:.\-]+/, '').trim()
    for (const p of mk.provinces) if (!out[p]) out[p] = text
  })
  return out
}

// The full advisory payload the gateway returns: the release meta, the matched
// districts bucketed by province with the region's real advisory text, and a code
// -> {name, province} index the client uses to decide which clicked district is
// under alert and what to show.
export function buildAdvisory ({ listHtml, detailHtml, detailUrl, id }, districts, lut) {
  const fullText = stripTags(detailHtml)
  const body = sliceBody(fullText)
  // Match on the sliced body, not the whole page, so the nav and the list of
  // other releases can never contribute a stray district.
  const matched = matchDistricts(body, districts, lut)

  const byProvince = new Map()
  const byCode = {}
  for (const d of matched) {
    if (!byProvince.has(d.province)) byProvince.set(d.province, [])
    byProvince.get(d.province).push({ code: d.code, name: d.name })
    byCode[d.code] = { name: d.name, province: d.province }
  }
  const texts = sectionTexts(body)
  const provinces = [...byProvince.entries()]
    .map(([province, ds]) => ({
      province,
      text: texts[province] || '',
      districts: ds.sort((a, b) => a.name.localeCompare(b.name))
    }))
    .sort((a, b) => a.province.localeCompare(b.province))

  const { title, date } = releaseFromList(listHtml, id)
  return {
    release: { id, url: detailUrl, title, date, body },
    provinces,
    byCode
  }
}
