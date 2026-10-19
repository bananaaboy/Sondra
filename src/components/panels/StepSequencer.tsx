/**
 * The pattern: a row per pad, a column per sixteenth — the channel rack of
 * FL Studio, reduced to what a chop needs.
 *
 * Click a cell to put a hit there, the row name to hear the pad, M to mute a
 * row, or > next to M to switch straight into the Piano-Roll for that pad.
 * Space starts and stops. Tempo comes from the detected BPM, swing pushes
 * every second sixteenth late the way an MPC does, and the result leaves as a
 * seamlessly looping WAV, into the session, or as MIDI for a DAW.
 *
 * Scheduling runs ahead on the audio clock (a short look-ahead refilled every
 * 25 ms), so timing is sample-exact even when the page is busy repainting.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { getAudioContext, resumeAudioContext } from '../../lib/audio'
import { concatAudio } from '../../lib/edit'
import { saveBytes } from '../../lib/download'
import {
  SOUND_LABELS,
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
  type SoundKind,
  type Voice,
  startVoice,
} from '../../lib/pattern'
import { getProjectToolState, setProjectToolState } from '../../lib/project'
import { encodeWav, type AudioData } from '../../lib/wav'
import { UndoRedoBar, useUndoHistory } from '../../hooks/useUndoHistory'
import { Button, Slider } from '../ui/primitives'
import { ChoiceRow } from '../editor/EditorShell'
import { IconPlay, IconStop } from '../editor/icons'
import { PianoRoll, type ScaleKind, type StampKind } from './PianoRoll'

const PAD_KEYS = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'y', 'x', 'c', 'v']
const ROW_NOTES = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'H4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'H5', 'C6', 'D6']
const PATTERN_SLOTS = ['A', 'B', 'C', 'D'] as const
export type PatternSlotId = (typeof PATTERN_SLOTS)[number]

const SOUND_SHORT: Record<SoundKind, string> = {
  sample: 'C4',
  warm: 'Warm',
  sub808: '808',
  epiano: 'Keys',
  pluck: 'Pluck',
  lead: 'Lead',
}

function makeEmptyPattern(bpm: number): Pattern {
  return {
    steps: 16,
    bpm: Math.round(bpm) || 120,
    swing: 0,
    cells: {},
    notes: {},
    muted: {},
  }
}

export function StepSequencer({
  slices,
  buffers,
  initialBpm,
  choke,
  baseName,
  activeSliceId,
  onSelectSlice,
  onChangeSound,
  onEnsureSlices,
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
  activeSliceId?: string | null
  onSelectSlice?: (id: string) => void
  onChangeSound?: (id: string, sound: SoundKind) => void
  /** Called if the user interacts with the rack before any cuts were made. */
  onEnsureSlices?: () => Slice[]
  /** Plays a pad, optionally transposed — the roll auditions its keys. */
  onPreviewPad: (index: number, semitone?: number) => void
  onBounce: (audio: AudioData, name: string) => void
  /** The start of each row: the pad itself. */
  head: (slice: Slice, row: number) => ReactNode
  /** Beside the rows: the settings of the chosen pad and of the kit. */
  aside?: ReactNode
  /** A line under the title, for what the rows do not show. */
  note?: string
}) {
  const rows = slices.slice(0, PAD_KEYS.length)
  const [patterns, setPatterns] = useState<Record<PatternSlotId, Pattern>>(() => {
    const saved = getProjectToolState<{ patterns?: Record<PatternSlotId, Pattern> }>('sequencer')
    if (saved?.patterns) return saved.patterns
    return {
      A: makeEmptyPattern(initialBpm),
      B: makeEmptyPattern(initialBpm),
      C: makeEmptyPattern(initialBpm),
      D: makeEmptyPattern(initialBpm),
    }
  })
  const [activeSlot, setActiveSlot] = useState<PatternSlotId>(() => {
    const saved = getProjectToolState<{ activeSlot?: PatternSlotId }>('sequencer')
    return saved?.activeSlot ?? 'A'
  })
  const [songChain, setSongChain] = useState<PatternSlotId[]>(() => {
    const saved = getProjectToolState<{ songChain?: PatternSlotId[] }>('sequencer')
    return saved?.songChain && saved.songChain.length > 0 ? saved.songChain : ['A']
  })
  const [songMode, setSongMode] = useState(false)

  const pattern = patterns[activeSlot]

  const undoHistory = useUndoHistory<{
    patterns: Record<PatternSlotId, Pattern>
    activeSlot: PatternSlotId
    songChain: PatternSlotId[]
  }>({ patterns, activeSlot, songChain }, (snap) => {
    setPatterns(snap.patterns)
    setActiveSlot(snap.activeSlot)
    setSongChain(snap.songChain)
  })

  const setPattern = useCallback(
    (updater: Pattern | ((prev: Pattern) => Pattern), recordUndo = true) => {
      if (recordUndo) {
        undoHistory.record({ patterns, activeSlot, songChain })
      }
      setPatterns((prev) => {
        const currentPat = prev[activeSlot]
        const nextPat = typeof updater === 'function' ? updater(currentPat) : updater
        return { ...prev, [activeSlot]: nextPat }
      })
    },
    [activeSlot, patterns, songChain, undoHistory],
  )

  useEffect(() => {
    setProjectToolState('sequencer', { patterns, activeSlot, songChain })
  }, [patterns, activeSlot, songChain])

  useEffect(() => {
    const onProjectLoaded = () => {
      const saved = getProjectToolState<{
        patterns?: Record<PatternSlotId, Pattern>
        activeSlot?: PatternSlotId
        songChain?: PatternSlotId[]
      }>('sequencer')
      if (saved?.patterns) setPatterns(saved.patterns)
      if (saved?.activeSlot) setActiveSlot(saved.activeSlot)
      if (saved?.songChain && saved.songChain.length > 0) setSongChain(saved.songChain)
    }
    window.addEventListener('sondra:project-loaded', onProjectLoaded)
    return () => window.removeEventListener('sondra:project-loaded', onProjectLoaded)
  }, [])

  /** Active rack view: 'pads' (Step Sequencer) or 'roll' (Piano-Roll). */
  const [view, setView] = useState<'pads' | 'roll'>('pads')
  /** The pad whose piano roll is open. */
  const [rollFor, setRollFor] = useState<string | null>(null)
  const [bigRoll, setBigRoll] = useState(false)
  const [scale, setScale] = useState<ScaleKind>('chromatic')
  const [stamp, setStamp] = useState<StampKind>('single')
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState<number | null>(null)
  const [loops, setLoops] = useState(4)
  const [bouncing, setBouncing] = useState(false)

  // The scheduler reads the pattern live, so edits land on the next pass.
  const patternRef = useRef(pattern)
  patternRef.current = pattern
  const patternsRef = useRef(patterns)
  patternsRef.current = patterns
  const songChainRef = useRef(songChain)
  songChainRef.current = songChain
  const songModeRef = useRef(songMode)
  songModeRef.current = songMode
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const chokeRef = useRef(choke)
  chokeRef.current = choke
  const timerRef = useRef<number | null>(null)
  const voicesRef = useRef(new Map<string, Voice>())
  const uiTimers = useRef<number[]>([])

  useEffect(() => {
    if (!initialBpm) return
    setPatterns((prev) => {
      const next = { ...prev }
      for (const slot of PATTERN_SLOTS) {
        if (next[slot].bpm === 120) next[slot] = { ...next[slot], bpm: Math.round(initialBpm) }
      }
      return next
    })
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
    let chainIndex = 0
    let passStart = context.currentTime + 0.06
    setPlaying(true)

    const tick = () => {
      const now = context.currentTime
      const chain = songModeRef.current && songChainRef.current.length > 0 ? songChainRef.current : null
      const activePat = chain ? patternsRef.current[chain[chainIndex % chain.length]] : patternRef.current
      while (true) {
        const at = passStart + stepTime(step, activePat.bpm, activePat.swing)
        if (at > now + 0.12) break
        const hits = patternHits(rowsRef.current, activePat).filter((hit) => hit.step === step)
        for (const hit of hits) {
          if (chokeRef.current || hit.slice.mode === 'loop') voicesRef.current.get(hit.voice)?.stop(at)
          const voice = startVoice(
            context,
            context.destination,
            hit.slice,
            source,
            at,
            hit.slice.mode === 'oneshot' ? undefined : hit.hold,
            hit.velocity,
          )
          voicesRef.current.set(hit.voice, voice)
        }
        const shown = step
        const shownSlot = chain ? chain[chainIndex % chain.length] : null
        uiTimers.current.push(
          window.setTimeout(() => {
            setCurrent(shown)
            if (shownSlot) setActiveSlot(shownSlot)
          }, Math.max(0, (at - now) * 1000)),
        )
        step += 1
        if (step >= activePat.steps) {
          step = 0
          passStart += activePat.steps * stepSeconds(activePat.bpm)
          if (chain) chainIndex = (chainIndex + 1) % chain.length
        }
      }
      if (uiTimers.current.length > 64) uiTimers.current = uiTimers.current.slice(-32)
    }
    tick()
    timerRef.current = window.setInterval(tick, 25)
  }, [buffers])

  useEffect(() => stop, [stop])

  const hasHits = rows.some((slice) =>
    PATTERN_SLOTS.some((slot) => {
      const p = patterns[slot]
      return hasRoll(p, slice.id) ? p.notes[slice.id].length > 0 : p.cells[slice.id]?.some(Boolean)
    }),
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
      if (hasRoll(value, id)) {
        const list = value.notes[id] ?? []
        const exists = list.some((n) => step >= n.step && step < n.step + n.length)
        const nextNotes = exists
          ? list.filter((n) => !(step >= n.step && step < n.step + n.length))
          : [...list, { step, length: 1, semitone: 0, velocity: 0.9 }]
        return { ...value, notes: { ...value.notes, [id]: nextNotes } }
      }
      const row = [...(value.cells[id] ?? Array.from({ length: value.steps }, () => false))]
      row[step] = !row[step]
      return { ...value, cells: { ...value.cells, [id]: row } }
    })

  const setSteps = (steps: number) =>
    setPattern((value) => {
      const cells: Record<string, boolean[]> = {}
      for (const [id, row] of Object.entries(value.cells)) {
        cells[id] = Array.from({ length: steps }, (_, index) => row[index % value.steps] ?? false)
      }
      const notes: Record<string, RollNote[]> = {}
      for (const [id, list] of Object.entries(value.notes)) notes[id] = resizeNotes(list, value.steps, steps)
      return { ...value, steps, cells, notes }
    })

  /** Opens a pad's roll and switches the rack view to Piano-Roll. */
  const openRoll = (id: string, switchView = true) => {
    setPattern(
      (value) => (hasRoll(value, id) ? value : { ...value, notes: { ...value.notes, [id]: cellsToNotes(value.cells[id]) } }),
      false,
    )
    setRollFor(id)
    onSelectSlice?.(id)
    if (switchView) setView('roll')
  }

  /** Back to steps: every note start becomes a step at the pad's pitch. */
  const dropRoll = (id: string) => {
    setPattern((value) => {
      const notes = { ...value.notes }
      const row = Array.from({ length: value.steps }, () => false)
      for (const noteItem of notes[id] ?? []) row[noteItem.step] = true
      delete notes[id]
      return { ...value, notes, cells: { ...value.cells, [id]: row } }
    })
    setRollFor(null)
    setView('pads')
  }

  const setNotes = (id: string, list: RollNote[]) =>
    setPattern((value) => ({ ...value, notes: { ...value.notes, [id]: list } }))

  // Ensure a valid rolled slice when in 'roll' view
  const rolled =
    rows.find((slice) => slice.id === rollFor) ??
    rows.find((slice) => slice.id === activeSliceId) ??
    rows[0] ??
    null
  const rolledIndex = rolled ? rows.indexOf(rolled) : -1

  const switchToRollView = () => {
    let targetRows = rows
    if (targetRows.length === 0 && onEnsureSlices) {
      targetRows = onEnsureSlices()
    }
    const target =
      targetRows.find((s) => s.id === rollFor) ??
      targetRows.find((s) => s.id === activeSliceId) ??
      targetRows[0]
    if (target) {
      openRoll(target.id, true)
    } else {
      setView('roll')
    }
  }

  /** Spice: Melodic Arpeggio / Bassline generator for the open Piano-Roll. */
  const generateMelody = (kind: 'arp' | 'bass' | 'chords') => {
    if (!rolled) return
    const stepsCount = pattern.steps
    let generated: RollNote[] = []
    if (kind === 'arp') {
      const pitches = [0, 3, 7, 12, 7, 3, 0, -5]
      generated = Array.from({ length: Math.floor(stepsCount / 2) }, (_, idx) => ({
        step: idx * 2,
        length: 2,
        semitone: pitches[idx % pitches.length],
        velocity: idx % 2 === 0 ? 0.95 : 0.72,
      }))
    } else if (kind === 'bass') {
      const hits: { step: number; len: number; semi: number; vel: number }[] = [
        { step: 0, len: 3, semi: -12, vel: 1 },
        { step: 3, len: 1, semi: -12, vel: 0.75 },
        { step: 6, len: 2, semi: -9, vel: 0.9 },
        { step: 8, len: 3, semi: -5, vel: 0.95 },
        { step: 12, len: 2, semi: -7, vel: 0.85 },
        { step: 14, len: 2, semi: -5, vel: 0.8 },
      ]
      generated = hits
        .filter((h) => h.step < stepsCount)
        .map((h) => ({ step: h.step, length: h.len, semitone: h.semi, velocity: h.vel }))
    } else {
      // 'chords' — sustained minor 7th progression matching the mockup's look
      const chords = [
        { step: 0, len: 4, notes: [0, 3, 7] },
        { step: 4, len: 4, notes: [-2, 2, 5] },
        { step: 8, len: 4, notes: [-4, 0, 3] },
        { step: 12, len: 4, notes: [-5, -1, 2] },
      ]
      for (const c of chords) {
        if (c.step >= stepsCount) continue
        for (const semi of c.notes) {
          generated.push({ step: c.step, length: Math.min(c.len, stepsCount - c.step), semitone: semi, velocity: 0.88 })
        }
      }
    }
    setNotes(rolled.id, generated)
    onPreviewPad(rolledIndex, generated[0]?.semitone ?? 0)
  }

  const shiftRollOctave = (delta: number) => {
    if (!rolled) return
    const currentNotes = pattern.notes[rolled.id] ?? []
    setNotes(
      rolled.id,
      currentNotes.map((n) => ({ ...n, semitone: Math.max(-12, Math.min(12, n.semitone + delta)) })),
    )
  }

  const bounce = async (target: 'session' | 'file') => {
    const source = buffers()
    if (!source) return
    setBouncing(true)
    try {
      let audio: AudioData
      let name: string
      if (songMode && songChain.length > 1) {
        const parts: AudioData[] = []
        for (const slot of songChain) {
          const partAudio = await bouncePattern(rows, patterns[slot], source, 1, choke)
          parts.push(partAudio)
        }
        audio = concatAudio(parts, 0.005)
        name = `${baseName}-song-${pattern.bpm}bpm.wav`
      } else {
        audio = await bouncePattern(rows, pattern, source, loops, choke)
        name = `${baseName}-pattern-${activeSlot}-${pattern.bpm}bpm.wav`
      }
      if (target === 'file') saveBytes(encodeWav(audio, 24), name, 'audio/wav')
      else onBounce(audio, name)
    } finally {
      setBouncing(false)
    }
  }

  const copyPatternToNextSlot = () => {
    const idx = PATTERN_SLOTS.indexOf(activeSlot)
    const nextSlot = PATTERN_SLOTS[(idx + 1) % PATTERN_SLOTS.length]
    undoHistory.record({ patterns, activeSlot, songChain })
    setPatterns((prev) => ({
      ...prev,
      [nextSlot]: {
        ...prev[activeSlot],
        cells: { ...prev[activeSlot].cells },
        notes: { ...prev[activeSlot].notes },
        muted: { ...prev[activeSlot].muted },
      },
    }))
    setActiveSlot(nextSlot)
  }

  return (
    <section aria-label="Pads und Pattern" className="flex flex-col gap-[12px]">
      {/* Middle 2-column row: Left = Rack (Pads / Piano-Roll), Right = Inspector */}
      <div className="grid gap-[12px] lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Left Card: The Rack */}
        <div className="flex min-w-0 flex-col overflow-hidden rounded-card bg-raised ring-1 ring-inset ring-line">
          {/* Top Bar of the Rack */}
          <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] border-b border-line px-[14px] py-[10px]">
            {/* Left transport + tempo/swing */}
            <div className="flex items-center gap-[10px]">
              <button
                type="button"
                onClick={() => (playing ? stop() : void play())}
                disabled={!hasHits && !playing}
                aria-label={playing ? 'Pattern anhalten (Leertaste)' : 'Pattern abspielen (Leertaste)'}
                title={playing ? 'Anhalten (Leertaste)' : hasHits ? 'Abspielen (Leertaste)' : 'Erst ein paar Felder setzen'}
                className="press inline-flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-pill bg-ink text-on-ink hover:bg-ink-hover disabled:opacity-40"
              >
                {playing ? IconStop : IconPlay}
              </button>
              <div className="w-[122px]">
                <Slider
                  label="Tempo"
                  display={`${pattern.bpm} BPM`}
                  min={60}
                  max={200}
                  step={1}
                  value={pattern.bpm}
                  onChange={(event) => setPattern((value) => ({ ...value, bpm: Number(event.target.value) }), false)}
                />
              </div>
              <div className="hidden w-[104px] sm:block">
                <Slider
                  label="Swing"
                  display={`${Math.round(pattern.swing * 100)} %`}
                  min={0}
                  max={0.6}
                  step={0.01}
                  value={pattern.swing}
                  onChange={(event) => setPattern((value) => ({ ...value, swing: Number(event.target.value) }), false)}
                />
              </div>
              {/* Pattern Slots A / B / C / D */}
              <div className="flex items-center gap-[2px] rounded-nav bg-panel-soft p-[2px] ring-1 ring-inset ring-line" role="group" aria-label="Pattern-Auswahl">
                {PATTERN_SLOTS.map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    aria-pressed={activeSlot === slot}
                    onClick={() => setActiveSlot(slot)}
                    title={`Pattern ${slot}`}
                    className={`press value h-[26px] w-[26px] rounded-[6px] text-micro font-bold transition-colors ${
                      activeSlot === slot ? 'bg-ink text-on-ink' : 'text-prose hover:bg-panel-mid hover:text-ink'
                    }`}
                  >
                    {slot}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={copyPatternToNextSlot}
                  title="Aktuelles Pattern in den nächsten Slot kopieren"
                  className="press rounded-[6px] px-[6px] py-[3px] text-micro text-muted hover:bg-panel-mid hover:text-ink"
                >
                  Kopieren
                </button>
              </div>
            </div>

            {/* Center View Switcher: [ Pads ] | [ Piano-Roll ] */}
            <div
              role="group"
              aria-label="Ansicht wechseln"
              className="mx-auto flex items-center gap-[4px] rounded-nav bg-panel-soft p-[3px] ring-1 ring-inset ring-line"
            >
              <button
                type="button"
                aria-pressed={view === 'pads'}
                onClick={() => setView('pads')}
                className={`press rounded-[7px] px-[12px] py-[5px] text-small font-semibold transition-colors ${
                  view === 'pads' ? 'bg-ink text-on-ink' : 'text-prose hover:bg-panel-mid hover:text-ink'
                }`}
              >
                [ Pads ]
              </button>
              <button
                type="button"
                aria-pressed={view === 'roll'}
                onClick={switchToRollView}
                className={`press rounded-[7px] px-[12px] py-[5px] text-small font-semibold transition-colors ${
                  view === 'roll' ? 'bg-ink text-on-ink' : 'text-prose hover:bg-panel-mid hover:text-ink'
                }`}
              >
                [ Piano-Roll ]
              </button>
            </div>

            {/* Right Controls depending on active view */}
            <div className="ml-auto flex flex-wrap items-center gap-[6px]">
              <UndoRedoBar
                canUndo={undoHistory.canUndo}
                canRedo={undoHistory.canRedo}
                onUndo={undoHistory.undo}
                onRedo={undoHistory.redo}
              />
              {view === 'pads' ? (
                <>
                  <ChoiceRow
                    value={pattern.steps}
                    onChange={setSteps}
                    options={[
                      { value: 16, label: '1 Takt', title: '16 Schritte' },
                      { value: 32, label: '2 Takte', title: '32 Schritte' },
                    ]}
                  />
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      const activeRows = rows.length > 0 ? rows : (onEnsureSlices?.() ?? [])
                      if (activeRows.length > 0) {
                        setPattern((value) => ({ ...value, cells: starterPattern(activeRows, value.steps) }))
                      }
                    }}
                  >
                    Grundbeat vorschlagen
                  </Button>
                  {hasHits ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setPattern((value) => ({
                          ...value,
                          cells: {},
                          notes: Object.fromEntries(Object.keys(value.notes).map((id) => [id, []])),
                        }))
                      }
                    >
                      Leeren
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  <Button size="sm" variant="quiet" onClick={() => setBigRoll((value) => !value)}>
                    {bigRoll ? 'Kleiner' : 'Größer'}
                  </Button>
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      if (rolled) setNotes(rolled.id, [])
                    }}
                  >
                    Töne leeren
                  </Button>
                  {rolled ? (
                    <Button size="sm" variant="ghost" onClick={() => dropRoll(rolled.id)} title="Noten zurück in Step-Schritte wandeln">
                      Zu Schritten
                    </Button>
                  ) : null}
                  <Button size="sm" variant="quiet" onClick={() => setView('pads')}>
                    Schließen
                  </Button>
                </>
              )}
            </div>
          </div>

          {note ? (
            <div className="border-b border-line bg-panel-soft/50 px-[14px] py-[6px] text-micro text-prose">{note}</div>
          ) : null}

          {/* RACK BODY: Either [ Pads ] Step Grid OR [ Piano-Roll ] */}
          {view === 'pads' ? (
            <div className="flex flex-1 flex-col overflow-x-auto px-[14px] py-[12px]">
              {rows.length === 0 ? (
                <div className="flex flex-col gap-[10px]">
                  <div className="flex flex-wrap items-center justify-between gap-[8px] rounded-nav bg-panel-soft px-[12px] py-[8px] ring-1 ring-inset ring-line">
                    <span className="text-small text-prose">
                      Selber schneiden ist aktiv — oben in die Welle klicken/ziehen oder direkt Pads anlegen:
                    </span>
                    <div className="flex items-center gap-[6px]">
                      {onEnsureSlices ? (
                        <Button size="sm" onClick={() => onEnsureSlices()}>
                          Pads jetzt anlegen
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {/* Ready Pad Slots preview */}
                  <div className="flex min-w-full flex-col gap-[4px] opacity-75">
                    {PAD_KEYS.slice(0, 6).map((key, row) => (
                      <div key={key} className="flex w-full items-center gap-[4px]">
                        <button
                          type="button"
                          onClick={() => onEnsureSlices?.()}
                          className="press flex h-[34px] w-[152px] shrink-0 items-center gap-[8px] rounded-nav bg-panel-soft px-[8px] text-left text-ink ring-1 ring-inset ring-line hover:bg-panel-mid"
                        >
                          <span className="value w-[1.1em] shrink-0 text-small font-bold leading-none">{key.toUpperCase()}</span>
                          <span className="flex-1 truncate text-micro text-muted">Pad {row + 1} bereit</span>
                          <span className="value text-micro text-muted">—</span>
                        </button>
                        <span className="grid h-[34px] w-[28px] shrink-0 place-items-center rounded-nav bg-panel-soft text-micro font-semibold text-muted ring-1 ring-inset ring-line">
                          M
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const created = onEnsureSlices?.() ?? []
                            if (created[row]) openRoll(created[row].id, true)
                          }}
                          title="In Piano-Roll wechseln"
                          className="press grid h-[34px] w-[28px] shrink-0 place-items-center rounded-nav bg-panel-soft text-micro font-bold text-ink ring-1 ring-inset ring-line hover:bg-ink hover:text-on-ink"
                        >
                          &gt;
                        </button>
                        <div className="flex flex-1 gap-[3px]">
                          {Array.from({ length: pattern.steps }, (_, step) => {
                            const beat = Math.floor(step / 4) % 2 === 0
                            return (
                              <button
                                key={step}
                                type="button"
                                onClick={() => onEnsureSlices?.()}
                                aria-label={`Pad ${row + 1}, Schritt ${step + 1}`}
                                className={`h-[34px] min-w-[26px] flex-1 rounded-[5px] ring-1 ring-inset ring-line/60 ${
                                  step % 4 === 0 && step > 0 ? 'ml-[6px]' : ''
                                } ${beat ? 'bg-panel-mid/70 hover:bg-ink/25' : 'bg-panel-soft hover:bg-ink/20'}`}
                              />
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-1 min-w-full flex-col justify-between gap-[4px]">
                  {rows.map((slice, row) => {
                    const muted = Boolean(pattern.muted[slice.id])
                    const cells = pattern.cells[slice.id] ?? []
                    const rolledNotes = pattern.notes[slice.id]
                    const isRolled = hasRoll(pattern, slice.id)
                    return (
                      <div key={slice.id} className="flex w-full items-center gap-[4px]">
                        <div className="sticky left-0 z-[1] flex shrink-0 items-center gap-[4px] bg-raised pr-[4px]">
                          {head(slice, row)}
                          <button
                            type="button"
                            aria-pressed={muted}
                            aria-label={`Pad ${row + 1} stumm`}
                            title={muted ? 'Stumm — klicken zum Einschalten' : 'Stummschalten'}
                            onClick={() => setPattern((value) => ({ ...value, muted: { ...value.muted, [slice.id]: !muted } }))}
                            className={`press h-[34px] w-[28px] shrink-0 rounded-nav text-micro font-semibold ring-1 ring-inset ring-line ${
                              muted ? 'bg-ink text-on-ink' : 'bg-panel-soft text-prose hover:bg-panel-mid hover:text-ink'
                            }`}
                          >
                            M
                          </button>
                          {/* Button right next to Mute: automatically switches to Piano-Roll for this pad! */}
                          <button
                            type="button"
                            aria-pressed={rollFor === slice.id}
                            aria-label={`Klavierrolle für Pad ${row + 1}`}
                            title="Wechselt automatisch in die Piano-Roll für dieses Pad"
                            onClick={() => openRoll(slice.id, true)}
                            className={`press grid h-[34px] w-[28px] shrink-0 place-items-center rounded-nav text-small font-bold ring-1 ring-inset ring-line transition-colors ${
                              isRolled && (rolledNotes?.length ?? 0) > 0
                                ? 'bg-ink text-on-ink'
                                : 'bg-panel-soft text-ink hover:bg-ink hover:text-on-ink'
                            }`}
                          >
                            &gt;
                          </button>
                        </div>
                        <div className={`flex flex-1 items-center ${muted ? 'opacity-45' : ''}`}>
                          <div className="flex w-full gap-[3px]">
                            {Array.from({ length: pattern.steps }, (_, step) => {
                              const noteAtStep = isRolled
                                ? (rolledNotes ?? []).find((n) => step >= n.step && step < n.step + n.length)
                                : undefined
                              const on = isRolled ? Boolean(noteAtStep) : Boolean(cells[step])
                              const beat = Math.floor(step / 4) % 2 === 0
                              const here = current === step
                              return (
                                <button
                                  key={step}
                                  type="button"
                                  aria-pressed={on}
                                  aria-label={`Pad ${row + 1}, Schritt ${step + 1}`}
                                  onClick={() => toggleCell(slice.id, step)}
                                  className={`relative h-[34px] min-w-[26px] flex-1 rounded-[5px] transition-colors ${
                                    step % 4 === 0 && step > 0 ? 'ml-[6px]' : ''
                                  } ${
                                    on
                                      ? 'bg-ink text-on-ink'
                                      : beat
                                        ? 'bg-panel-mid/80 ring-1 ring-inset ring-line/60 hover:bg-ink/35'
                                        : 'bg-panel-soft ring-1 ring-inset ring-line/60 hover:bg-ink/25'
                                  } ${here ? 'ring-2 ring-ink ring-offset-1 ring-offset-canvas' : ''}`}
                                >
                                  {noteAtStep && noteAtStep.semitone !== 0 ? (
                                    <span className="value pointer-events-none text-[9px] font-bold leading-none text-on-ink">
                                      {noteAtStep.semitone > 0 ? `+${noteAtStep.semitone}` : noteAtStep.semitone}
                                    </span>
                                  ) : null}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ) : (
            /* PIANO-ROLL VIEW */
            <div className="flex flex-1 flex-col">
              {/* Piano-Roll Sound Switcher & Spice Bar */}
              <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] border-b border-line bg-panel-soft/60 px-[14px] py-[8px]">
                <div className="flex flex-wrap items-center gap-[4px]">
                  <span className="mr-[4px] text-micro font-semibold text-prose">Sound:</span>
                  {(Object.keys(SOUND_LABELS) as SoundKind[]).map((soundKey) => {
                    const activeSound = (rolled?.sound ?? 'sample') === soundKey
                    return (
                      <button
                        key={soundKey}
                        type="button"
                        aria-pressed={activeSound}
                        onClick={() => {
                          if (!rolled) return
                          onChangeSound?.(rolled.id, soundKey)
                          setTimeout(() => onPreviewPad(rolledIndex, 0), 20)
                        }}
                        className={`press rounded-nav px-[8px] py-[4px] text-micro font-semibold transition-colors ${
                          activeSound
                            ? 'bg-ink text-on-ink'
                            : 'bg-raised text-prose ring-1 ring-inset ring-line hover:bg-panel-mid hover:text-ink'
                        }`}
                      >
                        {SOUND_LABELS[soundKey]}
                      </button>
                    )
                  })}
                </div>

                {/* Spice: Scale lock, Chord stamp, and Arpeggio / Octave helpers */}
                <div className="ml-auto flex flex-wrap items-center gap-[6px]">
                  <div className="flex items-center gap-[3px] rounded-nav bg-raised p-[2px] ring-1 ring-inset ring-line">
                    <span className="px-[6px] text-micro text-muted">Skala</span>
                    {(
                      [
                        { id: 'chromatic', label: 'Alle' },
                        { id: 'minor', label: 'Moll' },
                        { id: 'major', label: 'Dur' },
                        { id: 'pentatonic', label: 'Penta' },
                        { id: 'blues', label: 'Blues' },
                      ] as const
                    ).map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setScale(s.id)}
                        className={`press rounded-[6px] px-[6px] py-[3px] text-micro font-semibold ${
                          scale === s.id ? 'bg-ink text-on-ink' : 'text-prose hover:bg-panel-soft'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-[3px] rounded-nav bg-raised p-[2px] ring-1 ring-inset ring-line">
                    <span className="px-[6px] text-micro text-muted">Stempel</span>
                    {(
                      [
                        { id: 'single', label: '1 Ton' },
                        { id: 'minor', label: 'm-Akkord' },
                        { id: 'major', label: 'Dur-Akkord' },
                        { id: 'octave', label: 'Oktave' },
                      ] as const
                    ).map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => setStamp(st.id)}
                        className={`press rounded-[6px] px-[6px] py-[3px] text-micro font-semibold ${
                          stamp === st.id ? 'bg-ink text-on-ink' : 'text-prose hover:bg-panel-soft'
                        }`}
                      >
                        {st.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-[3px]">
                    <button
                      type="button"
                      onClick={() => generateMelody('chords')}
                      title="Akkordfolge in die Piano-Roll zeichnen"
                      className="press rounded-nav bg-raised px-[8px] py-[4px] text-micro font-semibold text-ink ring-1 ring-inset ring-line hover:bg-panel-mid"
                    >
                      + Akkorde
                    </button>
                    <button
                      type="button"
                      onClick={() => generateMelody('arp')}
                      title="Arpeggio-Melodie erzeugen"
                      className="press rounded-nav bg-raised px-[8px] py-[4px] text-micro font-semibold text-ink ring-1 ring-inset ring-line hover:bg-panel-mid"
                    >
                      + Arpeggio
                    </button>
                    <button
                      type="button"
                      onClick={() => shiftRollOctave(-12)}
                      title="Eine Oktave tiefer"
                      className="press value rounded-nav bg-raised px-[6px] py-[4px] text-micro text-ink ring-1 ring-inset ring-line hover:bg-panel-mid"
                    >
                      −12
                    </button>
                    <button
                      type="button"
                      onClick={() => shiftRollOctave(12)}
                      title="Eine Oktave höher"
                      className="press value rounded-nav bg-raised px-[6px] py-[4px] text-micro text-ink ring-1 ring-inset ring-line hover:bg-panel-mid"
                    >
                      +12
                    </button>
                  </div>
                </div>
              </div>

              {/* 2-Column Piano-Roll Workspace: Left = Pad/Sound Channel Switcher, Right = PianoRoll Grid */}
              <div className="flex flex-1 min-h-[290px]">
                {/* Left Column: Pad & Sound Channel List (matches C4 Pad 1 [C4] M > in reference image) */}
                <div
                  className="flex w-[212px] shrink-0 flex-col justify-between gap-[4px] border-r border-line bg-raised p-[10px]"
                  aria-label="Sound und Pad in der Piano-Roll wechseln"
                >
                  {rows.map((slice, row) => {
                    const isCurrent = rolled?.id === slice.id
                    const muted = Boolean(pattern.muted[slice.id])
                    const noteCount = pattern.notes[slice.id]?.length ?? 0
                    const soundBadge = SOUND_SHORT[slice.sound ?? 'sample']
                    const pitchLabel = ROW_NOTES[row] ?? 'C4'
                    return (
                      <div key={slice.id} className="flex flex-1 min-h-[32px] items-center gap-[4px]">
                        <button
                          type="button"
                          aria-pressed={isCurrent}
                          onClick={() => {
                            openRoll(slice.id, false)
                            onPreviewPad(row, 0)
                          }}
                          className={`press flex h-full min-h-[32px] min-w-0 flex-1 items-center gap-[6px] rounded-nav px-[8px] text-left text-micro transition-colors ${
                            isCurrent
                              ? 'bg-ink font-semibold text-on-ink'
                              : 'bg-panel-soft text-ink ring-1 ring-inset ring-line hover:bg-panel-mid'
                          }`}
                        >
                          <span className="value w-[2.1em] shrink-0 font-bold opacity-85">{pitchLabel}</span>
                          <span className="truncate">
                            Pad {row + 1} [{soundBadge}]
                          </span>
                          {noteCount > 0 ? (
                            <span
                              className={`value ml-auto shrink-0 rounded-pill px-[5px] py-[1px] text-[10px] ${
                                isCurrent ? 'bg-on-ink/20 text-on-ink' : 'bg-panel-strong text-ink'
                              }`}
                            >
                              {noteCount}
                            </span>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          aria-pressed={muted}
                          aria-label={`Pad ${row + 1} stumm`}
                          onClick={() => setPattern((value) => ({ ...value, muted: { ...value.muted, [slice.id]: !muted } }))}
                          className={`press h-full min-h-[32px] w-[26px] shrink-0 rounded-nav text-micro font-semibold ring-1 ring-inset ring-line ${
                            muted ? 'bg-ink text-on-ink' : 'bg-panel-soft text-prose hover:bg-panel-mid hover:text-ink'
                          }`}
                        >
                          M
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            openRoll(slice.id, false)
                            onPreviewPad(row, 0)
                          }}
                          title={`Pad ${row + 1} anhören und wählen`}
                          className={`press grid h-full min-h-[32px] w-[26px] shrink-0 place-items-center rounded-nav text-micro font-bold ring-1 ring-inset ring-line ${
                            isCurrent ? 'bg-ink text-on-ink' : 'bg-panel-soft text-ink hover:bg-panel-mid'
                          }`}
                        >
                          &gt;
                        </button>
                      </div>
                    )
                  })}
                </div>

                {/* Right Column: Interactive Piano-Roll */}
                <div className="flex min-w-0 flex-1 flex-col">
                  {rolled ? (
                    <PianoRoll
                      notes={pattern.notes[rolled.id] ?? []}
                      steps={pattern.steps}
                      current={current}
                      big={bigRoll}
                      scale={scale}
                      stamp={stamp}
                      onChange={(list) => setNotes(rolled.id, list)}
                      onAudition={(semitone) => onPreviewPad(rolledIndex, semitone)}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center p-[24px] text-small text-muted">
                      Bitte zuerst ein Pad anlegen, um Töne in der Piano-Roll zu setzen.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Card: Inspector (Pad | Alle Pads | Export | Vorgaben) */}
        {aside ? (
          <div className="flex min-w-0 flex-col overflow-hidden rounded-card bg-raised ring-1 ring-inset ring-line">
            {aside}
          </div>
        ) : null}
      </div>

      {/* Bottom Full-Width Card: Song-Arrangement & Ausgabe */}
      <footer className="flex flex-col gap-[8px] rounded-card bg-raised px-[16px] py-[10px] ring-1 ring-inset ring-line">
        <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px] border-b border-line pb-[8px]">
          <span className="text-micro font-semibold text-ink">Arrangement</span>
          <div className="flex items-center gap-[2px] rounded-nav bg-panel-soft p-[2px] ring-1 ring-inset ring-line">
            <button
              type="button"
              aria-pressed={!songMode}
              onClick={() => setSongMode(false)}
              className={`press rounded-[6px] px-[8px] py-[3px] text-micro font-semibold ${
                !songMode ? 'bg-ink text-on-ink' : 'text-prose hover:bg-panel-mid'
              }`}
            >
              Einzelnes Pattern ({activeSlot})
            </button>
            <button
              type="button"
              aria-pressed={songMode}
              onClick={() => setSongMode(true)}
              className={`press rounded-[6px] px-[8px] py-[3px] text-micro font-semibold ${
                songMode ? 'bg-ink text-on-ink' : 'text-prose hover:bg-panel-mid'
              }`}
            >
              Song-Kette ({songChain.length} Takte)
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-[4px]" aria-label="Song-Kette">
            {songChain.map((slot, idx) => (
              <button
                key={`${slot}-${idx}`}
                type="button"
                onClick={() => {
                  if (songChain.length <= 1) return
                  undoHistory.record({ patterns, activeSlot, songChain })
                  setSongChain((prev) => prev.filter((_, i) => i !== idx))
                }}
                title={`Block ${idx + 1}: Pattern ${slot} (klicken zum Entfernen)`}
                className="press value inline-flex h-[24px] items-center gap-[3px] rounded-[6px] bg-panel-mid px-[7px] text-micro font-bold text-ink ring-1 ring-inset ring-line hover:bg-panel-strong"
              >
                <span>{slot}</span>
                {songChain.length > 1 ? <span className="text-[10px] opacity-60">×</span> : null}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-[3px]">
            <span className="mr-[2px] text-micro text-muted">Anhängen:</span>
            {PATTERN_SLOTS.map((slot) => (
              <button
                key={slot}
                type="button"
                onClick={() => {
                  undoHistory.record({ patterns, activeSlot, songChain })
                  setSongChain((prev) => [...prev, slot])
                  setSongMode(true)
                }}
                title={`Pattern ${slot} an die Song-Kette anhängen`}
                className="press value h-[24px] rounded-[6px] bg-panel-soft px-[7px] text-micro font-semibold text-ink ring-1 ring-inset ring-line hover:bg-panel-mid"
              >
                +{slot}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
          <span className="text-small font-semibold text-ink">Ausgabe</span>
          {!songMode ? (
            <ChoiceRow
              value={loops}
              onChange={setLoops}
              options={[1, 2, 3, 4, 8].map((value) => ({ value, label: `${value}×`, title: `${value}× durchspielen` }))}
            />
          ) : (
            <span className="value text-micro text-prose">Kette: {songChain.join(' → ')}</span>
          )}
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
          <span className="ml-auto text-small text-muted">Nahtlos loopbar.</span>
        </div>
      </footer>
    </section>
  )
}
