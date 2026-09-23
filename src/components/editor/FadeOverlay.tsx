/**
 * A fade, drawn over a waveform before it is done: the part that will go
 * quiet is veiled in the frame's own colour, and the curve it follows is a
 * line in ink. The same equal-power shape the audio gets, so the picture is
 * the promise.
 *
 * Sits over the waveform's content box (the frame's padding is the inset) and
 * never takes a pointer — selecting on the waveform goes on working through it.
 */

export interface FadeShape {
  /** Seconds in the file. */
  from: number
  to: number
  direction: 'in' | 'out'
}

const POINTS = 48
// The waveform draws to 94 % of half its height; the curve meets it there.
const REACH = 47

export function FadeOverlay({
  fades,
  viewStart,
  viewEnd,
  inset = 12,
}: {
  fades: FadeShape[]
  viewStart: number
  viewEnd: number
  inset?: number
}) {
  const span = viewEnd - viewStart
  if (span <= 0) return null
  const visible = fades.filter((fade) => fade.to - fade.from > 0 && fade.to > viewStart && fade.from < viewEnd)
  if (visible.length === 0) return null

  const x = (seconds: number) => ((seconds - viewStart) / span) * 1000

  return (
    <svg
      aria-hidden
      viewBox="0 0 1000 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute overflow-hidden"
      style={{ inset }}
    >
      {visible.map((fade, index) => {
        const top: string[] = []
        const bottom: string[] = []
        for (let k = 0; k <= POINTS; k += 1) {
          const t = k / POINTS
          const gain = fade.direction === 'in' ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2)
          const at = x(fade.from + (fade.to - fade.from) * t).toFixed(2)
          top.push(`${at},${(50 - REACH * gain).toFixed(2)}`)
          bottom.push(`${at},${(50 + REACH * gain).toFixed(2)}`)
        }
        const left = x(fade.from).toFixed(2)
        const right = x(fade.to).toFixed(2)
        return (
          <g key={`${fade.direction}-${index}`}>
            <polygon points={`${left},0 ${top.join(' ')} ${right},0`} className="fill-panel-soft" fillOpacity={0.82} />
            <polygon points={`${left},100 ${bottom.join(' ')} ${right},100`} className="fill-panel-soft" fillOpacity={0.82} />
            <polyline points={top.join(' ')} fill="none" className="stroke-ink" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            <polyline points={bottom.join(' ')} fill="none" className="stroke-ink" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </g>
        )
      })}
    </svg>
  )
}
