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
import type { ReactNode } from 'react'

import { getAudioContext, resumeAudioContext } from '../../lib/audio'
import { saveBytes } from '../../lib/download'
import {
  bouncePattern,
  cellsToNotes,
  hasRoll,
  patternHits,
  resizeNotes,
  patternToMidi,
  starterPattern,
  stepSeconds,
  stepTime,
  type Pattern,
  type RollNote,
  type Slice,
  type Voice,
  startVoice,
} from '../../lib/pattern'
import { encodeWav, type AudioData } from '../../lib/wav'
import { Button, Select, Slider } from '../ui/primitives'
import { ChoiceRow } from '../editor/EditorShell'
import { IconPlay, IconStop } from '../editor/icons'
import { PianoRoll } from './PianoRoll'

const PAD_KEYS = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'y', 'x', 'c', 'v']

export function StepSequencer({
  slices,
  buffers,
  initialBpm,
  choke,
  baseName,
  onPreviewPad,
  onBounce,
  head,
  aside,
  note,
}: {
  slices: Slice[]
  buffers: () => { forward: AudioBuffer; reversed: AudioBuffer | null } | null
  initialBpm: number
  choke: boolean
  baseName: string
  /** Plays a pad, optionally transposed — the roll auditions its keys. */
  onPreviewPad: (index: number, semitone?: number) => void
  onBounce: (audio: AudioData, name: string) => void
  /**
   * The start of each row: the pad itself. Pads and pattern used to be two
   * blocks — a 4 × 4 grid of pads and, below it, the same sixteen pads again
   * as row names. Now the row name is the pad: it plays, it is chosen, and its
   * steps run straight on from it, as in a channel rack.
   */
  head: (slice: Slice, row: number) => ReactNode
  /** Beside the rows: the settings of the chosen pad and of the kit. */
  aside?: ReactNode
  /** A line under the title, for what the rows do not show. */
  note?: string
}) {
  const rows = slices.slice(0, PAD_KEYS.length)
  const [pattern, setPattern] = useState<Pattern>(() => ({
    steps: 16,
    bpm: Math.round(initialBpm) || 120,
    swing: 0,
    cells: {},
    notes: {},
    muted: {},
  }))
  /** The pad whose piano roll is open. */
  const [rollFor, setRollFor] = useState<string | null>(null)
  const [bigRoll, setBigRoll] = useState(false)
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
  const voicesRef = useRef(new Map<string, Voice>())
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
          if (chokeRef.current || hit.slice.mode === 'loop') voicesRef.current.get(hit.voice)?.stop(at)
          const voice = startVoice(context, context.destination, hit.slice, source, at, hit.slice.mode === 'oneshot' ? undefined : hit.hold)
          voicesRef.current.set(hit.voice, voice)
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
  const hasHits = rows.some((slice) =>
    hasRoll(pattern, slice.id) ? pattern.notes[slice.id].length > 0 : pattern.cells[slice.id]?.some(Boolean),
  )
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
      const notes: Record<string, RollNote[]> = {}
      for (const [id, list] of Object.entries(value.notes)) notes[id] = resizeNotes(list, value.steps, steps)
      return { ...value, steps, cells, notes }
    })

  /** Opens a pad's roll; its steps become its first notes. */
  const openRoll = (id: string) => {
    setPattern((value) =>
      hasRoll(value, id) ? value : { ...value, notes: { ...value.notes, [id]: cellsToNotes(value.cells[id]) } },
    )
    setRollFor(id)
  }

  /** Back to steps: every note start becomes a step at the pad's pitch. */
  const dropRoll = (id: string) => {
    setPattern((value) => {
      const notes = { ...value.notes }
      const row = Array.from({ length: value.steps }, () => false)
      for (const note of notes[id] ?? []) row[note.step] = true
      delete notes[id]
      return { ...value, notes, cells: { ...value.cells, [id]: row } }
    })
    setRollFor(null)
  }

  const setNotes = (id: string, list: RollNote[]) =>
    setPattern((value) => ({ ...value, notes: { ...value.notes, [id]: list } }))

  // A pad that was deleted takes its roll with it.
  const rolled = rows.find((slice) => slice.id === rollFor) ?? null
  const rolledIndex = rolled ? rows.indexOf(rolled) : -1

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
    <section aria-label="Pads und Pattern" className="flex flex-col overflow-hidden bg-raised ring-1 ring-inset ring-line">
      <header className="flex flex-wrap items-baseline gap-x-[16px] gap-y-[4px] border-b border-line px-[16px] py-[8px]">
        <p className="text-small font-semibold text-ink">Pads und Pattern</p>
        <p className="text-small text-prose">
          {note ?? 'Pad antippen spielt und wählt · Feld setzt einen Schlag · Leertaste spielt das Pattern'}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-x-[20px] gap-y-[10px] border-b border-line px-[16px] py-[10px]">
        <button
          type="button"
          onClick={() => (playing ? stop() : void play())}
          disabled={!hasHits && !playing}
          aria-label={playing ? 'Pattern anhalten (Leertaste)' : 'Pattern abspielen (Leertaste)'}
          title={playing ? 'Anhalten (Leertaste)' : hasHits ? 'Abspielen (Leertaste)' : 'Erst ein paar Felder setzen'}
          className="press inline-flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-pill bg-ink text-on-ink hover:bg-ink-hover disabled:opacity-40"
        >
          {playing ? IconStop : IconPlay}
        </button>
        <div className="w-[150px]">
          <Slider label="Tempo" display={`${pattern.bpm} BPM`} min={60} max={200} step={1} value={pattern.bpm}
            onChange={(event) => setPattern((value) => ({ ...value, bpm: Number(event.target.value) }))} />
        </div>
        <div className="w-[130px]">
          <Slider label="Swing" display={`${Math.round(pattern.swing * 100)} %`} min={0} max={0.6} step={0.01} value={pattern.swing}
            onChange={(event) => setPattern((value) => ({ ...value, swing: Number(event.target.value) }))} />
        </div>
        <ChoiceRow
          value={pattern.steps}
          onChange={setSteps}
          options={[
            { value: 16, label: '1 Takt', title: '16 Schritte' },
            { value: 32, label: '2 Takte', title: '32 Schritte' },
          ]}
        />
        {!hasHits ? (
          <Button size="sm" variant="quiet" onClick={() => setPattern((value) => ({ ...value, cells: starterPattern(rows, value.steps) }))}>
            Grundbeat vorschlagen
          </Button>
        ) : (
          <button
            type="button"
            onClick={() => setPattern((value) => ({ ...value, cells: {}, notes: Object.fromEntries(Object.keys(value.notes).map((id) => [id, []])) }))}
            className="press rounded-nav text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
          >
            Leeren
          </button>
        )}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
      <div className="min-w-0">
      {/* The grid scrolls sideways on a phone rather than shrinking the cells
          below what a thumb can hit; the pads stay put at the left edge. */}
      <div className="overflow-x-auto px-[16px] py-[14px]">
        <div className="flex min-w-max flex-col gap-[4px]">
          {rows.map((slice, row) => {
            const muted = Boolean(pattern.muted[slice.id])
            const cells = pattern.cells[slice.id] ?? []
            return (
              <div key={slice.id} className="flex items-center gap-[4px]">
                <div className="sticky left-0 z-[1] flex shrink-0 items-center gap-[4px] bg-raised pr-[4px]">
                {head(slice, row)}
                <button
                  type="button"
                  aria-pressed={muted}
                  aria-label={`Pad ${row + 1} stumm`}
                  title={muted ? 'Stumm — klicken zum Einschalten' : 'Stummschalten'}
                  onClick={() => setPattern((value) => ({ ...value, muted: { ...value.muted, [slice.id]: !muted } }))}
                  className={`press h-[34px] w-[28px] shrink-0 rounded-nav text-micro font-semibold ${
                    muted ? 'bg-ink text-on-ink' : 'bg-panel-soft text-prose hover:text-ink'
                  }`}
                >
                  M
                </button>
                <button
                  type="button"
                  aria-pressed={rollFor === slice.id}
                  aria-label={`Klavierrolle für Pad ${row + 1}`}
                  title="Klavierrolle: Töne setzen"
                  onClick={() => (rollFor === slice.id ? setRollFor(null) : openRoll(slice.id))}
                  className={`press grid h-[34px] w-[28px] shrink-0 place-items-center rounded-nav ${
                    rollFor === slice.id
                      ? 'bg-ink text-on-ink'
                      : hasRoll(pattern, slice.id)
                        ? 'bg-panel-mid text-ink'
                        : 'bg-panel-soft text-muted hover:text-ink'
                  }`}
                >
                  <svg viewBox="0 0 16 16" className="h-[14px] w-[14px]" fill="currentColor" aria-hidden>
                    <rect x="1" y="3" width="6" height="2" rx="0.6" />
                    <rect x="5" y="7" width="8" height="2" rx="0.6" />
                    <rect x="3" y="11" width="5" height="2" rx="0.6" />
                  </svg>
                </button>
                </div>
                <div className={`flex items-center ${muted ? 'opacity-45' : ''}`}>
                {hasRoll(pattern, slice.id) ? (
                  // A rolled pad shows its notes in miniature; a click opens it.
                  <button
                    type="button"
                    onClick={() => openRoll(slice.id)}
                    title="Klavierrolle öffnen"
                    className="relative h-[34px] shrink-0 rounded-[5px] bg-panel-soft hover:bg-panel-mid"
                    style={{ width: pattern.steps * 29 + Math.floor((pattern.steps - 1) / 4) * 5 - 3 }}
                  >
                    {(pattern.notes[slice.id] ?? []).map((note, index) => (
                      <span
                        key={index}
                        className="absolute h-[3px] rounded-pill bg-ink"
                        style={{
                          left: `${(note.step / pattern.steps) * 100}%`,
                          width: `${(note.length / pattern.steps) * 100}%`,
                          top: `${Math.min(30, Math.max(2, 16 - note.semitone))}px`,
                        }}
                      />
                    ))}
                    {current !== null ? (
                      <span className="absolute inset-y-0 w-[2px] bg-ink/50" style={{ left: `${(current / pattern.steps) * 100}%` }} />
                    ) : null}
                  </button>
                ) : (
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
                        className={`h-[34px] w-[26px] rounded-[5px] transition-colors ${step % 4 === 0 && step > 0 ? 'ml-[5px]' : ''} ${
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
                )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* -- the open pad: its piano roll ------------------------------------ */}
      {rolled ? (
        <div className="border-t border-line px-[16px] py-[12px]">
          <div className="flex flex-wrap items-center gap-[8px]">
            <Select
              value={rolled.id}
              onChange={(event) => openRoll(event.target.value)}
              aria-label="Pad in der Klavierrolle"
              className="w-auto! py-[6px] text-small"
            >
              {rows.map((slice, row) => (
                <option key={slice.id} value={slice.id}>
                  Pad {row + 1}
                </option>
              ))}
            </Select>
            <span className="text-small text-muted">
              Klicken setzt einen Ton · ziehen verlängert · Ton ziehen verschiebt · Ton anklicken löscht
            </span>
            <div className="ml-auto flex gap-[8px]">
              <Button size="sm" variant="ghost" onClick={() => setBigRoll((value) => !value)}>
                {bigRoll ? 'Kleiner' : 'Grösser'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNotes(rolled.id, [])}>
                Töne leeren
              </Button>
              <Button size="sm" variant="ghost" onClick={() => dropRoll(rolled.id)}>
                Zurück zu Schritten
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setRollFor(null)}>
                Schliessen
              </Button>
            </div>
          </div>
          <div className="mt-[12px]">
            <PianoRoll
              notes={pattern.notes[rolled.id] ?? []}
              steps={pattern.steps}
              current={current}
              big={bigRoll}
              onChange={(list) => setNotes(rolled.id, list)}
              onAudition={(semitone) => onPreviewPad(rolledIndex, semitone)}
            />
          </div>
        </div>
      ) : null}

      </div>
      {aside ? <div className="flex min-w-0 flex-col border-t border-line lg:border-l lg:border-t-0">{aside}</div> : null}
      </div>

      <footer className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] border-t border-line px-[16px] py-[10px]">
        <span className="text-small text-prose">Ausgabe</span>
        <ChoiceRow
          value={loops}
          onChange={setLoops}
          options={[1, 2, 4, 8].map((value) => ({ value, label: `${value}×`, title: `${value}× durchspielen` }))}
        />
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
          title="Pad 1 auf C1, Pad 2 auf C♯1 … — Pads mit Klavierrolle ab C4"
        >
          Als MIDI
        </Button>
        <span className="text-small text-prose">Nahtlos loopbar.</span>
      </footer>
    </section>
  )
}
