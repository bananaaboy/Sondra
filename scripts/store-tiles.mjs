/**
 * The tile images an MSIX package needs, made from Sondra's 512 px icon.
 *
 * A package without them gets Electron's placeholder tiles, and the Store
 * shows those. Plain Node — zlib for the PNG data, an area average for the
 * scaling — because the one image library around (sharp) is a native module
 * this project replaces with an empty package.
 *
 * Only what the icon is: 8-bit RGBA, not interlaced. Anything else is refused
 * with a sentence rather than drawn wrong.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function readPng(file) {
  const data = fs.readFileSync(file)
  if (!data.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file} ist kein PNG.`)
  let offset = 8
  let width = 0
  let height = 0
  const chunks = []
  while (offset < data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const [depth, colour, , , interlace] = body.subarray(8, 13)
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(`${file}: nur 8-Bit-RGBA ohne Interlacing wird verarbeitet.`)
      }
    } else if (type === 'IDAT') chunks.push(body)
    offset += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const corner = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - corner
        const a = Math.abs(estimate - left)
        const b = Math.abs(estimate - up)
        const c = Math.abs(estimate - corner)
        value += a <= b && a <= c ? left : b <= c ? up : corner
      }
      pixels[y * stride + x] = value & 0xff
    }
  }
  return { width, height, pixels }
}

function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type, body) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, tail])
}

function writePng(file, { width, height, pixels }) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  fs.writeFileSync(file, Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

/** Area average, premultiplied, so transparent edges do not go dark. */
function scale(source, size) {
  const out = Buffer.alloc(size * size * 4)
  const ratio = source.width / size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = Math.floor(y * ratio); sy < Math.floor((y + 1) * ratio); sy += 1) {
        for (let sx = Math.floor(x * ratio); sx < Math.floor((x + 1) * ratio); sx += 1) {
          const at = (sy * source.width + sx) * 4
          const alpha = source.pixels[at + 3]
          r += source.pixels[at] * alpha
          g += source.pixels[at + 1] * alpha
          b += source.pixels[at + 2] * alpha
          a += alpha
          n += 1
        }
      }
      const at = (y * size + x) * 4
      if (a > 0) {
        out[at] = Math.round(r / a)
        out[at + 1] = Math.round(g / a)
        out[at + 2] = Math.round(b / a)
      }
      out[at + 3] = Math.round(a / n)
    }
  }
  return { width: size, height: size, pixels: out }
}

/** `image` centred on a transparent canvas of width × height. */
function centre(image, width, height) {
  const pixels = Buffer.alloc(width * height * 4)
  const left = Math.floor((width - image.width) / 2)
  const top = Math.floor((height - image.height) / 2)
  for (let y = 0; y < image.height; y += 1) {
    image.pixels.copy(pixels, ((top + y) * width + left) * 4, y * image.width * 4, (y + 1) * image.width * 4)
  }
  return { width, height, pixels }
}

/** Writes the four tiles electron-builder looks for in `<buildResources>/appx`. */
export function makeStoreTiles(icon, folder) {
  const source = readPng(icon)
  fs.mkdirSync(folder, { recursive: true })
  writePng(path.join(folder, 'StoreLogo.png'), scale(source, 50))
  writePng(path.join(folder, 'Square44x44Logo.png'), scale(source, 44))
  writePng(path.join(folder, 'Square150x150Logo.png'), centre(scale(source, 120), 150, 150))
  writePng(path.join(folder, 'Wide310x150Logo.png'), centre(scale(source, 120), 310, 150))
}
