/**
 * Canvas waveform.
 *
 * Draws a min/max peak envelope rather than every sample — a four-minute track
 * is ten million points and a canvas is a few hundred columns wide, so the
 * envelope is both faster and a more honest picture of the signal.
 *
 * The envelope is computed once per audio and width and kept on an offscreen
 * canvas. Moving the playhead then costs one blit and one line, instead of
 * re-scanning every sample — which, at sixty frames a second during playback,
 * is the difference between a smooth cursor and a locked-up page.
 *
 * A fade that is set but not yet written is drawn into the waveform itself:
 * the columns shrink by the same equal-power gain the audio gets, what the
 * fade takes away stays as a faint trace, and a hairline follows the curve.
 * The picture is what will be heard, not a veil laid over the old one.
 */

import { useEffect, useRef } from 'react'

import { peakEnvelope } from '../lib/audio'
import { readPalette } from '../lib/theme'
import type { AudioData } from '../lib/wav'

export interface WaveFade {
  /** Seconds in the audio being drawn. */
  from: number
  to: number
  direction: 'in' | 'out'
}

/** Equal-power gain at `seconds` — the curve `fadeRange` renders with. */
export function fadeGainAt(fades: readonly WaveFade[], seconds: number): number {
  let gain = 1
  for (const fade of fades) {
    const length = fade.to - fade.from
    if (length <= 0 || seconds < fade.from || seconds > fade.to) continue
    const t = (seconds - fade.from) / length
    gain *= fade.direction === 'in' ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2)
  }
  return gain
}

export interface WaveformProps {
  audio: AudioData | null
  height?: number
  /** Defaults to the current theme's ink colour. */
  color?: string
  background?: string
  /** Playhead position in seconds. */
  position?: number | null
  /** Highlighted region in seconds. */
  selection?: { start: number; end: number } | null
  /** Fades to draw into the waveform before they are applied. */
  fades?: readonly WaveFade[]
  className?: string
}

const NO_FADES: readonly WaveFade[] = []

export function Waveform({
  audio,
  height = 96,
  color,
  background = 'transparent',
  position = null,
  selection = null,
  fades = NO_FADES,
  className = '',
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** The rendered envelope, reused until the audio, size, colours or fades change. */
  const layerRef = useRef<HTMLCanvasElement | null>(null)
  const layerKeyRef = useRef('')
  /** The peaks themselves, kept apart so moving a fade does not re-scan the audio. */
  const peaksRef = useRef<{ audio: AudioData; buckets: number; min: Float32Array; max: Float32Array } | null>(null)
  /** Which audio the cached layer shows; the key alone misses an edit that keeps the length. */
  const layerAudioRef = useRef<AudioData | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    /** Rebuilds the offscreen envelope. The expensive half. */
    const buildLayer = (width: number, ratio: number, stroke: string) => {
      const layer = layerRef.current ?? document.createElement('canvas')
      layerRef.current = layer
      layer.width = Math.max(1, Math.floor(width * ratio))
      layer.height = Math.max(1, Math.floor(height * ratio))

      const layerContext = layer.getContext('2d')
      if (!layerContext) return
      layerContext.setTransform(ratio, 0, 0, ratio, 0, 0)
      layerContext.clearRect(0, 0, width, height)

      const middle = height / 2

      if (!audio || (audio.channels[0]?.length ?? 0) === 0) {
        layerContext.strokeStyle = stroke
        layerContext.globalAlpha = 0.2
        layerContext.beginPath()
        layerContext.moveTo(0, middle)
        layerContext.lineTo(width, middle)
        layerContext.stroke()
        layerContext.globalAlpha = 1
        return
      }

      const buckets = Math.max(1, Math.floor(width))
      if (peaksRef.current?.audio !== audio || peaksRef.current.buckets !== buckets) {
        peaksRef.current = { audio, buckets, ...peakEnvelope(audio, buckets) }
      }
      const { min, max } = peaksRef.current
      const reach = middle * 0.94
      const duration = audio.channels[0].length / audio.sampleRate
      const gainOf = (x: number) => (fades.length === 0 ? 1 : fadeGainAt(fades, ((x + 0.5) / buckets) * duration))

      // What a fade takes away, as a trace: the original columns, faint.
      if (fades.length > 0) {
        layerContext.fillStyle = stroke
        layerContext.globalAlpha = 0.16
        for (let x = 0; x < buckets; x += 1) {
          if (gainOf(x) >= 0.999) continue
          const top = middle - max[x] * reach
          layerContext.fillRect(x, top, 1, Math.max(1, middle - min[x] * reach - top))
        }
        layerContext.globalAlpha = 1
      }

      layerContext.fillStyle = stroke
      for (let x = 0; x < buckets; x += 1) {
        const gain = gainOf(x)
        const top = middle - max[x] * gain * reach
        const bottom = middle - min[x] * gain * reach
        // Sub-pixel-tall columns vanish entirely; keep a hairline instead.
        layerContext.fillRect(x, top, 1, Math.max(1, bottom - top))
      }

      // The curve itself, so a fade over a quiet passage still has a shape.
      if (fades.length > 0) {
        layerContext.strokeStyle = stroke
        layerContext.globalAlpha = 0.5
        layerContext.lineWidth = 1
        for (const edge of [-1, 1]) {
          layerContext.beginPath()
          let drawing = false
          for (let x = 0; x <= buckets; x += 1) {
            const gain = gainOf(Math.min(x, buckets - 1))
            if (gain >= 0.999) {
              drawing = false
              continue
            }
            const y = middle + edge * gain * reach
            if (drawing) layerContext.lineTo(x, y)
            else layerContext.moveTo(x, y)
            drawing = true
          }
          layerContext.stroke()
        }
        layerContext.globalAlpha = 1
      }
    }

    /** Blits the envelope and draws what moves. The cheap half. */
    const draw = () => {
      const stroke = color ?? readPalette().ink
      const ratio = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      if (width <= 0) return

      const frames = audio?.channels[0]?.length ?? 0
      const fadeKey = fades.map((fade) => `${fade.direction}${fade.from.toFixed(4)}-${fade.to.toFixed(4)}`).join(',')
      const key = `${width}x${height}@${ratio}:${stroke}:${frames}:${audio?.sampleRate ?? 0}:${audio?.channels.length ?? 0}:${fadeKey}`
      if (key !== layerKeyRef.current || layerAudioRef.current !== audio) {
        buildLayer(width, ratio, stroke)
        layerKeyRef.current = key
        layerAudioRef.current = audio
      }

      canvas.width = Math.max(1, Math.floor(width * ratio))
      canvas.height = Math.max(1, Math.floor(height * ratio))
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)

      if (background !== 'transparent') {
        context.fillStyle = background
        context.fillRect(0, 0, width, height)
      }

      const duration = frames / (audio?.sampleRate ?? 1)

      if (selection && duration > 0) {
        const from = (selection.start / duration) * width
        const to = (selection.end / duration) * width
        context.fillStyle = stroke
        context.globalAlpha = 0.1
        context.fillRect(from, 0, Math.max(1, to - from), height)
        context.globalAlpha = 1
      }

      const layer = layerRef.current
      if (layer) context.drawImage(layer, 0, 0, width, height)

      if (position !== null && duration > 0) {
        context.fillStyle = stroke
        context.fillRect((position / duration) * width, 0, 1.5, height)
      }
    }

    draw()

    const observer = new ResizeObserver(() => {
      // A width change invalidates the cached envelope; the key check sees it.
      draw()
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [audio, height, color, background, position, selection, fades])

  return <canvas ref={canvasRef} style={{ height, width: '100%', display: 'block' }} className={className} />
}
