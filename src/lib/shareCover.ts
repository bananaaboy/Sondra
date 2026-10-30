/**
 * Pictures for a shared list: each cover as a small picture of its own that
 * travels inside the link or the file — nothing is fetched from anywhere when
 * the list is opened. The part of the cover a tile shows (`CoverFrame`) is what
 * is kept, at the tile's shape.
 *
 * Three sizes, because a link has only so much room:
 *  - `winzig`: six by nine pixels, brightness and colour packed into 33
 *    bytes; drawn larger and smooth it is a blur of the poster's colours.
 *  - `klein`: 40 × 60 as WebP (JPEG where the browser cannot write it).
 *  - `gross`: 96 × 144 the same way.
 *
 * What comes out of a link is believed only as far as it is a picture of a
 * known kind and of limited size; it is shown through an `<img>`, which cannot
 * run anything.
 */

import { halve, pictureSize, type CoverFrame, type Picture, type SavedLinkItem, type TileFormat } from './merkliste'

export type CoverTier = 'winzig' | 'klein' | 'gross'

export const COVER_TIERS: { id: CoverTier; label: string; note: string }[] = [
  { id: 'winzig', label: 'Winzig', note: 'Farben und Umrisse' },
  { id: 'klein', label: 'Klein', note: '40 × 60' },
  { id: 'gross', label: 'Gross', note: '96 × 144' },
]

/** First byte of a stored picture. */
const KIND = { raw: 0, webp: 1, jpeg: 2 } as const

/** What one picture may weigh, kind byte included: more is not a thumbnail. */
export const THUMB_MAX = 24 * 1024

/** Height over width of a tile. */
const ASPECT: Record<TileFormat, number> = { poster: 1.5, manga: 1.4 }

const RAW_W = 6
const RAW_H = 9
/** Colour is kept for squares of 3 × 3 pixels: the eye takes brightness from the detail and colour from the blur. */
const CELL = 3
const CELLS = (RAW_W / CELL) * (RAW_H / CELL)
const RAW_BYTES = 1 + Math.ceil((RAW_W * RAW_H * 4 + CELLS * 2 * 4) / 8)

const SIZED = {
  klein: { width: 40, quality: 0.35, limit: 1100 },
  gross: { width: 96, quality: 0.55, limit: 4500 },
} as const

