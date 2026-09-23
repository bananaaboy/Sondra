/**
 * The pattern: a row per pad, a column per sixteenth — the channel rack of
 * FL Studio, reduced to what a chop needs.
 *
 * Click a cell to put a hit there, the row name to hear the pad, M to mute a
 * row. Space starts and stops. Tempo comes from the detected BPM, swing pushes
 * every second sixteenth late the way an MPC does, and the result leaves as a
 * seamlessly looping WAV, into the session, or as MIDI for a DAW.
 *
 * Scheduling runs ahead on the audio clock (a short look-ahead refilled every
 * 25 ms), so timing is sample-exact even when the page is busy repainting.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { getAudioContext, resumeAudioContext } from '../../lib/audio'
import { saveBytes } from '../../lib/download'
import {
  bouncePattern,
  patternHits,
  patternToMidi,
  starterPattern,
  stepSeconds,
  stepTime,
  type Pattern,
  type Slice,
  type Voice,
  startVoice,
} from '../../lib/pattern'
import { encodeWav, type AudioData } from '../../lib/wav'
import { Button, Card, SectionHead, Select, Slider } from '../ui/primitives'

const PAD_KEYS = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'y', 'x', 'c', 'v']

export function StepSequencer({
  slices,
  buffers,
  initialBpm,
  choke,
  baseName,
  onPreviewPad,
  onBounce,
}: {
  slices: Slice[]
  buffers: () => { forward: AudioBuffer; reversed: AudioBuffer | null } | null
  initialBpm: number
  choke: boolean
  baseName: string
  onPreviewPad: (index: number) => void
  onBounce: (audio: AudioData, name: string) => void
}) {
  const rows = slices.slice(0, PAD_KEYS.length)
  const [pattern, setPattern] = useState<Pattern>(() => ({
    steps: 16,
    bpm: Math.round(initialBpm) || 120,
    swing: 0,
    cells: {},
    muted: {},
  }))
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState<number | null>(null)
  const [loops, setLoops] = useState(4)
  const [bouncing, setBouncing] = useState(false)

  // The scheduler reads the pattern live, so edits land on the next pass.
  const patternRef = useRef(pattern)
  patternRef.current = pattern
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const chokeRef = useRef(choke)
  chokeRef.current = choke
  const timerRef = useRef<number | null>(null)
  const voicesRef = useRef(new Map<number, Voice>())
  const uiTimers = useRef<number[]>([])

  useEffect(() => {
    setPattern((value) => (value.bpm === 120 && initialBpm ? { ...value, bpm: Math.round(initialBpm) } : value))
  }, [initialBpm])

  const stop = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
    uiTimers.current.forEach((id) => window.clearTimeout(id))
    uiTimers.current = []
    for (const voice of voicesRef.current.values()) voice.stop()
    voicesRef.current.clear()
    setPlaying(false)
    setCurrent(null)
  }, [])

  const play = useCallback(async () => {
    const source = buffers()
    if (!source) return
    await resumeAudioContext()
    const context = getAudioContext()
    let step = 0
    let passStart = context.currentTime + 0.06
    setPlaying(true)

    const tick = () => {
      const now = context.currentTime
      const p = patternRef.current
      while (true) {
        const at = passStart + stepTime(step, p.bpm, p.swing)
        if (at > now + 0.12) break
        const hits = patternHits(rowsRef.current, p).filter((hit) => hit.step === step)
        for (const hit of hits) {
          if (chokeRef.current || hit.slice.mode === 'loop') voicesRef.current.get(hit.row)?.stop(at)
          const voice = startVoice(context, context.destination, hit.slice, source, at, hit.slice.mode === 'oneshot' ? undefined : hit.hold)
          voicesRef.current.set(hit.row, voice)
        }
        const shown = step
        uiTimers.current.push(window.setTimeout(() => setCurrent(shown), Math.max(0, (at - now) * 1000)))
        step += 1
        if (step >= p.steps) {
          step = 0
          passStart += p.steps * stepSeconds(p.bpm)
        }
      }
      // Keep the list of pending repaints short.
      if (uiTimers.current.length > 64) uiTimers.current = uiTimers.current.slice(-32)
    }
    tick()
    timerRef.current = window.setInterval(tick, 25)
  }, [buffers])

  useEffect(() => stop, [stop])

  // Space runs the pattern, as in every DAW — once there is one to run.
  const hasHits = rows.some((slice) => pattern.cells[slice.id]?.some(Boolean))
  const toggleRef = useRef<() => void>(() => {})
  toggleRef.current = () => {
    if (playing) stop()
    else if (hasHits) void play()
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ' ' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) return
      toggleRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleCell = (id: string, step: number) =>
    setPattern((value) => {
      const row = [...(value.cells[id] ?? Array.from({ length: value.steps }, () => false))]
      row[step] = !row[step]
      return { ...value, cells: { ...value.cells, [id]: row } }
    })

  const setSteps = (steps: number) =>
    setPattern((value) => {
      // Going to 32 repeats the bar, going back keeps the first one.
      const cells: Record<string, boolean[]> = {}
      for (const [id, row] of Object.entries(value.cells)) {
        cells[id] = Array.from({ length: steps }, (_, index) => row[index % value.steps] ?? false)
      }
      return { ...value, steps, cells }
    })

  const bounce = async (target: 'session' | 'file') => {
    const source = buffers()
    if (!source) return
    setBouncing(true)
    try {
      const audio = await bouncePattern(rows, pattern, source, loops, choke)
      const name = `${baseName}-pattern-${pattern.bpm}bpm.wav`
      if (target === 'file') saveBytes(encodeWav(audio, 24), name, 'audio/wav')
      else onBounce(audio, name)
    } finally {
      setBouncing(false)
    }
  }

  if (rows.length === 0) return null

  return (
    <Card tone="cream" size="compact">
      <div className="flex flex-wrap items-baseline justify-between gap-[12px]">
        <SectionHead>Pattern</SectionHead>
        <span className="text-small text-muted">Feld anklicken setzt einen Schlag · Leertaste spielt</span>
      </div>

      <div className="mt-[12px] flex flex-wrap items-end gap-[12px]">
        <Button size="sm" onClick={() => (playing ? stop() : void play())} disabled={!hasHits && !playing}>
          {playing ? 'Stopp' : 'Abspielen'}
        </Button>
        <div className="w-[160px]">
          <Slider label="Tempo" display={`${pattern.bpm} BPM`} min={60} max={200} step={1} value={pattern.bpm}
            onChange={(event) => setPattern((value) => ({ ...value, bpm: Number(event.target.value) }))} />
        </div>
        <div className="w-[140px]">
          <Slider label="Swing" display={`${Math.round(pattern.swing * 100)} %`} min={0} max={0.6} step={0.01} value={pattern.swing}
            onChange={(event) => setPattern((value) => ({ ...value, swing: Number(event.target.value) }))} />
        </div>
        <Select value={pattern.steps} onChange={(event) => setSteps(Number(event.target.value))} aria-label="Länge" className="w-auto! py-[6px] text-small">
          <option value={16}>1 Takt · 16 Schritte</option>
          <option value={32}>2 Takte · 32 Schritte</option>
        </Select>
        {!hasHits ? (
          <Button size="sm" variant="ghost" onClick={() => setPattern((value) => ({ ...value, cells: starterPattern(rows, value.steps) }))}>
            Grundbeat vorschlagen
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setPattern((value) => ({ ...value, cells: {} }))}>
            Leeren
          </Button>
        )}
      </div>

      {/* The grid scrolls sideways on a phone rather than shrinking the cells
          below what a thumb can hit. */}
      <div className="mt-[16px] overflow-x-auto pb-[4px]">
        <div className="flex min-w-max flex-col gap-[4px]">
          {rows.map((slice, row) => {
            const muted = Boolean(pattern.muted[slice.id])
            const cells = pattern.cells[slice.id] ?? []
            return (
              <div key={slice.id} className={`flex items-center gap-[4px] ${muted ? 'opacity-45' : ''}`}>
                <button
                  type="button"
                  aria-pressed={muted}
                  title={muted ? 'Stumm — klicken zum Einschalten' : 'Stummschalten'}
                  onClick={() => setPattern((value) => ({ ...value, muted: { ...value.muted, [slice.id]: !muted } }))}
                  className={`press h-[28px] w-[28px] shrink-0 rounded-nav text-micro font-semibold ${
                    muted ? 'bg-ink text-on-ink' : 'bg-panel-soft text-muted hover:text-ink'
                  }`}
                >
                  M
                </button>
                <button
                  type="button"
                  onClick={() => onPreviewPad(row)}
                  className="press h-[28px] w-[76px] shrink-0 truncate rounded-nav bg-raised px-[8px] text-left text-small text-ink ring-1 ring-inset ring-line hover:bg-panel-soft"
                  title="Pad anhören"
                >
                  <span className="value text-muted">{PAD_KEYS[row]}</span> Pad {row + 1}
                </button>
                <div className="flex gap-[3px]">
                  {Array.from({ length: pattern.steps }, (_, step) => {
                    const on = Boolean(cells[step])
                    const beat = Math.floor(step / 4) % 2 === 0
                    const here = current === step
                    return (
                      <button
                        key={step}
                        type="button"
                        aria-pressed={on}
                        aria-label={`Pad ${row + 1}, Schritt ${step + 1}`}
                        onClick={() => toggleCell(slice.id, step)}
                        className={`h-[28px] w-[24px] rounded-[5px] transition-colors ${step % 4 === 0 && step > 0 ? 'ml-[5px]' : ''} ${
                          on
                            ? 'bg-ink'
                            : beat
                              ? 'bg-panel-mid hover:bg-ink/35'
                              : 'bg-panel-soft hover:bg-ink/25'
                        } ${here ? 'ring-2 ring-ink ring-offset-1 ring-offset-canvas' : ''}`}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="mt-[16px] flex flex-wrap items-center gap-[8px] border-t border-line pt-[12px]">
        <Select value={loops} onChange={(event) => setLoops(Number(event.target.value))} aria-label="Wiederholungen" className="w-auto! py-[6px] text-small">
          {[1, 2, 4, 8].map((value) => (
            <option key={value} value={value}>
              {value}× durchspielen
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={!hasHits || bouncing} onClick={() => void bounce('session')}>
          {bouncing ? 'Rendert…' : 'In die Sitzung'}
        </Button>
        <Button size="sm" variant="quiet" disabled={!hasHits || bouncing} onClick={() => void bounce('file')}>
          Als WAV
        </Button>
        <Button
          size="sm"
          variant="quiet"
          disabled={!hasHits}
          onClick={() => saveBytes(patternToMidi(rows, pattern, loops), `${baseName}-pattern.mid`, 'audio/midi')}
        >
          Als MIDI
        </Button>
        <span className="text-small text-muted">nahtlos loopbar; MIDI legt Pad 1 auf C1, Pad 2 auf C♯1 …</span>
      </div>
    </Card>
  )
}
