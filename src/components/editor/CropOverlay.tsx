/**
 * Direct manipulation of a crop rectangle.
 *
 * Both editors had their own version of this and neither had handles: you
 * dragged a new rectangle from scratch every time, so nudging one edge by ten
 * pixels meant redrawing the whole thing and losing the other three. Here the
 * rectangle has eight handles and a draggable middle, which is the difference
 * between "set a crop" and "adjust the crop".
 *
 * Coordinates are fractions of the source, never pixels, so the rectangle
 * survives a window resize, a zoom, and being handed to FFmpeg — which wants
 * fractions of `iw`/`ih` anyway.
 */

import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const FULL_RECT: Rect = { x: 0, y: 0, width: 1, height: 1 }

/** Aspect ratios offered by both editors, in the order people reach for them. */
export const ASPECTS: { id: string; label: string; ratio: number | null }[] = [
  { id: 'free', label: 'Frei', ratio: null },
  { id: 'square', label: '1:1', ratio: 1 },
  { id: 'classic', label: '4:3', ratio: 4 / 3 },
  { id: 'photo', label: '3:2', ratio: 3 / 2 },
  { id: 'wide', label: '16:9', ratio: 16 / 9 },
  { id: 'tall', label: '9:16', ratio: 9 / 16 },
]

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/**
 * Fits the largest rectangle of the given aspect inside the frame, centred.
 *
 * `ratio` is width over height *in pixels*, but the rectangle is in fractions
 * of the source — so it has to be divided through by the source's own aspect
 * before it means anything. Skipping that step is why "1:1" on a 16:9 photo
 * used to come out as a rectangle.
 */
export function rectForAspect(ratio: number | null, sourceAspect: number, previous?: Rect): Rect {
  if (ratio === null) return previous ?? FULL_RECT
  const wanted = ratio / sourceAspect
  let width = 1
  let height = width / wanted
  if (height > 1) {
    height = 1
    width = height * wanted
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height }
}

/**
 * The same selection, after the picture underneath it has turned.
 *
 * Rotating used to throw the crop away, which is defensible — the rectangle
 * was drawn against a frame that no longer exists — but it is not what anyone
 * wants: you straighten a photo *and then* find your crop has gone. The
 * rectangle is in fractions, so turning it is four lines of arithmetic.
 *
 * Clockwise: what was the top-left corner is now the top-right one.
 */
export function rotateRect(rect: Rect, degrees: 90 | 180 | 270): Rect {
  if (degrees === 180) {
    return { x: 1 - rect.x - rect.width, y: 1 - rect.y - rect.height, width: rect.width, height: rect.height }
  }
  if (degrees === 90) {
    return { x: 1 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width }
  }
  return { x: rect.y, y: 1 - rect.x - rect.width, width: rect.height, height: rect.width }
}

/** The same selection, after the picture has been mirrored. */
export function mirrorRect(rect: Rect, axis: 'h' | 'v'): Rect {
  return axis === 'h'
    ? { ...rect, x: 1 - rect.x - rect.width }
    : { ...rect, y: 1 - rect.y - rect.height }
}

export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se' | 'new'

