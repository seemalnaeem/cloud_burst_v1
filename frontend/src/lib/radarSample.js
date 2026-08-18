// Reading a radar pixel on the client.
//
// The radar frame is a discrete, classified image: every pixel is one of the
// palette colours, so identifying a point means reading its colour and matching
// it to a legend band. The value is therefore a band (a range), never an exact
// number, which is a property of the product, not of this code.
//
// The frame is already georeferenced to four corners, so a lng/lat maps to a
// pixel by simple proportion. The image is proxied through our own gateway with
// CORS, so it draws to a canvas without tainting it and its pixels can be read.

const imageCache = new Map() // url -> Promise<{ data, width, height }>

function loadImageData (url) {
  if (imageCache.has(url)) return imageCache.get(url)
  const promise = new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0)
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
        resolve({ data, width: canvas.width, height: canvas.height })
      } catch (err) {
        reject(err)
      }
    }
    img.onerror = () => reject(new Error('radar image load failed'))
    img.src = url
  })
  imageCache.set(url, promise)
  return promise
}

// The RGBA under a lng/lat, or null when the point is outside the frame. Corners
// are [[w,n],[e,n],[e,s],[w,s]], the same array the image source is pinned to.
export async function sampleRadarPixel (url, coordinates, lng, lat) {
  const w = coordinates[0][0]
  const e = coordinates[1][0]
  const n = coordinates[0][1]
  const s = coordinates[2][1]
  if (lng < w || lng > e || lat > n || lat < s) return null

  const { data, width, height } = await loadImageData(url)
  const px = Math.min(width - 1, Math.max(0, Math.floor(((lng - w) / (e - w)) * width)))
  const py = Math.min(height - 1, Math.max(0, Math.floor(((n - lat) / (n - s)) * height)))
  const i = (py * width + px) * 4
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] }
}

function hexToRgb (hex) {
  const h = hex.replace('#', '')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

// The legend class index a pixel falls in, or null for no echo (transparent, or
// a colour too far from every band to be one, such as a coastline drawn over the
// data). Nearest colour in RGB, which is exact here because the product is a
// fixed palette, not a smooth ramp.
export function matchRadarBand (pixel, classes) {
  if (!pixel || pixel.a < 40) return null
  let best = null
  let bestDist = Infinity
  for (let i = 0; i < classes.length; i++) {
    const { r, g, b } = hexToRgb(classes[i].color)
    const dist = (r - pixel.r) ** 2 + (g - pixel.g) ** 2 + (b - pixel.b) ** 2
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  // A generous cutoff: palette colours differ from each other by far more than
  // this, so it only rejects clearly non-palette pixels (map ink, labels).
  return bestDist <= 3600 ? best : null
}

// The band's value range as text: its own threshold up to the next higher one,
// open-ended at the top. classes are high to low, so the next higher is i - 1.
export function radarBandRange (classes, index) {
  const lower = classes[index].value
  const upper = classes[index - 1]?.value
  return index === 0 ? `≥ ${lower}` : `${lower}–${upper}`
}
