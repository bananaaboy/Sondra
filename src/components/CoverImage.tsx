/**
 * Covers in a tile: a picture drawn into its box at the device's own pixels,
 * from a pyramid of halvings, with the frame chosen for it — never an `<img>`
 * the browser shrinks in one step, which looked over-sharpened.
 *
 * Its own module so the Merkliste and the Ordner page („In Staffel
 * einordnen“) draw a poster the same way without one loading the other.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { halve, pictureSize, type CoverFrame, type Picture } from '../lib/merkliste'


export const MIDDLE: CoverFrame = { x: 50, y: 50, zoom: 1 }

/**
 * A loaded cover and the same picture at half, a quarter, an eighth … of its
 * size, made once and shared by every tile that shows it. Each drawing picks
 * the step just larger than it needs and makes only one short last step from
 * there.
 */
interface CoverSource {
  width: number
  height: number
  levels: Picture[]
}

const coverSources = new Map<string, Promise<CoverSource>>()

function loadCover(src: string): Promise<CoverSource> {
  const known = coverSources.get(src)
  if (known) return known
  const loading = new Promise<CoverSource>((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () =>
      image.naturalWidth && image.naturalHeight
        ? resolve({ width: image.naturalWidth, height: image.naturalHeight, levels: [image] })
        : reject(new Error('empty'))
    image.onerror = () => reject(new Error('unreadable'))
    image.src = src
  })
  // A cover that failed may answer later; it is not remembered as broken.
  loading.catch(() => coverSources.delete(src))
  coverSources.set(src, loading)
  return loading
}

function coverLevel(source: CoverSource, step: number): Picture {
  while (source.levels.length <= step) {
    const next = halve(source.levels[source.levels.length - 1])
    if (!next) break
    source.levels.push(next)
  }
  return source.levels[Math.min(step, source.levels.length - 1)]
}

/**
 * Draws the part of a cover a frame chooses onto a canvas of w × h device
 * pixels — the same part `object-fit: cover`, `object-position` and a
 * scale around that point would show, worked out here instead of left to the
 * browser's own downscaling.
 */
function drawCover(canvas: HTMLCanvasElement, source: CoverSource, frame: CoverFrame | undefined, w: number, h: number) {
  const { x, y, zoom } = frame ?? MIDDLE
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const context = canvas.getContext('2d')
  if (!context) return
  const fit = Math.max(w / source.width, h / source.height)
  const left = (w - source.width * fit) * (x / 100)
  const top = (h - source.height * fit) * (y / 100)
  const originX = w * (x / 100)
  const originY = h * (y / 100)
  const sw = w / zoom / fit
  const sh = h / zoom / fit
  const sx = Math.min(source.width - sw, Math.max(0, (originX * (1 - 1 / zoom) - left) / fit))
  const sy = Math.min(source.height - sh, Math.max(0, (originY * (1 - 1 / zoom) - top) / fit))
  // The half-size step whose part is still at least as large as the canvas.
  const step = sw > w ? Math.floor(Math.log2(sw / w)) : 0
  const level = coverLevel(source, step)
  const scale = pictureSize(level).width / source.width
  context.clearRect(0, 0, w, h)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(level, sx * scale, sy * scale, sw * scale, sh * scale, 0, 0, w, h)
}

/**
 * A cover filling its box, showing the part someone chose (`CoverFrame`),
 * drawn at exactly the box's device pixels (`drawCover`). As an `<img>` the
 * browser squeezed a large poster into a tile in one step, and it looked
 * over-sharpened; and a frame chosen in the editor looks the same on every
 * tile.
 */
export function CoverImage({
  src,
  frame,
  onError,
  onLoad,
}: {
  src: string
  frame?: CoverFrame
  onError?: () => void
  /** With the picture's own size, once it is there. */
  onLoad?: (size: { width: number; height: number }) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loaded, setLoaded] = useState<{ src: string; source: CoverSource } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const callbacks = useRef({ onError, onLoad })
  callbacks.current = { onError, onLoad }

  useEffect(() => {
    let alive = true
    loadCover(src).then(
      (source) => {
        if (!alive) return
        setLoaded({ src, source })
        callbacks.current.onLoad?.({ width: source.width, height: source.height })
      },
      () => {
        if (alive) callbacks.current.onError?.()
      },
    )
    return () => {
      alive = false
    }
  }, [src])

  // The box in device pixels, so one pixel drawn is one pixel shown — also
  // after the page is zoomed or the window moves to another screen.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(([entry]) => {
      // The exact device box where it is right; where it disagrees with the
      // CSS box times the pixel ratio by more than rounding (an emulated
      // ratio, an older engine), the product.
      const device = entry.devicePixelContentBoxSize?.[0]
      const pick = (exact: number | undefined, css: number) => {
        const scaled = css * devicePixelRatio
        return Math.max(1, Math.round(exact !== undefined && Math.abs(exact - scaled) <= 1 ? exact : scaled))
      }
      const w = pick(device?.inlineSize, entry.contentRect.width)
      const h = pick(device?.blockSize, entry.contentRect.height)
      setSize((old) => (old && old.w === w && old.h === h ? old : { w, h }))
    })
    try {
      observer.observe(canvas, { box: 'device-pixel-content-box' })
    } catch {
      observer.observe(canvas)
    }
    return () => observer.disconnect()
  }, [])

  const source = loaded && loaded.src === src ? loaded.source : null
  const { x, y, zoom } = frame ?? MIDDLE
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (canvas && source && size) drawCover(canvas, source, { x, y, zoom }, size.w, size.h)
  }, [source, size, x, y, zoom])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`absolute inset-0 h-full w-full transition-opacity duration-[var(--dur-base)] ${source && size ? 'opacity-100' : 'opacity-0'}`}
    />
  )
}