const HANDLES: { id: Handle; style: string; cursor: string }[] = [
  { id: 'nw', style: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2', cursor: 'nwse-resize' },
  { id: 'ne', style: 'right-0 top-0 translate-x-1/2 -translate-y-1/2', cursor: 'nesw-resize' },
  { id: 'sw', style: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2', cursor: 'nesw-resize' },
  { id: 'se', style: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2', cursor: 'nwse-resize' },
  { id: 'n', style: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2', cursor: 'ns-resize' },
  { id: 's', style: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2', cursor: 'ns-resize' },
  { id: 'w', style: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2', cursor: 'ew-resize' },
  { id: 'e', style: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2', cursor: 'ew-resize' },
]

/** The smallest crop that still has pixels in it, as a fraction. */
const MIN = 0.02

/** What a press on the rectangle was: which handle, the rectangle as it was, and where the pointer landed. */
export interface DragState {
  handle: Handle
  start: Rect
  originX: number
  originY: number
}

/**
 * The rectangle after the pointer moved to `point` (fractions of the source, 0 to 1). Pure: a drag works
 * from the snapshot taken when it began, and nothing else. The native editors (`native/sondra-media`) carry
 * the same rules and are checked against this function.
 */
export function dragRect(state: DragState, point: { x: number; y: number }, ratio: number | null, sourceAspect: number): Rect {
  const { start } = state
  let { x, y, width, height } = start

  if (state.handle === 'move') {
    x = clamp01(start.x + (point.x - state.originX))
    y = clamp01(start.y + (point.y - state.originY))
    // Pushing against an edge stops the rectangle rather than shrinking it.
    x = Math.min(x, 1 - start.width)
    y = Math.min(y, 1 - start.height)
    return { x, y, width: start.width, height: start.height }
  }

  const handle = state.handle === 'new' ? 'se' : state.handle
  // Each edge is moved to the pointer; the opposite edge stays where it is.
  const left = handle.includes('w') ? point.x : start.x
  const right = handle.includes('e') ? point.x : start.x + start.width
  const top = handle.includes('n') ? point.y : start.y
  const bottom = handle.includes('s') ? point.y : start.y + start.height

  if (state.handle === 'new') {
    x = Math.min(state.originX, point.x)
    y = Math.min(state.originY, point.y)
    width = Math.abs(point.x - state.originX)
    height = Math.abs(point.y - state.originY)
  } else {
    x = Math.min(left, right)
    y = Math.min(top, bottom)
    width = Math.abs(right - left)
    height = Math.abs(bottom - top)
  }

  width = Math.max(MIN, width)
  height = Math.max(MIN, height)

  if (ratio !== null) {
    // The ratio is in pixels, the rectangle is in fractions of the source.
    const wanted = ratio / sourceAspect
    // Grow from whichever dimension the pointer moved further in, so the
    // rectangle follows the hand instead of snapping sideways.
    if (width / wanted > height) height = width / wanted
    else width = height * wanted
    // Then pull it back inside the frame, keeping the anchored corner put.
    const anchorRight = handle.includes('w')
    const anchorBottom = handle.includes('n')
    if (width > 1) {
      width = 1
      height = width / wanted
    }
    if (height > 1) {
      height = 1
      width = height * wanted
    }
    x = anchorRight ? Math.min(start.x + start.width, 1) - width : x
    y = anchorBottom ? Math.min(start.y + start.height, 1) - height : y
  }

  x = clamp01(Math.min(x, 1 - width))
  y = clamp01(Math.min(y, 1 - height))
  width = Math.min(width, 1 - x)
  height = Math.min(height, 1 - y)

  return { x, y, width, height }
}

export function CropOverlay({
  rect,
  onChange,
  /** Pixel aspect of the media, so a locked ratio means what it says. */
  sourceAspect,
  ratio,
}: {
  rect: Rect
  onChange: (rect: Rect) => void
  sourceAspect: number
  ratio: number | null
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  // Captured on pointerdown: the rectangle as it was, plus where in it the
  // pointer landed. Working from a snapshot rather than the live rectangle is
  // what stops a drag from accumulating rounding error.
  const drag = useRef<{ handle: Handle; start: Rect; originX: number; originY: number } | null>(null)

  const pointAt = (event: ReactPointerEvent | PointerEvent) => {
    const box = frameRef.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return null
    return {
      x: clamp01((event.clientX - box.left) / box.width),
      y: clamp01((event.clientY - box.top) / box.height),
    }
  }

  const begin = (handle: Handle) => (event: ReactPointerEvent) => {
    const point = pointAt(event)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    drag.current = {
      handle,
      start: handle === 'new' ? { x: point.x, y: point.y, width: MIN, height: MIN } : rect,
      originX: point.x,
      originY: point.y,
    }
    if (handle === 'new') onChange(drag.current.start)
  }

  const move = (event: ReactPointerEvent) => {
    const state = drag.current
    if (!state) return
    const point = pointAt(event)
    if (!point) return
    event.preventDefault()
    onChange(dragRect(state, point, ratio, sourceAspect))
  }

  const end = (event: ReactPointerEvent) => {
    if (!drag.current) return
    ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
    drag.current = null
  }

  const full = rect.width >= 0.999 && rect.height >= 0.999
  const box = {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  }

  return (
    <div
      ref={frameRef}
      className="absolute inset-0 touch-none select-none"
      onPointerDown={begin('new')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {/* Four panes of shade rather than one box-shadow: this way the bright
          part really is unobstructed, and nothing sits over the picture. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bg-stage/60" style={{ height: box.top }} />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-stage/60"
        style={{ top: `${(rect.y + rect.height) * 100}%` }}
      />
      <div
        className="pointer-events-none absolute left-0 bg-stage/60"
        style={{ top: box.top, height: box.height, width: box.left }}
      />
      <div
        className="pointer-events-none absolute right-0 bg-stage/60"
        style={{ top: box.top, height: box.height, left: `${(rect.x + rect.width) * 100}%` }}
      />

      {/* While the rectangle still covers everything there is nothing to move,
          and a drag across the picture means "draw one here" — so the body of
          the box hands that gesture on rather than swallowing it. The handles
          keep working either way; they stop the event themselves. */}
      <div
        className={`absolute ring-1 ring-stage-ink/90 ${full ? 'cursor-crosshair' : 'cursor-move'}`}
        style={box}
        onPointerDown={begin(full ? 'new' : 'move')}
      >
        {/* Thirds, the one guide that is worth drawing unprompted. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40">
          <div className="absolute inset-y-0 left-1/3 w-px bg-stage-ink" />
          <div className="absolute inset-y-0 left-2/3 w-px bg-stage-ink" />
          <div className="absolute inset-x-0 top-1/3 h-px bg-stage-ink" />
          <div className="absolute inset-x-0 top-2/3 h-px bg-stage-ink" />
        </div>
        {HANDLES.map((handle) => (
          <span
            key={handle.id}
            role="presentation"
            onPointerDown={begin(handle.id)}
            style={{ cursor: handle.cursor }}
            className={`absolute h-[14px] w-[14px] bg-stage-ink ring-1 ring-stage/40 ${handle.style}`}
          />
        ))}
      </div>
    </div>
  )
}
