// Wind barbs.
//
// A directional overlay drawn the meteorological way: a staff pointing to the
// compass bearing the wind blows FROM, with flags counting the speed, half barb
// 5 knots, full barb 10, pennant 50. The backend returns a coarse grid of points
// carrying a from-direction and a 5-knot bucket; this turns each bucket into a
// small barb image once, and a Mapbox symbol layer rotates the shared image per
// point. Drawing one glyph per bucket and rotating it, rather than a feature per
// barb, is what keeps hundreds of barbs cheap.
//
// Every glyph is drawn twice, a white halo under a dark stroke, so it stays legible
// over both the light and the dark basemaps without a per-basemap variant.

const SIZE = 46 // css px, the glyph box
const DPR = 2 // drawn at 2x, added with pixelRatio 2, so it is crisp when rotated
const INK = '#1e293b'
const HALO = '#ffffff'

const SRC = 'wind-barbs'
const LYR = 'wind-barbs'

function geometry (knots) {
  // Returns { segs, tris, calm } in css coordinates, staff pointing up (north).
  const cx = SIZE / 2
  const cy = SIZE / 2
  if (knots < 3) return { calm: true, segs: [], tris: [] }

  const segs = [[[cx, cy], [cx, cy - 22]]] // the staff, station at centre
  const tris = []
  let remaining = Math.round(knots / 5) * 5
  let y = cy - 22 // start at the tip
  const gap = 4.4
  const dx = -12 // flags to the upper left
  const dyFull = -6.5
  const dyHalf = -3.5

  // A lone 5-knot barb sits one step in from the tip, by convention.
  if (remaining === 5) y += gap

  while (remaining >= 50) {
    tris.push([[cx, y], [cx + dx, y + 3], [cx, y + gap * 1.3]])
    y += gap * 1.7
    remaining -= 50
  }
  while (remaining >= 10) {
    segs.push([[cx, y], [cx + dx, y + dyFull]])
    y += gap
    remaining -= 10
  }
  if (remaining >= 5) {
    segs.push([[cx, y], [cx + dx * 0.5, y + dyHalf]])
  }
  return { calm: false, segs, tris }
}

function paint (ctx, geo, stroke, width, fill) {
  ctx.strokeStyle = stroke
  ctx.fillStyle = fill
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (geo.calm) {
    ctx.beginPath()
    ctx.arc(SIZE / 2, SIZE / 2, 3.4, 0, Math.PI * 2)
    ctx.stroke()
    return
  }
  geo.segs.forEach(([a, b]) => {
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    ctx.stroke()
  })
  geo.tris.forEach((t) => {
    ctx.beginPath()
    ctx.moveTo(t[0][0], t[0][1])
    ctx.lineTo(t[1][0], t[1][1])
    ctx.lineTo(t[2][0], t[2][1])
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  })
}

function barbImageData (knots) {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE * DPR
  canvas.height = SIZE * DPR
  const ctx = canvas.getContext('2d')
  ctx.scale(DPR, DPR)
  const geo = geometry(knots)
  paint(ctx, geo, HALO, 3.6, HALO) // halo underneath
  paint(ctx, geo, INK, 1.6, INK) // ink on top
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

// One image per 5-knot bucket, 0 to 100. Idempotent: a style rebuild wipes the
// map's images, so this is safe to call again to put them back.
export function ensureBarbImages (map) {
  for (let k = 0; k <= 100; k += 5) {
    const id = `barb-${k}`
    if (!map.hasImage(id)) {
      map.addImage(id, barbImageData(k), { pixelRatio: DPR })
    }
  }
}

// Draw or update the barb layer from a GeoJSON FeatureCollection whose points
// carry `dir` (degrees the wind blows from) and `kt5` (5-knot bucket).
export function setWindBarbs (map, geojson) {
  ensureBarbImages(map)
  const src = map.getSource(SRC)
  if (src) {
    src.setData(geojson)
  } else {
    map.addSource(SRC, { type: 'geojson', data: geojson })
  }
  if (!map.getLayer(LYR)) {
    map.addLayer({
      id: LYR,
      type: 'symbol',
      source: SRC,
      layout: {
        'icon-image': ['concat', 'barb-', ['to-string', ['get', 'kt5']]],
        'icon-rotate': ['get', 'dir'],
        // Rotate with the map, not the screen, so a barb keeps pointing at its
        // true bearing when the map is rotated.
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': 0.8
      }
    })
  }
}

export function removeWindBarbs (map) {
  if (map.getLayer(LYR)) map.removeLayer(LYR)
  if (map.getSource(SRC)) map.removeSource(SRC)
}
