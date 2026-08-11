// A fully transparent PNG, for a tile that lies outside its raster.
//
// Generated rather than pasted in as a base64 constant, and that is not
// fastidiousness. The obvious "1x1 transparent PNG" string that everyone has
// memorised is easy to get subtly wrong, and the wrong one is not obviously
// wrong: the version used here first was an opaque navy pixel, which Mapbox
// stretched over every tile outside Pakistan and painted the entire world the
// same dark blue as the bottom of the elevation ramp. It looked like a data
// extent bug, not like a constant with the wrong bytes in it.
//
// Built from zeroed RGBA, so every channel including alpha is zero by
// construction and there is nothing to mistype.

import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const crc32 = (buf) => {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * A size x size PNG with every pixel fully transparent.
 *
 * Full tile size rather than 1x1. A single pixel would scale up to the same
 * result, but a correctly sized tile means nothing downstream has to reason
 * about a raster source whose tiles are not all the same shape.
 */
export function transparentTile (size = 256) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // colour type 6, RGBA
  ihdr[10] = 0     // deflate
  ihdr[11] = 0     // adaptive filtering
  ihdr[12] = 0     // no interlace

  // One filter byte of 0 per row, then size * 4 zeroed channel bytes. Buffer
  // .alloc zeroes, so the whole image is transparent black already.
  const raw = Buffer.alloc(size * (1 + size * 4))

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// Built once at startup. It is the same bytes every time.
export const EMPTY_TILE = transparentTile(256)