/** The cover an entry shows as its poster: its own, or the first one a season or a part of it has. */
export function coverOfItem(item: SavedLinkItem): { src: string; frame?: CoverFrame } | null {
  if (item.cover) return { src: item.cover, frame: item.coverFrame }
  for (const season of item.seasons ?? []) {
    if (season.cover) return { src: season.cover, frame: season.coverFrame }
    for (const part of season.parts ?? []) if (part.cover) return { src: part.cover, frame: part.coverFrame }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Making                                                                      */
/* -------------------------------------------------------------------------- */

/** The pixels of a cover, from a picture stored with the entry or — where the server allows it — an address. */
async function bitmapOf(src: string): Promise<ImageBitmap | null> {
  try {
    const response = await fetch(src, src.startsWith('data:') ? undefined : { mode: 'cors', credentials: 'omit' })
    if (!response.ok) return null
    return await createImageBitmap(await response.blob())
  } catch {
    return null
  }
}

/** The part of a w × h box's picture a frame chooses, as `object-fit: cover` and `object-position` would show it. */
function cropOf(width: number, height: number, w: number, h: number, frame: CoverFrame | undefined) {
  const { x, y, zoom } = frame ?? { x: 50, y: 50, zoom: 1 }
  const fit = Math.max(w / width, h / height)
  const left = (w - width * fit) * (x / 100)
  const top = (h - height * fit) * (y / 100)
  const sw = w / zoom / fit
  const sh = h / zoom / fit
  const sx = Math.min(width - sw, Math.max(0, (w * (x / 100) * (1 - 1 / zoom) - left) / fit))
  const sy = Math.min(height - sh, Math.max(0, (h * (y / 100) * (1 - 1 / zoom) - top) / fit))
  return { sx, sy, sw, sh }
}

/** The framed part drawn at w × h: made small in halves first, as the tiles do, so it does not look jagged. */
function drawn(bitmap: ImageBitmap, frame: CoverFrame | undefined, w: number, h: number): HTMLCanvasElement | null {
  const { sx, sy, sw, sh } = cropOf(bitmap.width, bitmap.height, w, h, frame)
  const steps = sw > w ? Math.floor(Math.log2(sw / w)) : 0
  let level: Picture = bitmap
  for (let step = 0; step < steps; step += 1) {
    const next = halve(level)
    if (!next) break
    level = next
  }
  const scale = pictureSize(level).width / bitmap.width
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(level, sx * scale, sy * scale, sw * scale, sh * scale, 0, 0, w, h)
  return canvas
}

class Bits {
  private bytes: number[] = []
  private used = 0
  write(value: number, count: number): void {
    for (let bit = count - 1; bit >= 0; bit -= 1) {
      if (this.used % 8 === 0) this.bytes.push(0)
      if ((value >> bit) & 1) this.bytes[this.bytes.length - 1] |= 0x80 >> (this.used % 8)
      this.used += 1
    }
  }
  done(): number[] {
    return this.bytes
  }
}

function packRaw(canvas: HTMLCanvasElement): Uint8Array | null {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  const { data } = context.getImageData(0, 0, RAW_W, RAW_H)
  const bits = new Bits()
  const chroma: { cb: number; cr: number }[] = new Array(CELLS).fill(null).map(() => ({ cb: 0, cr: 0 }))
  for (let row = 0; row < RAW_H; row += 1) {
    for (let col = 0; col < RAW_W; col += 1) {
      const at = (row * RAW_W + col) * 4
      const r = data[at]
      const g = data[at + 1]
      const b = data[at + 2]
      bits.write(Math.round(((0.299 * r + 0.587 * g + 0.114 * b) / 255) * 15), 4)
      const cell = chroma[Math.floor(row / CELL) * (RAW_W / CELL) + Math.floor(col / CELL)]
      cell.cb += (128 - 0.168736 * r - 0.331264 * g + 0.5 * b) / (CELL * CELL)
      cell.cr += (128 + 0.5 * r - 0.418688 * g - 0.081312 * b) / (CELL * CELL)
    }
  }
  for (const cell of chroma) bits.write(Math.min(15, Math.max(0, Math.round((cell.cb / 255) * 15))), 4)
  for (const cell of chroma) bits.write(Math.min(15, Math.max(0, Math.round((cell.cr / 255) * 15))), 4)
  return Uint8Array.from([KIND.raw, ...bits.done()])
}

async function packed(canvas: HTMLCanvasElement, quality: number, limit: number): Promise<Uint8Array | null> {
  const blobAs = (type: string, q: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, q))
  for (const [type, kind] of [['image/webp', KIND.webp], ['image/jpeg', KIND.jpeg]] as const) {
    let best: Blob | null = null
    for (let q = quality; q >= 0.14; q -= 0.1) {
      const blob = await blobAs(type, q)
      // A browser that cannot write WebP answers with a PNG; the next type is tried.
      if (!blob || blob.type !== type) break
      best = blob
      if (blob.size <= limit) break
    }
    if (best) {
      const bytes = new Uint8Array(await best.arrayBuffer())
      return bytes.length + 1 <= THUMB_MAX ? Uint8Array.from([kind, ...bytes]) : null
    }
  }
  return null
}

/** The picture of a cover at a size; null when there is none to be had. */
export async function thumbOf(cover: { src: string; frame?: CoverFrame }, tile: TileFormat, tier: CoverTier): Promise<Uint8Array | null> {
  const bitmap = await bitmapOf(cover.src)
  if (!bitmap) return null
  try {
    if (tier === 'winzig') {
      const canvas = drawn(bitmap, cover.frame, RAW_W, RAW_H)
      return canvas ? packRaw(canvas) : null
    }
    const { width, quality, limit } = SIZED[tier]
    const canvas = drawn(bitmap, cover.frame, width, Math.round(width * ASPECT[tile]))
    return canvas ? await packed(canvas, quality, limit) : null
  } finally {
    bitmap.close()
  }
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}

const hasPrefix = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

/** Whether a picture of this kind is what it says it is — by its first bytes, not by trust. */
export function validThumb(blob: Uint8Array): boolean {
  if (blob.length < 2 || blob.length > THUMB_MAX) return false
  const body = blob.subarray(1)
  if (blob[0] === KIND.raw) return blob.length === RAW_BYTES
  if (blob[0] === KIND.webp) return body.length > 12 && hasPrefix(body, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(body.subarray(8), [0x57, 0x45, 0x42, 0x50])
  if (blob[0] === KIND.jpeg) return body.length > 4 && hasPrefix(body, [0xff, 0xd8, 0xff])
  return false
}

function unpackRaw(body: Uint8Array): HTMLCanvasElement | null {
  const small = document.createElement('canvas')
  small.width = RAW_W
  small.height = RAW_H
  const context = small.getContext('2d')
  if (!context) return null
  let at = 0
  const read = (count: number) => {
    let value = 0
    for (let bit = 0; bit < count; bit += 1) {
      value = (value << 1) | ((body[at >> 3] >> (7 - (at & 7))) & 1)
      at += 1
    }
    return value
  }
  const luma: number[] = []
  for (let n = 0; n < RAW_W * RAW_H; n += 1) luma.push((read(4) / 15) * 255)
  const cb: number[] = []
  const cr: number[] = []
  for (let n = 0; n < CELLS; n += 1) cb.push((read(4) / 15) * 255)
  for (let n = 0; n < CELLS; n += 1) cr.push((read(4) / 15) * 255)
  const image = context.createImageData(RAW_W, RAW_H)
  const clamp = (value: number) => Math.min(255, Math.max(0, Math.round(value)))
  for (let row = 0; row < RAW_H; row += 1) {
    for (let col = 0; col < RAW_W; col += 1) {
      const y = luma[row * RAW_W + col]
      const cell = Math.floor(row / CELL) * (RAW_W / CELL) + Math.floor(col / CELL)
      const u = cb[cell] - 128
      const v = cr[cell] - 128
      const to = (row * RAW_W + col) * 4
      image.data[to] = clamp(y + 1.402 * v)
      image.data[to + 1] = clamp(y - 0.344136 * u - 0.714136 * v)
      image.data[to + 2] = clamp(y + 1.772 * u)
      image.data[to + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  return small
}

/**
 * The picture as an address for an `<img>` or a tile, or null for something
 * that is no picture. A tiny one is drawn larger with smoothing, which is what
 * makes eight by twelve pixels look like a blurred poster.
 */
export function thumbUrl(blob: Uint8Array, tile: TileFormat): string | null {
  if (!validThumb(blob)) return null
  const body = blob.subarray(1)
  if (blob[0] === KIND.webp) return `data:image/webp;base64,${base64(body)}`
  if (blob[0] === KIND.jpeg) return `data:image/jpeg;base64,${base64(body)}`
  const small = unpackRaw(body)
  if (!small) return null
  const big = document.createElement('canvas')
  big.width = 40
  big.height = Math.round(40 * ASPECT[tile])
  const context = big.getContext('2d')
  if (!context) return null
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(small, 0, 0, big.width, big.height)
  const webp = big.toDataURL('image/webp', 0.8)
  return webp.startsWith('data:image/webp') ? webp : big.toDataURL('image/jpeg', 0.8)
}
