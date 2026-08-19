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

const stripTags = (html) =>
  html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

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

// The full advisory payload the gateway returns: the release meta, the matched
// districts bucketed by province, and a code -> {name, province} index the client
// uses to decide which clicked district is under alert and what to show.
export function buildAdvisory ({ listHtml, detailHtml, detailUrl, id }, districts, lut) {
  const matched = matchDistricts(stripTags(detailHtml), districts, lut)

  const byProvince = new Map()
  const byCode = {}
  for (const d of matched) {
    if (!byProvince.has(d.province)) byProvince.set(d.province, [])
    byProvince.get(d.province).push({ code: d.code, name: d.name })
    byCode[d.code] = { name: d.name, province: d.province }
  }
  const provinces = [...byProvince.entries()]
    .map(([province, ds]) => ({ province, districts: ds.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.province.localeCompare(b.province))

  const { title, date } = releaseFromList(listHtml, id)
  return {
    release: { id, url: detailUrl, title, date },
    provinces,
    byCode
  }
}
