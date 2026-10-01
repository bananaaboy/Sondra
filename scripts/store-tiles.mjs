/**
 * The tile images an MSIX package needs, made from Sondra's 512 px icon.
 *
 * A package without them gets Electron's placeholder tiles, and the Store
 * shows those.
 *
 * Two kinds. The plated ones (Start tiles, the list icon on Windows 10) are
 * drawn full-bleed: the mark in white on Sondra's green, every pixel opaque.
 * The icon itself has transparent rounded corners, and on a plate Windows
 * fills those with the user's accent colour — on one machine that was a red
 * rim round a green square. The unplated ones (taskbar, Start on Windows 11)
 * are the icon as it is, rounded, because nothing is drawn behind them.
 *
 * Plain Node — zlib for the PNG data, an area average for the
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

/** Sondra's green: `ink` in the light theme. */
const INK = [0x0f, 0x3e, 0x1c]

/** The five bars of the mark, in its 32-unit viewBox: x, y, width; all 3.3 high. */
const BARS = [
  [9, 5.35, 13.99],
  [7.73, 9.85, 20.95],
  [4.6, 14.35, 22.8],
  [3.33, 18.85, 20.95],
  [9, 23.35, 13.99],
]

/**
 * The mark in white on full-bleed green, `share` of the shorter side high,
 * centred. Each bar is a capsule; coverage is sampled 4 × 4 per pixel.
 */
function drawMark(width, height, share) {
  const pixels = Buffer.alloc(width * height * 4)
  const unit = (Math.min(width, height) * share) / 32
  const left = (width - 32 * unit) / 2
  const top = (height - 32 * unit) / 2
  const radius = 1.65
  const inside = (u, v) =>
    BARS.some(([x, y, w]) => {
      const cx = Math.max(x + radius, Math.min(x + w - radius, u))
      return (u - cx) ** 2 + (v - (y + radius)) ** 2 <= radius * radius
    })
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      let hits = 0
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          if (inside((px + (sx + 0.5) / 4 - left) / unit, (py + (sy + 0.5) / 4 - top) / unit)) hits += 1
        }
      }
      const cover = hits / 16
      const at = (py * width + px) * 4
      for (let c = 0; c < 3; c += 1) pixels[at + c] = Math.round(INK[c] + (255 - INK[c]) * cover)
      pixels[at + 3] = 255
    }
  }
  return { width, height, pixels }
}

/** The sizes Windows asks for in the taskbar, Start and Explorer. */
const TARGET_SIZES = [16, 24, 32, 44, 48, 256]

/** Writes the tiles electron-builder looks for in `<buildResources>/appx`. */
export function makeStoreTiles(icon, folder) {
  const source = readPng(icon)
  fs.rmSync(folder, { recursive: true, force: true })
  fs.mkdirSync(folder, { recursive: true })
  writePng(path.join(folder, 'StoreLogo.png'), drawMark(50, 50, 0.7))
  writePng(path.join(folder, 'Square44x44Logo.png'), drawMark(44, 44, 0.72))
  writePng(path.join(folder, 'Square150x150Logo.png'), drawMark(150, 150, 0.5))
  writePng(path.join(folder, 'Wide310x150Logo.png'), drawMark(310, 150, 0.5))
  // Qualified variants make electron-builder index them in resources.pri.
  for (const size of TARGET_SIZES) {
    writePng(path.join(folder, `Square44x44Logo.targetsize-${size}.png`), drawMark(size, size, 0.72))
    const unplated = scale(source, size)
    writePng(path.join(folder, `Square44x44Logo.targetsize-${size}_altform-unplated.png`), unplated)
    writePng(path.join(folder, `Square44x44Logo.targetsize-${size}_altform-lightunplated.png`), unplated)
  }
}
