/**
 * The sound editors' stage: a ruler of time over a waveform, on stage black.
 *
 * The sound tools used to draw their waveform on a pale tint inside a card,
 * a hundred and thirty pixels high, with everything else stacked below it. On
 * the stage it gets what a waveform needs in a studio: height, a dark ground
 * the signal stands out from, and a time scale to read a cut against.
 *
 * Selection and playhead are lines in the DOM rather than paint in the canvas.
 * The canvas then only redraws when the audio, its size or a fade changes —
 * not sixty times a second while something plays.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes, ReactNode, RefObject } from 'react'

import type { AudioData } from '../../lib/wav'
import { Waveform, type WaveFade } from '../Waveform'

/** The stage's one colour — the signal. Same in both themes, like the stage. */
function stageAccent(): string {
  if (typeof document === 'undefined') return '#8fe0a6'
  return getComputedStyle(document.documentElement).getPropertyValue('--color-stage-accent').trim() || '#8fe0a6'
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}

/** Seconds as the ruler writes them: as fine as the spacing needs, no finer. */
function rulerLabel(seconds: number, step: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  if (step >= 1) return `${m}:${String(Math.round(s)).padStart(2, '0')}`
  const digits = step >= 0.1 ? 1 : 2
  const [whole, fraction] = s.toFixed(digits).split('.')
  return `${m}:${whole.padStart(2, '0')},${fraction}`
}

const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]

/** A time scale for the stretch in view, labelled every ninety-odd pixels. */
export function TimeRuler({ start, end }: { start: number; end: number }) {
  const [ref, { width }] = useWidth<HTMLDivElement>()
  const span = Math.max(1e-3, end - start)
  const step = STEPS.find((candidate) => (candidate / span) * width >= 92) ?? STEPS[STEPS.length - 1]
  const minor = step / 5
  const ticks: { x: number; major: boolean; label: string | null }[] = []
  if (width > 0) {
    const first = Math.ceil(start / minor - 1e-6) * minor
    for (let index = 0, at = first; at <= end + 1e-9 && index < 600; index += 1, at = first + index * minor) {
      const major = Math.abs(at / step - Math.round(at / step)) < 1e-6
      ticks.push({ x: ((at - start) / span) * width, major, label: major ? rulerLabel(at, step) : null })
    }
  }
  return (
    <div ref={ref} aria-hidden className="relative h-[24px] shrink-0 overflow-hidden border-b border-stage-line bg-stage-soft">
      {ticks.map((tick) => (
        <div key={tick.x.toFixed(2)} className="absolute bottom-0" style={{ left: tick.x }}>
          <div className={`w-px ${tick.major ? 'h-[8px] bg-stage-muted' : 'h-[4px] bg-stage-line'}`} />
          {tick.label ? (
            <span className="value absolute bottom-[9px] left-[4px] whitespace-nowrap text-micro leading-none text-stage-muted">
              {tick.label}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/** The waveform at whatever height the stage has. */
function FillWaveform({ audio, fades }: { audio: AudioData | null; fades: readonly WaveFade[] }) {
  const [ref, { height }] = useWidth<HTMLDivElement>()
  const [color] = useState(stageAccent)
  return (
    <div ref={ref} className="absolute inset-x-0 inset-y-[10px]">
      {height > 0 ? <Waveform audio={audio} height={height} color={color} fades={fades} /> : null}
    </div>
  )
}

export interface SoundStageProps {
  /** The audio in view — the whole file, or the zoomed slice of it. */
  audio: AudioData | null
  /** What the view shows, in the file's seconds, for the ruler. */
  start: number
  end: number
  /** Playhead and selection, in seconds from the start of the view. */
  position?: number | null
  selection?: { start: number; end: number } | null
  fades?: readonly WaveFade[]
  /** The surface the pointer works on; measured by the caller for its seconds. */
  surfaceRef: RefObject<HTMLDivElement | null>
  surface?: HTMLAttributes<HTMLDivElement>
  /** Drawn over the waveform, under the pointer: pad regions, markers. */
  overlay?: ReactNode
  /** Pinned to the stage's top edge, over the ruler's shadow: a selection's own controls. */
  top?: ReactNode
}

const NO_FADES: readonly WaveFade[] = []

export function SoundStage({
  audio,
  start,
  end,
  position = null,
  selection = null,
  fades = NO_FADES,
  surfaceRef,
  surface,
  overlay,
  top,
}: SoundStageProps) {
  const span = Math.max(1e-6, end - start)
  const percent = (seconds: number) => `${Math.min(100, Math.max(0, (seconds / span) * 100))}%`
  return (
    <div className="absolute inset-0 flex flex-col bg-stage">
      <TimeRuler start={start} end={end} />
      <div
        ref={surfaceRef}
        {...surface}
        className={`relative min-h-0 flex-1 cursor-text touch-none select-none ${surface?.className ?? ''}`}
      >
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-stage-line/70" />
        <FillWaveform audio={audio} fades={fades} />
        {selection ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 border-x border-stage-ink/80 bg-stage-ink/[0.09]"
            style={{ left: percent(selection.start), width: `calc(${percent(selection.end)} - ${percent(selection.start)})` }}
          />
        ) : null}
        {overlay}
        {position !== null ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-[2px] -translate-x-1/2 bg-stage-ink"
            style={{ left: percent(position) }}
          />
        ) : null}
        {top ? <div className="pointer-events-none absolute inset-x-[12px] top-[10px] flex justify-start">{top}</div> : null}
      </div>
    </div>
  )
}
