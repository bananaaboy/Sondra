/**
 * Sample chopper.
 *
 * Three ways to cut, because material differs: on transients for a break, on a
 * tempo grid for anything with a pulse, and in equal parts when you just want
 * sixteen of them. The grid comes from an autocorrelation tempo estimate, and
 * because half- and double-time are the same grid musically, the tempo is
 * adjustable by ear with ×2 and ÷2.
 *
 * Cuts snap to a rising zero crossing. A cut mid-waveform leaves a step, and a
 * step is a click — fades hide it but cost the attack, which is the one part of
 * a chop you cannot afford to soften.
 *
 * Pads are triggered from the keyboard and carry their own pitch, level and
 * direction, so a kit can be tuned pad by pad rather than all at once.
 * Playback uses the Web Audio graph directly rather than Wavesurfer, so a pad
 * can be retriggered while the previous one still rings.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region } from 'wavesurfer.js/plugins/regions'
import TimelinePlugin from 'wavesurfer.js/plugins/timeline'

import {
  applyFades,
  getAudioContext,
  normalizePeak,
  resumeAudioContext,
  reverseAudio,
  sliceAudio,
  toAudioBuffer,
} from '../../lib/audio'
import { saveBytes } from '../../lib/download'
import { clamp, dbToGain, formatTimecode } from '../../lib/format'
import { DEFAULT_CHOP, MAX_PLANNED, describeMethod, planChop, type ChopMethod, type ChopPlan, type ChopSettings } from '../../lib/chop'
import { estimateTempo, snapToZeroCrossing, type TempoEstimate } from '../../lib/tempo'
import { withAlpha, type ResolvedTheme } from '../../lib/theme'
import { encodeWav, type AudioData } from '../../lib/wav'
import { renderSliceInWorker } from '../../lib/workerClient'
import { SLICE_DEFAULTS, startVoice, type PlayMode, type Slice, type Voice } from '../../lib/pattern'
import { StepSequencer } from './StepSequencer'
import { createZip } from '../../lib/zip'
import { createCueSheet, createAudacityLabels } from '../../lib/cueExport'
import { connectWebMidi, type MidiAccessSubscription } from '../../lib/midi'
import { useDecodedAudio } from '../../hooks/useDecodedAudio'
import { useActiveAsset, useSession } from '../../state/store'
import { AudioPreview } from '../AudioPreview'
import { FileDrop } from '../FileDrop'
import { ChoiceRow, IconButton } from '../editor/EditorShell'
import { IconPause, IconPlay, IconStop, IconZoomIn, IconZoomOut } from '../editor/icons'
import { ArrowRight, Button, Card, Progress, Slider, Toggle } from '../ui/primitives'


/** Four rows of four, in the order they sit on the keyboard. */
const PAD_KEYS = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'y', 'x', 'c', 'v']
const MAX_PADS = 16

/**
 * The slice, drawn small enough to fit on its own pad.
 *
 * Sixteen identical squares labelled with a key and a duration tell you
 * nothing about which one holds the snare. Twenty-odd peak values do, and they
 * cost one pass over a quarter-second of samples.
 */
function PadWave({ audio, from, to, className = 'h-[26px] w-full' }: { audio: AudioData; from: number; to: number; className?: string }) {
  const peaks = useMemo(() => {
    const mono = audio.channels[0]
    const start = Math.max(0, Math.floor(from * audio.sampleRate))
    const end = Math.min(mono.length, Math.ceil(to * audio.sampleRate))
    const buckets = 22
    const width = Math.max(1, Math.floor((end - start) / buckets))
    const values: number[] = []
    for (let b = 0; b < buckets; b += 1) {
      let peak = 0
      const at = start + b * width
      for (let i = at; i < Math.min(at + width, end); i += 1) peak = Math.max(peak, Math.abs(mono[i]))
      values.push(peak)
    }
    const loudest = Math.max(...values, 0.001)
    return values.map((value) => value / loudest)
  }, [audio, from, to])

  return (
    <svg viewBox="0 0 22 10" preserveAspectRatio="none" className={className} aria-hidden>
      {peaks.map((value, index) => (
        <rect
          key={index}
          x={index + 0.18}
          y={5 - Math.max(0.35, value * 4.6)}
          width={0.64}
          height={Math.max(0.7, value * 9.2)}
          rx={0.3}
          fill="currentColor"
          opacity={0.75}
        />
      ))}
    </svg>
  )
}

/** Slice lengths in beats. The thirds are triplets: three in the time of two. */
const GRID_DIVISIONS: { value: number; label: string }[] = [
  { value: 0.125, label: '1/32' },
  { value: 0.25, label: '1/16' },
  { value: 1 / 3, label: '1/8 T' },
  { value: 0.5, label: '1/8' },
  { value: 2 / 3, label: '1/4 T' },
  { value: 1, label: '1/4' },
  { value: 2, label: '1/2' },
  { value: 4, label: '1 Takt' },
  { value: 8, label: '2 Takte' },
]

const MODE_LABELS: Record<PlayMode, string> = {
  oneshot: 'One-Shot',
  gate: 'Gate (Taste halten)',
  loop: 'Schleife',
}

const MODE_SHORT: Record<PlayMode, string> = { oneshot: 'One-Shot', gate: 'Gate', loop: 'Schleife' }

/** How a file is cut. One at a time on screen, with only its own settings. */
const METHODS: { value: ChopMethod; label: string; title: string }[] = [
  { value: 'hits', label: 'Anschläge', title: 'An jedem Lautstärkesprung — meistens die beste Wahl' },
  { value: 'auto', label: 'Stärkste', title: 'Nur die stärksten Schläge, so viele wie gewünscht' },
  { value: 'grid', label: 'Takt', title: 'Auf dem Raster des Tempos, auch in Triolen' },
  { value: 'silence', label: 'Pausen', title: 'Zwischen den Pausen — für Sprache, Gesang, einzelne Klänge' },
  { value: 'even', label: 'Gleich', title: 'In gleich viele Teile' },
  { value: 'length', label: 'Länge', title: 'In Teile fester Länge' },
]

/** The planned cuts, drawn on the stage before anything is cut. */
const isPlanMark = (id: string) => id.startsWith('plan-')

/** The column beside the pads: one job at a time, like the editors' inspector. */
type Side = 'pad' | 'kit' | 'export' | 'vorgaben'

/**
 * The stage is neutral dark in both themes, so its colours are fixed rather
 * than read from the theme: the signal in the stage accent, everything else
 * in the stage's own ink.
 */
const STAGE_ACCENT = '#8fe0a6'
const STAGE_INK = '#eef1f0'
const STAGE_MUTED = '#aab5b2'
const SLICE_COLOR = withAlpha(STAGE_INK, 0.05)
const ACTIVE_COLOR = withAlpha(STAGE_ACCENT, 0.2)
const PENDING_COLOR = withAlpha(STAGE_INK, 0.2)
const PLAN_COLOR = withAlpha(STAGE_ACCENT, 0.85)

// The theme is still handed in by the dashboard; the stage ignores it on purpose.
export function SamplerPanel(_props: { theme: ResolvedTheme }) {
  const asset = useActiveAsset()
  const addAsset = useSession((state) => state.addAsset)
  const setActiveAsset = useSession((state) => state.setActiveAsset)
  const log = useSession((state) => state.log)
  const { audio, decode, status } = useDecodedAudio(asset)

  const containerRef = useRef<HTMLDivElement>(null)
  const waveRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null)
  const bufferRef = useRef<AudioBuffer | null>(null)
  /** Built once so a reversed pad can play without re-rendering anything. */
  const reversedRef = useRef<AudioBuffer | null>(null)
  /** Live voices per pad, for choking and for gate release. */
  const voicesRef = useRef(new Map<number, Voice[]>())
  /** Set below; the wavesurfer effect is created before `triggerPad` exists. */
  const triggerRef = useRef<((sliceId: string) => void) | null>(null)

  const [slices, setSlices] = useState<Slice[]>([])
  /**
   * A range dragged on the waveform that is not a pad yet. It becomes one
   * only when confirmed — a stray drag used to leave a pad behind.
   */
  const [pending, setPending] = useState<{ id: string; start: number; end: number } | null>(null)
  const pendingRef = useRef<string | null>(null)
  /** True while the chop buttons lay out regions, which are pads at once. */
  const cuttingRef = useRef(false)
  const [wavePlaying, setWavePlaying] = useState(false)
  const [activeSlice, setActiveSlice] = useState<string | null>(null)
  const [playing, setPlaying] = useState<number[]>([])

  // Defaults a freshly cut slice inherits.
  const [defaultMode, setDefaultMode] = useState<PlayMode>('oneshot')
  const [choke, setChoke] = useState(true)
  const [fadeMs, setFadeMs] = useState(4)
  const [normalize, setNormalize] = useState(false)
  const [preserveDuration, setPreserveDuration] = useState(true)

  const [tempo, setTempo] = useState<TempoEstimate | null>(null)
  const [bpm, setBpm] = useState(120)
  const [zoom, setZoom] = useState(0)
  /** How to cut, for every method at once — switching method keeps the rest. */
  const [chop, setChopState] = useState<ChopSettings>(DEFAULT_CHOP)
  /** Whether the planned cuts are drawn: from the first change until they are made. */
  const [planShown, setPlanShown] = useState(true)
  const setChop = (patch: Partial<ChopSettings>) => {
    setChopState((value) => ({ ...value, ...patch }))
    setPlanShown(true)
  }
  /** Re-reads the regions into the pads; set by the wavesurfer effect. */
  const syncRef = useRef<(() => void) | null>(null)
  const [side, setSide] = useState<Side>('pad')
  /** Wavesurfer rejects most calls until it has decoded the audio. */
  const [waveReady, setWaveReady] = useState(false)

  const [rendering, setRendering] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  /** The selected pad rendered exactly as it would export. */
  const [rendered, setRendered] = useState<{ id: string; audio: AudioData } | null>(null)
  /** Detected USB MIDI controllers and keyboards */
  const [midiDevices, setMidiDevices] = useState<string[]>([])

  useEffect(() => {
    if (asset && !audio && status === 'idle') void decode()
  }, [asset, audio, status, decode])

  const duration = audio ? (audio.channels[0]?.length ?? 0) / audio.sampleRate : 0

  /* --- tempo -------------------------------------------------------------- */
  useEffect(() => {
    if (!audio) {
      setTempo(null)
      return
    }
    // Analysis is fast enough to run inline, and the result is needed before
    // the user can choose a grid.
    const estimate = estimateTempo(audio)
    setTempo(estimate)
    setBpm(estimate.bpm)
    log('sampler', `Tempo geschätzt: ${estimate.bpm} BPM (Sicherheit ${Math.round(estimate.confidence * 100)} %)`)
  }, [audio, log])

  /* --- wavesurfer --------------------------------------------------------- */
  useEffect(() => {
    const container = containerRef.current
    if (!container || !audio) return

    const regions = RegionsPlugin.create()
    const timeline = TimelinePlugin.create({
      height: 22,
      insertPosition: 'beforebegin',
      style: { color: STAGE_MUTED, fontSize: '11px', fontFamily: "'Courier Prime', ui-monospace, monospace" },
      secondaryLabelOpacity: 0.6,
    })
    const wave = WaveSurfer.create({
      container,
      height: 196,
      waveColor: withAlpha(STAGE_ACCENT, 0.5),
      progressColor: STAGE_ACCENT,
      cursorColor: STAGE_INK,
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      plugins: [regions, timeline],
    })

    waveRef.current = wave
    regionsRef.current = regions
    setWaveReady(false)
    wave.on('ready', () => setWaveReady(true))

    const context = getAudioContext()
    bufferRef.current = toAudioBuffer(audio, context)
    reversedRef.current = toAudioBuffer(reverseAudio(audio), context)
    wave.loadBlob(new Blob([encodeWav(audio, 16).slice().buffer], { type: 'audio/wav' }))

    regions.enableDragSelection({ color: PENDING_COLOR })

    const sync = () => {
      setSlices((current) => {
        const previous = new Map(current.map((slice) => [slice.id, slice]))
        return regions
          .getRegions()
          .filter((region) => region.id !== pendingRef.current && !isPlanMark(region.id))
          .map((region) => {
            const existing = previous.get(region.id)
            // Dragging a region must not reset the pad's own settings.
            return existing
              ? { ...existing, start: region.start, end: region.end }
              : {
                  ...SLICE_DEFAULTS,
                  id: region.id,
                  start: region.start,
                  end: region.end,
                  mode: defaultMode,
                }
          })
          .sort((a, b) => a.start - b.start)
      })
    }

    syncRef.current = sync

    const pendingColor = PENDING_COLOR
    regions.on('region-created', (region: Region) => {
      if (isPlanMark(region.id)) return
      if (!cuttingRef.current) {
        // Dragged by hand: held back until „Als Pad anlegen“. A new drag
        // replaces the previous one that was never confirmed.
        const previous = pendingRef.current
        if (previous) regions.getRegions().find((entry) => entry.id === previous)?.remove()
        pendingRef.current = region.id
        region.setOptions({ color: pendingColor, start: region.start, end: region.end })
        setPending({ id: region.id, start: region.start, end: region.end })
        return
      }
      sync()
    })
    regions.on('region-updated', (region: Region) => {
      if (isPlanMark(region.id)) return
      if (region.id === pendingRef.current) setPending({ id: region.id, start: region.start, end: region.end })
      else sync()
    })
    regions.on('region-removed', (region: Region) => {
      if (isPlanMark(region.id)) return
      if (region.id === pendingRef.current) {
        pendingRef.current = null
        setPending(null)
      } else {
        sync()
      }
    })
    wave.on('play', () => setWavePlaying(true))
    wave.on('pause', () => setWavePlaying(false))
    wave.on('finish', () => setWavePlaying(false))
    regions.on('region-clicked', (region: Region, event: MouseEvent) => {
      event.stopPropagation()
      if (isPlanMark(region.id)) return
      if (region.id === pendingRef.current) {
        triggerRef.current?.(region.id)
        return
      }
      setActiveSlice(region.id)
      // Selecting without playing makes the waveform feel dead; a click on a
      // slice should sound, the same as hitting its pad.
      triggerRef.current?.(region.id)
    })

    return () => {
      wave.destroy()
      waveRef.current = null
      regionsRef.current = null
      bufferRef.current = null
      reversedRef.current = null
      setSlices([])
      setActiveSlice(null)
      setWaveReady(false)
      setPending(null)
      pendingRef.current = null
      syncRef.current = null
      setWavePlaying(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio])

  /* --- the cuts on the stage: their key, and which one is chosen ---------- */
  // Each region carries the key that plays it, the way a hardware slicer
  // numbers its slices; the chosen pad stands out in the stage's one colour.
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions) return
    const order = new Map(slices.map((slice, index) => [slice.id, index]))
    for (const region of regions.getRegions()) {
      const index = order.get(region.id)
      if (index === undefined) continue
      const label = index < MAX_PADS ? PAD_KEYS[index].toUpperCase() : String(index + 1)
      if (region.content?.textContent !== label) {
        const tag = document.createElement('span')
        tag.textContent = label
        region.setContent(tag)
      }
      const color = region.id === activeSlice ? ACTIVE_COLOR : SLICE_COLOR
      if (region.color !== color) region.setOptions({ color })
    }
  }, [slices, activeSlice])

  useEffect(() => {
    if (!waveReady) return
    try {
      waveRef.current?.zoom(zoom)
    } catch {
      // Wavesurfer throws "No audio loaded" if it is not ready yet, which the
      // guard above should prevent — but a destroyed instance can race here.
    }
  }, [zoom, waveReady])

  /* --- playback ----------------------------------------------------------- */
  const stopPad = useCallback((index: number) => {
    const voices = voicesRef.current.get(index)
    if (!voices) return
    for (const voice of voices) voice.stop()
    voicesRef.current.delete(index)
    setPlaying((current) => current.filter((pad) => pad !== index))
  }, [])

  const stopAll = useCallback(() => {
    for (const index of [...voicesRef.current.keys()]) stopPad(index)
  }, [stopPad])

  const triggerPad = useCallback(
    (index: number, semitone = 0, velocity = 1) => {
      const pad = slices[index]
      const buffer = bufferRef.current
      if (!pad || !buffer) return
      const slice = semitone === 0 ? pad : { ...pad, semitones: pad.semitones + semitone }

      const context = getAudioContext()
      if (context.state === 'suspended') {
        // A click is a user gesture, so this is allowed — but it resolves
        // asynchronously, and starting a node before it does produces silence.
        void resumeAudioContext().then(() => triggerPad(index, semitone, velocity))
        return
      }

      if (choke) stopPad(index)
      // The same voice the pattern and the bounce use: pitch, level, pan and
      // envelope sound identical under a finger and in the exported beat.
      const voice = startVoice(
        context,
        context.destination,
        slice,
        { forward: buffer, reversed: reversedRef.current },
        context.currentTime,
        undefined,
        velocity,
      )
      const source = voice.source

      const voices = voicesRef.current.get(index) ?? []
      voices.push(voice)
      voicesRef.current.set(index, voices)
      setPlaying((current) => (current.includes(index) ? current : [...current, index]))

      source.onended = () => {
        const live = (voicesRef.current.get(index) ?? []).filter((entry) => entry.source !== source)
        if (live.length > 0) voicesRef.current.set(index, live)
        else {
          voicesRef.current.delete(index)
          setPlaying((current) => current.filter((pad) => pad !== index))
        }
      }
    },
    [choke, slices, stopPad],
  )

  // Kept in a ref so the wavesurfer effect and the resume path can reach it.
  /** Plays the dragged range once, as it would sound as a new pad. */
  const playPending = useCallback(() => {
    const buffer = bufferRef.current
    if (!pending || !buffer) return
    const context = getAudioContext()
    if (context.state === 'suspended') {
      void resumeAudioContext().then(() => playPending())
      return
    }
    stopPad(-1)
    const voice = startVoice(
      context,
      context.destination,
      { ...SLICE_DEFAULTS, id: pending.id, start: pending.start, end: pending.end, mode: 'oneshot' },
      { forward: buffer, reversed: reversedRef.current },
      context.currentTime,
    )
    voicesRef.current.set(-1, [voice])
  }, [pending, stopPad])

  const confirmPending = () => {
    const region = regionsRef.current?.getRegions().find((entry) => entry.id === pendingRef.current)
    if (!region) return
    pendingRef.current = null
    setPending(null)
    region.setOptions({ color: SLICE_COLOR, start: region.start, end: region.end })
    setSlices((current) =>
      [...current, { ...SLICE_DEFAULTS, id: region.id, start: region.start, end: region.end, mode: defaultMode }].sort(
        (a, b) => a.start - b.start,
      ),
    )
    setActiveSlice(region.id)
    log('sampler', `Pad aus ${(region.end - region.start).toFixed(2)} s angelegt`)
  }

  const discardPending = () => {
    regionsRef.current?.getRegions().find((entry) => entry.id === pendingRef.current)?.remove()
  }

  /** Takes a pad away, with its region; the pattern forgets its row. */
  const deletePad = (id: string) => {
    const index = slices.findIndex((slice) => slice.id === id)
    if (index >= 0) stopPad(index)
    regionsRef.current?.getRegions().find((entry) => entry.id === id)?.remove()
    setActiveSlice(null)
    log('sampler', `Pad ${index + 1} gelöscht`)
  }

  useEffect(() => {
    triggerRef.current = (sliceId: string) => {
      if (sliceId === pendingRef.current) {
        playPending()
        return
      }
      const index = slices.findIndex((slice) => slice.id === sliceId)
      if (index >= 0) triggerPad(index)
    }
  }, [slices, triggerPad, playPending])

  /* --- keyboard ----------------------------------------------------------- */
  const confirmRef = useRef(confirmPending)
  confirmRef.current = confirmPending
  const deleteRef = useRef(deletePad)
  deleteRef.current = deletePad
  const activeRef = useRef(activeSlice)
  activeRef.current = activeSlice

  useEffect(() => {
    const held = new Set<string>()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return

      if (event.key === ' ') {
        event.preventDefault()
        stopAll()
        waveRef.current?.pause()
        return
      }
      if (event.key === 'Enter' && pendingRef.current) {
        event.preventDefault()
        confirmRef.current()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && activeRef.current) {
        event.preventDefault()
        deleteRef.current(activeRef.current)
        return
      }
      const key = event.key.toLowerCase()
      const index = PAD_KEYS.indexOf(key)
      if (index < 0 || !slices[index]) return
      event.preventDefault()
      held.add(key)
      setActiveSlice(slices[index].id)
      triggerPad(index)
    }

    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (!held.delete(key)) return
      const index = PAD_KEYS.indexOf(key)
      // Gate pads stop on release; the others ring out on their own.
      if (index >= 0 && slices[index]?.mode === 'gate') stopPad(index)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [slices, stopAll, stopPad, triggerPad])

  /* --- Web MIDI: Hardware keyboards and drum pads ------------------------- */
  useEffect(() => {
    let sub: MidiAccessSubscription | null = null
    void connectWebMidi({
      onNoteOn: (padIndex, velocity) => {
        if (padIndex >= 0 && padIndex < MAX_PADS && slices[padIndex]) {
          setActiveSlice(slices[padIndex].id)
          triggerPad(padIndex, 0, velocity)
        }
      },
      onNoteOff: (padIndex) => {
        if (padIndex >= 0 && padIndex < MAX_PADS) {
          const pad = slices[padIndex]
          if (pad && pad.mode === 'gate') stopPad(padIndex)
        }
      },
      onStateChange: (devices) => {
        setMidiDevices(devices)
        if (devices.length > 0) log('sampler', `MIDI: ${devices.join(', ')}`)
      },
    }).then((res) => {
      if (res) {
        sub = res
        setMidiDevices(res.devices)
        if (res.devices.length > 0) log('sampler', `MIDI: ${res.devices.join(', ')}`)
      }
    })
    return () => sub?.disconnect()
  }, [log, slices, stopPad, triggerPad])

  useEffect(() => stopAll, [stopAll])

  /* --- chopping ----------------------------------------------------------- */
  const planSettings = useMemo(() => ({ ...chop, bpm }), [chop, bpm])
  const tempoOffset = tempo?.offsetSeconds ?? 0
  const [plan, setPlan] = useState<ChopPlan | null>(null)

  // Planned on a pause: hits and silence read the whole file, and a slider
  // dragged across its range would otherwise plan forty times.
  useEffect(() => {
    if (!audio) {
      setPlan(null)
      return
    }
    const timer = window.setTimeout(() => setPlan(planChop(audio, planSettings, { tempoOffsetSeconds: tempoOffset })), 120)
    return () => window.clearTimeout(timer)
  }, [audio, planSettings, tempoOffset])

  // The plan on the stage, as dashed marks: where the cuts will fall, before
  // anything is cut. Gone once the cuts are made, back with the next change.
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions || !waveReady) return
    for (const region of [...regions.getRegions()]) if (isPlanMark(region.id)) region.remove()
    if (!planShown || !plan) return
    const marks = new Set<number>()
    for (const slice of plan.slices) {
      if (slice.start > 0.001) marks.add(slice.start)
      // Pauses left out end before the next one starts; their ends are cuts too.
      if (chop.method === 'silence' && chop.dropSilence && slice.end < duration - 0.001) marks.add(slice.end)
    }
    let index = 0
    for (const at of marks) {
      regions.addRegion({ id: `plan-${index}`, start: at, end: at, color: PLAN_COLOR, drag: false, resize: false })
      index += 1
    }
  }, [plan, planShown, waveReady, chop.method, chop.dropSilence, duration])

  /**
   * Makes the plan into pads — over the whole file, or only inside a range,
   * where the pads already outside it stay as they are.
   */
  const applyPlan = (range: { start: number; end: number } | null = null) => {
    const regions = regionsRef.current
    if (!regions || !audio) return
    const result = planChop(audio, planSettings, { range, tempoOffsetSeconds: tempoOffset })
    cuttingRef.current = true
    for (const region of [...regions.getRegions()]) {
      if (isPlanMark(region.id) || region.id === pendingRef.current) continue
      if (!range || (region.start >= range.start && region.end <= range.end)) {
        region.remove()
      } else if (region.start < range.start && region.end > range.end) {
        // Spans the whole range: what lies before it and after it both stay.
        const tail = region.end
        region.setOptions({ start: region.start, end: range.start })
        regions.addRegion({ start: range.end, end: tail, color: SLICE_COLOR, drag: true, resize: true })
      } else if (region.start < range.start && region.end > range.start) {
        region.setOptions({ start: region.start, end: range.start })
      } else if (region.start < range.end && region.end > range.end) {
        region.setOptions({ start: range.end, end: region.end })
      }
    }
    for (const slice of result.slices) {
      regions.addRegion({ start: slice.start, end: slice.end, color: SLICE_COLOR, drag: true, resize: true })
    }
    cuttingRef.current = false
    syncRef.current?.()
    setPlanShown(false)
    if (range) regions.getRegions().find((entry) => entry.id === pendingRef.current)?.remove()
    log(
      'sampler',
      `${describeMethod(planSettings)}${range ? ' im Bereich' : ''}: ${result.slices.length} Pads${
        result.capped ? ` (auf ${MAX_PLANNED} begrenzt)` : ''
      }${planSettings.snap ? ', an Nulldurchgänge gerastet' : ''}`,
    )
  }

  /* --- per-pad editing ---------------------------------------------------- */
  const selected = useMemo(() => slices.find((slice) => slice.id === activeSlice) ?? null, [activeSlice, slices])
  const selectedIndex = selected ? slices.indexOf(selected) : -1

  const updateSlice = (id: string, patch: Partial<Slice>) => {
    setSlices((current) => current.map((slice) => (slice.id === id ? { ...slice, ...patch } : slice)))
    // Any edit invalidates a rendered preview of that pad.
    if (rendered?.id === id) setRendered(null)
  }

  const applyToAll = () => {
    if (!selected) return
    setSlices((current) =>
      current.map((slice) => ({
        ...slice,
        semitones: selected.semitones,
        gainDb: selected.gainDb,
        reverse: selected.reverse,
        mode: selected.mode,
        pan: selected.pan,
        attackMs: selected.attackMs,
        releaseMs: selected.releaseMs,
      })),
    )
    log('sampler', 'Einstellungen des gewählten Pads auf alle übertragen')
  }

  const transposeAll = (delta: number) => {
    setSlices((current) =>
      current.map((slice) => ({
        ...slice,
        semitones: delta === 0 ? 0 : clamp(slice.semitones + delta, -24, 24),
      })),
    )
    log('sampler', delta === 0 ? 'Tonhöhe aller Pads zurückgesetzt' : `Alle Pads um ${delta > 0 ? '+' : ''}${delta} Halbtöne transponiert`)
  }

  const setAllMode = (mode: PlayMode) => {
    setSlices((current) => current.map((slice) => ({ ...slice, mode })))
    log('sampler', `Alle Pads auf „${MODE_SHORT[mode]}“ umgestellt`)
  }

  /* --- export ------------------------------------------------------------- */
  const buildSlice = useCallback(
    async (slice: Slice): Promise<AudioData | null> => {
      if (!audio) return null
      let piece = sliceAudio(audio, slice.start, slice.end)
      if (slice.reverse) piece = reverseAudio(piece)

      if (Math.abs(slice.semitones) > 1e-6) {
        piece = await renderSliceInWorker(
          piece,
          { semitones: slice.semitones, stretchFactor: 1, preserveDuration },
          (fraction) => setProgress(fraction),
        )
      }

      const fade = fadeMs / 1000
      piece = applyFades(piece, fade, fade)
      if (normalize) piece = normalizePeak(piece, -0.3)

      const gain = dbToGain(slice.gainDb)
      if (Math.abs(gain - 1) > 1e-6) {
        piece = {
          channels: piece.channels.map((channel) => {
            const out = new Float32Array(channel.length)
            for (let i = 0; i < channel.length; i += 1) out[i] = clamp(channel[i] * gain, -1, 1)
            return out
          }),
          sampleRate: piece.sampleRate,
        }
      }

      // The pad's own envelope, on top of the anti-click blend.
      if (slice.attackMs > 0 || slice.releaseMs > 0) piece = applyFades(piece, slice.attackMs / 1000, slice.releaseMs / 1000)
      if (slice.pan !== 0) {
        // Equal-power pan; a mono chop becomes stereo so it has somewhere to go.
        const angle = ((slice.pan + 1) * Math.PI) / 4
        const left = piece.channels[0]
        const right = piece.channels[1] ?? piece.channels[0]
        piece = {
          channels: [left.map((value) => value * Math.cos(angle) * Math.SQRT2), right.map((value) => value * Math.sin(angle) * Math.SQRT2)],
          sampleRate: piece.sampleRate,
        }
      }
      return piece
    },
    [audio, fadeMs, normalize, preserveDuration],
  )

  const baseName = asset?.name.replace(/\.[^.]+$/, '') ?? 'sample'

  const sliceName = (index: number) => `${baseName}_${String(index + 1).padStart(2, '0')}.wav`

  /**
   * Puts rendered chops into the session without leaving the source.
   *
   * `addAsset` makes each new file the active one. Here that would swap the
   * track being chopped for its last chop — the pads would rebuild on half a
   * second of audio, and every other tool would quietly work on that half
   * second too. So the source stays active, and the chops are simply there.
   */
  const addToSession = (pieces: { name: string; piece: AudioData; bytes: Uint8Array }[]) => {
    const sourceId = asset?.id ?? null
    for (const { name, piece, bytes } of pieces) {
      addAsset({
        name,
        bytes,
        mime: 'audio/wav',
        sizeBytes: bytes.byteLength,
        kind: 'audio',
        audio: piece,
        durationSeconds: (piece.channels[0]?.length ?? 0) / piece.sampleRate,
        origin: 'derived',
      })
    }
    if (sourceId) setActiveAsset(sourceId)
  }

  const exportOne = async (slice: Slice, index: number, destination: 'file' | 'session') => {
    setRendering(true)
    try {
      const piece = await buildSlice(slice)
      if (!piece) return
      const name = sliceName(index)
      const bytes = encodeWav(piece, 24)
      if (destination === 'session') {
        addToSession([{ name, piece, bytes }])
        log('sampler', `${name} in die Sitzung übernommen`)
      } else {
        saveBytes(bytes, name, 'audio/wav')
        log('sampler', `${name} exportiert`)
      }
    } finally {
      setRendering(false)
      setProgress(null)
    }
  }

  const renderAll = async (destination: 'session' | 'zip') => {
    setRendering(true)
    const files: { name: string; piece: AudioData; bytes: Uint8Array }[] = []
    try {
      for (const [index, slice] of slices.entries()) {
        const piece = await buildSlice(slice)
        if (!piece) continue
        files.push({ name: sliceName(index), piece, bytes: encodeWav(piece, 24) })
      }
      if (files.length === 0) return
      if (destination === 'zip') {
        saveBytes(
          createZip(files.map(({ name, bytes }) => ({ name: `${baseName}/${name}`, data: bytes }))),
          `${baseName}-chops.zip`,
          'application/zip',
        )
        log('sampler', `${files.length} Chops als ZIP gespeichert`)
      } else {
        addToSession(files)
        log('sampler', `${files.length} Chops in die Sitzung übernommen`)
      }
    } finally {
      setRendering(false)
      setProgress(null)
    }
  }

  const exportCue = () => {
    if (slices.length === 0) return
    const cueContent = createCueSheet(`${baseName}.wav`, slices, baseName)
    const bytes = new TextEncoder().encode(cueContent)
    saveBytes(bytes, `${baseName}.cue`, 'application/x-cue')
    log('sampler', `${baseName}.cue exportiert (${slices.length} Cues)`)
  }

  const exportAudacity = () => {
    if (slices.length === 0) return
    const labelContent = createAudacityLabels(slices)
    const bytes = new TextEncoder().encode(labelContent)
    saveBytes(bytes, `${baseName}-labels.txt`, 'text/plain')
    log('sampler', `Audacity Labels exportiert (${slices.length} Abschnitte)`)
  }

  const confident = (tempo?.confidence ?? 0) >= 0.5

  if (!asset) {
    return (
      <Card tone="keylime">
        <h2 className="display-md mt-[8px] mb-[12px]">Zerlegen und auf Tasten legen</h2>
        <p className="mb-[16px] max-w-[62ch] text-body leading-[1.55] text-prose/85">
          Einen Loop oder eine Aufnahme an Schlägen, im Takt, an Pausen oder in gleiche Teile schneiden —
          jedes Stück liegt danach auf einer Taste und im Pattern.
        </p>
        <FileDrop />
      </Card>
    )
  }

  /* -- per-pad cutting ---------------------------------------------------------- */
  const regionOf = (id: string) => regionsRef.current?.getRegions().find((region) => region.id === id)

  /** Two pads where there was one; the new half keeps the pad's settings. */
  const splitPad = (slice: Slice, index: number) => {
    const regions = regionsRef.current
    const region = regionOf(slice.id)
    if (!regions || !region || !audio) return
    const half = (slice.start + slice.end) / 2
    const middle = chop.snap ? snapToZeroCrossing(audio, half) : half
    if (middle - slice.start < 0.015 || slice.end - middle < 0.015) return
    cuttingRef.current = true
    region.setOptions({ start: slice.start, end: middle })
    const added = regions.addRegion({ start: middle, end: slice.end, color: SLICE_COLOR, drag: true, resize: true })
    cuttingRef.current = false
    syncRef.current?.()
    const { id: _id, start: _start, end: _end, ...settings } = slice
    setSlices((current) => current.map((entry) => (entry.id === added.id ? { ...entry, ...settings } : entry)))
    log('sampler', `Pad ${index + 1} geteilt`)
  }

  /** One pad where there were two: this one runs on to the end of the next. */
  const joinNext = (slice: Slice, index: number) => {
    const next = slices[index + 1]
    const region = regionOf(slice.id)
    const following = next ? regionOf(next.id) : undefined
    if (!next || !region || !following) return
    region.setOptions({ start: slice.start, end: next.end })
    following.remove()
    log('sampler', `Pad ${index + 1} mit Pad ${index + 2} verbunden`)
  }

  /** Moves one edge by a few milliseconds — where a drag is too coarse. */
  const nudge = (slice: Slice, edge: 'start' | 'end', deltaMs: number) => {
    const region = regionOf(slice.id)
    if (!region) return
    const delta = deltaMs / 1000
    const start = edge === 'start' ? clamp(slice.start + delta, 0, slice.end - 0.015) : slice.start
    const end = edge === 'end' ? clamp(slice.end + delta, slice.start + 0.015, duration) : slice.end
    region.setOptions({ start, end })
    updateSlice(slice.id, { start, end })
  }

  /* -- the head of each pattern row: the pad itself ----------------------------- */
  const padHead = (slice: Slice, index: number) => {
    const key = PAD_KEYS[index]
    const isPlaying = playing.includes(index)
    const isSelected = slice.id === activeSlice
    return (
      <button
        type="button"
        aria-label={`Pad ${index + 1}, Taste ${key.toUpperCase()} — spielen und wählen`}
        aria-pressed={isSelected}
        onPointerDown={() => {
          setActiveSlice(slice.id)
          setSide((value) => (value === 'kit' || value === 'vorgaben' ? 'pad' : value))
          triggerPad(index)
        }}
        onPointerUp={() => {
          if (slice.mode !== 'oneshot') stopPad(index)
        }}
        onPointerLeave={() => {
          if (slice.mode === 'gate') stopPad(index)
        }}
        className={`press flex h-[34px] w-[152px] shrink-0 items-center gap-[8px] rounded-nav px-[8px] text-left transition-colors duration-[var(--dur-fast)] ${
          isPlaying
            ? 'bg-ink text-on-ink'
            : isSelected
              ? 'bg-panel-strong text-ink ring-2 ring-inset ring-ink'
              : 'bg-panel-mid text-ink hover:bg-panel-strong'
        }`}
      >
        <span className="value w-[1.1em] shrink-0 text-small font-bold leading-none">{key.toUpperCase()}</span>
        <span className="min-w-0 flex-1">{audio ? <PadWave audio={audio} from={slice.start} to={slice.end} className="h-[18px] w-full" /> : null}</span>
        <span className="value shrink-0 text-micro leading-none opacity-80">{(slice.end - slice.start).toFixed(2).replace('.', ',')}</span>
      </button>
    )
  }

  /* -- the column beside the rows ----------------------------------------------- */
  const ms = (seconds: number) => `${Math.round(seconds * 1000)} ms`
  const sideContent = (() => {
    if (side === 'pad') {
      if (!selected) {
        return (
          <p className="text-small leading-[1.5] text-prose">
            Ein Pad antippen oder seine Taste drücken — hier stehen dann Tonhöhe, Pegel, Panorama, Hüllkurve,
            Verhalten und sein Schnitt.
          </p>
        )
      }
      return (
        <>
          <div className="flex flex-wrap items-center gap-[8px]">
            <Button size="sm" onClick={() => triggerPad(selectedIndex)}>
              Anhören
            </Button>
            <Button size="sm" variant="quiet" onClick={() => deletePad(selected.id)} title="Pad löschen (Entf)">
              Löschen
            </Button>
            <button
              type="button"
              onClick={applyToAll}
              className="press ml-auto rounded-nav text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
              title="Werte dieses Pads auf alle anderen übertragen"
            >
              Auf alle übertragen
            </button>
          </div>
          <Slider
            label="Tonhöhe"
            display={`${selected.semitones > 0 ? '+' : ''}${selected.semitones} HT`}
            min={-24}
            max={24}
            step={1}
            value={selected.semitones}
            onChange={(event) => updateSlice(selected.id, { semitones: Number(event.target.value) })}
          />
          <Slider
            label="Pegel"
            display={`${selected.gainDb > 0 ? '+' : ''}${selected.gainDb.toFixed(1).replace('.', ',')} dB`}
            min={-24}
            max={12}
            step={0.5}
            value={selected.gainDb}
            onChange={(event) => updateSlice(selected.id, { gainDb: Number(event.target.value) })}
          />
          <Slider
            label="Panorama"
            display={selected.pan === 0 ? 'Mitte' : `${Math.round(Math.abs(selected.pan) * 100)} % ${selected.pan < 0 ? 'links' : 'rechts'}`}
            min={-1}
            max={1}
            step={0.05}
            value={selected.pan}
            onChange={(event) => updateSlice(selected.id, { pan: Number(event.target.value) })}
          />
          <div className="grid grid-cols-2 gap-[12px]">
            <Slider
              label="Anschwellen"
              display={`${selected.attackMs} ms`}
              min={0}
              max={500}
              step={5}
              value={selected.attackMs}
              onChange={(event) => updateSlice(selected.id, { attackMs: Number(event.target.value) })}
            />
            <Slider
              label="Ausklingen"
              display={`${selected.releaseMs} ms`}
              min={0}
              max={1000}
              step={10}
              value={selected.releaseMs}
              onChange={(event) => updateSlice(selected.id, { releaseMs: Number(event.target.value) })}
            />
          </div>
          <div className="flex flex-col gap-[6px]">
            <span className="text-small text-prose">Verhalten</span>
            <ChoiceRow
              value={selected.mode}
              columns={3}
              onChange={(mode) => updateSlice(selected.id, { mode })}
              options={(Object.keys(MODE_SHORT) as PlayMode[]).map((mode) => ({ value: mode, label: MODE_SHORT[mode], title: MODE_LABELS[mode] }))}
            />
          </div>
          <Toggle label="Rückwärts" checked={selected.reverse} onChange={(value) => updateSlice(selected.id, { reverse: value })} />

          {/* The pad's own cut: where a drag on the stage is too coarse. */}
          <div className="flex flex-col gap-[8px] border-t border-line pt-[12px]">
            <span className="text-small font-semibold text-ink">Schnitt dieses Pads</span>
            {(['start', 'end'] as const).map((edge) => (
              <div key={edge} className="flex items-center gap-[6px]">
                <span className="w-[4.5em] text-small text-prose">{edge === 'start' ? 'Anfang' : 'Ende'}</span>
                <span className="value flex-1 text-small text-ink">{formatTimecode(edge === 'start' ? selected.start : selected.end)}</span>
                {[-10, -1, 1, 10].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    onClick={() => nudge(selected, edge, delta)}
                    title={`${delta > 0 ? '+' : '−'}${Math.abs(delta)} ms`}
                    className="press value h-[28px] min-w-[34px] rounded-nav bg-panel-soft px-[4px] text-micro text-ink ring-1 ring-inset ring-line hover:bg-panel-mid"
                  >
                    {delta > 0 ? '+' : '−'}
                    {Math.abs(delta)}
                  </button>
                ))}
              </div>
            ))}
            <p className="value text-small text-prose">Länge {ms(selected.end - selected.start)}</p>
            <div className="grid grid-cols-2 gap-[4px]">
              <Button size="sm" variant="quiet" onClick={() => splitPad(selected, selectedIndex)} disabled={selected.end - selected.start < 0.04}>
                Halbieren
              </Button>
              <Button size="sm" variant="quiet" onClick={() => joinNext(selected, selectedIndex)} disabled={selectedIndex >= slices.length - 1}>
                Mit nächstem verbinden
              </Button>
            </div>
          </div>

          {rendered?.id === selected.id ? (
            <AudioPreview sources={[{ id: rendered.id, label: 'Wie exportiert', audio: rendered.audio }]} waveHeight={40} />
          ) : (
            <Button
              size="sm"
              variant="quiet"
              disabled={rendering}
              onClick={async () => {
                setRendering(true)
                try {
                  const piece = await buildSlice(selected)
                  if (piece) setRendered({ id: selected.id, audio: piece })
                } finally {
                  setRendering(false)
                  setProgress(null)
                }
              }}
            >
              {rendering ? 'Rendert…' : 'So hören, wie es exportiert wird'}
            </Button>
          )}
        </>
      )
    }

    if (side === 'kit') {
      return (
        <>
          <div className="flex flex-col gap-[6px]">
            <span className="text-small text-prose">Alle {slices.length} transponieren</span>
            <div className="grid grid-cols-5 gap-[4px]">
              {[-12, -1, 0, 1, 12].map((delta) => (
                <Button key={delta} size="sm" variant="quiet" className="px-[4px]" onClick={() => transposeAll(delta)}>
                  {delta === 0 ? '0' : delta > 0 ? `+${delta}` : `−${-delta}`}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-[6px] border-t border-line pt-[12px]">
            <span className="text-small text-prose">Alle spielen als</span>
            <div className="grid grid-cols-3 gap-[4px]">
              {(Object.keys(MODE_SHORT) as PlayMode[]).map((mode) => (
                <Button key={mode} size="sm" variant="quiet" className="px-[4px]" onClick={() => setAllMode(mode)} title={MODE_LABELS[mode]}>
                  {MODE_SHORT[mode]}
                </Button>
              ))}
            </div>
          </div>
          <div className="border-t border-line pt-[12px]">
            <Button size="sm" variant="quiet" onClick={() => regionsRef.current?.getRegions().filter((region) => !isPlanMark(region.id)).forEach((region) => region.remove())}>
              Alle Schnitte entfernen
            </Button>
          </div>
        </>
      )
    }

    if (side === 'export') {
      return (
        <>
          {selected ? (
            <div className="flex flex-col gap-[4px]">
              <span className="text-small text-prose">Pad {selectedIndex + 1}</span>
              <Button size="sm" onClick={() => exportOne(selected, selectedIndex, 'file')} disabled={rendering}>
                Als WAV speichern
                <ArrowRight />
              </Button>
              <Button size="sm" variant="quiet" onClick={() => exportOne(selected, selectedIndex, 'session')} disabled={rendering}>
                In die Sitzung
              </Button>
            </div>
          ) : null}
          <div className={`flex flex-col gap-[4px] ${selected ? 'border-t border-line pt-[12px]' : ''}`}>
            <span className="text-small text-prose">Alle {slices.length} Pads</span>
            <Button size="sm" variant={selected ? 'quiet' : 'primary'} onClick={() => renderAll('zip')} disabled={rendering}>
              {rendering ? 'Rendert…' : 'Als ZIP speichern'}
            </Button>
            {slices.length <= MAX_PADS ? (
              <Button size="sm" variant="quiet" onClick={() => renderAll('session')} disabled={rendering}>
                In die Sitzung
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-[4px] border-t border-line pt-[12px]">
            <span className="text-small text-prose">Nur die Schnittmarken</span>
            <div className="grid grid-cols-2 gap-[4px]">
              <Button size="sm" variant="quiet" onClick={exportCue} disabled={rendering} title="CUE-Sheet für Player und Brennprogramme">
                CUE
              </Button>
              <Button size="sm" variant="quiet" onClick={exportAudacity} disabled={rendering} title="Textmarken für Audacity">
                Audacity
              </Button>
            </div>
          </div>
          {rendering ? <Progress value={progress} label="Wird gerendert" /> : null}
        </>
      )
    }

    return (
      <>
        <div className="flex flex-col gap-[6px]">
          <span className="text-small text-prose">Neue Pads spielen als</span>
          <ChoiceRow
            value={defaultMode}
            columns={3}
            onChange={setDefaultMode}
            options={(Object.keys(MODE_SHORT) as PlayMode[]).map((mode) => ({ value: mode, label: MODE_SHORT[mode], title: MODE_LABELS[mode] }))}
          />
        </div>
        <Slider
          label="Blende an den Schnittkanten"
          display={`${fadeMs} ms`}
          min={0}
          max={60}
          step={1}
          value={fadeMs}
          onChange={(event) => setFadeMs(Number(event.target.value))}
        />
        <Toggle label="Neuer Anschlag stoppt den alten" hint="Choke, wie an einer MPC." checked={choke} onChange={setChoke} />
        <Toggle label="Länge beim Transponieren halten" hint="Phasenvocoder beim Export." checked={preserveDuration} onChange={setPreserveDuration} />
        <Toggle label="Auf −0,3 dBFS normalisieren" checked={normalize} onChange={setNormalize} />
      </>
    )
  })()

  /* -- how to cut: the options of the chosen method ------------------------------ */
  const keepsAttack = chop.method === 'hits' || chop.method === 'auto' || chop.method === 'silence'
  const methodOptions = (() => {
    switch (chop.method) {
      case 'hits':
        return (
          <>
            <Slider label="Empfindlichkeit" display={chop.sensitivity.toFixed(1).replace('.', ',')} min={0.5} max={3} step={0.1} value={chop.sensitivity}
              onChange={(event) => setChop({ sensitivity: Number(event.target.value) })} title="Höher: nur deutliche Schläge" />
            <Slider label="Mindestabstand" display={`${chop.minGapMs} ms`} min={20} max={1000} step={10} value={chop.minGapMs}
              onChange={(event) => setChop({ minGapMs: Number(event.target.value) })} title="Kürzester Abstand zwischen zwei Schnitten" />
          </>
        )
      case 'auto':
        return (
          <>
            <OptionGroup label="Anzahl">
              <ChoiceRow value={chop.count} onChange={(count) => setChop({ count })} options={[4, 8, 12, 16, 24, 32].map((value) => ({ value, label: String(value) }))} />
            </OptionGroup>
            <Slider label="Empfindlichkeit" display={chop.sensitivity.toFixed(1).replace('.', ',')} min={0.5} max={3} step={0.1} value={chop.sensitivity}
              onChange={(event) => setChop({ sensitivity: Number(event.target.value) })} />
          </>
        )
      case 'grid':
        return (
          <>
            <OptionGroup label={`Tempo${confident ? '' : ' — nachhören'}`}>
              <div className="flex items-center gap-[2px] self-start rounded-nav bg-panel-soft p-[2px] ring-1 ring-inset ring-line">
                <button type="button" onClick={() => { setBpm((value) => Math.max(30, Math.round(value / 2))); setPlanShown(true) }}
                  className="press rounded-[7px] px-[8px] py-[4px] text-small text-ink hover:bg-panel-mid" title="Halbes Tempo">÷2</button>
                <input type="number" value={bpm} min={30} max={300} step={0.1} aria-label="Tempo in BPM"
                  onChange={(event) => { setBpm(Number(event.target.value) || 120); setPlanShown(true) }}
                  className="value w-[6ch] min-w-0 bg-transparent text-center text-small text-ink outline-none" />
                <button type="button" onClick={() => { setBpm((value) => Math.min(300, Math.round(value * 2))); setPlanShown(true) }}
                  className="press rounded-[7px] px-[8px] py-[4px] text-small text-ink hover:bg-panel-mid" title="Doppeltes Tempo">×2</button>
                <span className="px-[6px] text-small text-prose">BPM</span>
              </div>
            </OptionGroup>
            <OptionGroup label="Raster" wide>
              <ChoiceRow value={chop.beatsPerSlice} onChange={(beatsPerSlice) => setChop({ beatsPerSlice })} options={GRID_DIVISIONS} />
            </OptionGroup>
            <Slider label="Verschieben" display={`${chop.gridOffsetMs > 0 ? '+' : ''}${chop.gridOffsetMs} ms`} min={-250} max={250} step={1} value={chop.gridOffsetMs}
              onChange={(event) => setChop({ gridOffsetMs: Number(event.target.value) })} title="Das ganze Raster früher oder später" />
          </>
        )
      case 'silence':
        return (
          <>
            <OptionGroup label="Was als Pause gilt">
              <ChoiceRow value={chop.silenceDb} onChange={(silenceDb) => setChop({ silenceDb })}
                options={[-35, -45, -55, -65].map((value) => ({ value, label: `${value.toString().replace('-', '−')} dB` }))} />
            </OptionGroup>
            <Slider label="Pause ab" display={`${chop.silenceMs} ms`} min={30} max={1500} step={10} value={chop.silenceMs}
              onChange={(event) => setChop({ silenceMs: Number(event.target.value) })} />
            <div className="flex items-end">
              <Toggle label="Pausen weglassen" hint="Jedes Pad beginnt mit seinem Klang und endet mit ihm." checked={chop.dropSilence}
                onChange={(dropSilence) => setChop({ dropSilence })} />
            </div>
          </>
        )
      case 'even':
        return (
          <OptionGroup label="Teile" wide>
            <ChoiceRow value={chop.count} onChange={(count) => setChop({ count })} options={[2, 3, 4, 6, 8, 12, 16, 24, 32, 64].map((value) => ({ value, label: String(value) }))} />
          </OptionGroup>
        )
      case 'length':
        return (
          <>
            <Slider label="Länge je Teil" display={chop.lengthMs >= 1000 ? `${(chop.lengthMs / 1000).toFixed(2).replace('.', ',')} s` : `${chop.lengthMs} ms`}
              min={50} max={4000} step={10} value={chop.lengthMs} onChange={(event) => setChop({ lengthMs: Number(event.target.value) })} />
            <OptionGroup label="Oder im Takt">
              <ChoiceRow
                value={-1}
                onChange={(beats) => setChop({ lengthMs: Math.round((60000 / bpm) * beats) })}
                options={[0.25, 0.5, 1, 4].map((beats) => ({ value: beats, label: beats === 4 ? '1 Takt' : `1/${4 / beats}`, title: `${Math.round((60000 / bpm) * beats)} ms bei ${Math.round(bpm)} BPM` }))}
              />
            </OptionGroup>
          </>
        )
    }
  })()

  const planCount = plan?.slices.length ?? 0

  return (
    <div className="flex flex-col gap-[16px]">
      {/* ---- the slicer: how to cut, the stage, the transport -------------- */}
      <section className="flex flex-col overflow-hidden bg-raised ring-1 ring-inset ring-line" aria-label="Schneiden">
        <header className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] border-b border-line px-[16px] py-[8px]">
          <div className="min-w-0 flex-1">
            <p className="truncate text-small font-semibold text-ink">{asset.name}</p>
            <p className="value truncate text-small text-muted">
              {audio
                ? `${formatTimecode(duration)} · ${tempo ? `${Math.round(bpm)} BPM${confident ? '' : ' (unsicher)'}` : 'Tempo wird geschätzt'} · ${slices.length} ${slices.length === 1 ? 'Pad' : 'Pads'}`
                : status === 'decoding'
                  ? 'wird dekodiert …'
                  : 'wartet auf den Ton'}
            </p>
          </div>
          {midiDevices.length > 0 ? (
            <span className="flex items-center gap-[6px] text-small text-prose" title="Angeschlossener MIDI-Controller">
              <span aria-hidden className="h-[7px] w-[7px] rounded-pill bg-ink" />
              MIDI: {midiDevices[0]}
            </span>
          ) : null}
        </header>

        {/* How to cut: the method, its own options, and what every method shares. */}
        <div className="flex flex-col border-b border-line">
          <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[10px] px-[16px] pt-[12px]">
            <ChoiceRow value={chop.method} onChange={(method) => setChop({ method })} options={METHODS} />
            <div className="ml-auto flex items-center gap-[12px]">
              {audio && plan ? (
                <span className="value text-small text-prose" aria-live="polite">
                  ergibt {planCount}
                  {plan.capped ? '+' : ''} {planCount === 1 ? 'Pad' : 'Pads'}
                </span>
              ) : null}
              <Button size="sm" onClick={() => applyPlan()} disabled={!audio || planCount === 0}>
                Schneiden
                <ArrowRight />
              </Button>
            </div>
          </div>
          <div className="grid gap-x-[24px] gap-y-[12px] px-[16px] py-[12px] sm:grid-cols-2 lg:grid-cols-4">{methodOptions}</div>
          <div className="grid gap-x-[24px] gap-y-[12px] border-t border-line bg-panel-soft px-[16px] py-[12px] sm:grid-cols-2 lg:grid-cols-4">
            {keepsAttack ? (
              <Slider label="Vorlauf" display={`${chop.preRollMs} ms`} min={0} max={40} step={1} value={chop.preRollMs}
                onChange={(event) => setChop({ preRollMs: Number(event.target.value) })} title="Jeder Schnitt so viel früher — der Anlauf eines Schlags bleibt auf seinem Pad" />
            ) : null}
            <Slider label="Mindestlänge" display={`${chop.minLengthMs} ms`} min={0} max={1000} step={10} value={chop.minLengthMs}
              onChange={(event) => setChop({ minLengthMs: Number(event.target.value) })} title="Kürzere Stücke gehen im vorigen auf" />
            <div className="flex items-end">
              <Toggle label="An Nulldurchgänge rasten" hint="Keine Knackser an den Kanten." checked={chop.snap} onChange={(snap) => setChop({ snap })} />
            </div>
            <p className="self-end text-small leading-[1.45] text-prose">
              Gestrichelt auf der Welle: wo geschnitten wird. Einen Bereich ziehen schneidet nur darin.
            </p>
          </div>
        </div>

        {/* The stage: the file, its cuts, and the range being asked about. */}
        <div className="relative bg-stage">
          <div className="sondra-wave sondra-stage-wave overflow-x-auto px-[0] pb-[10px]">
            <div ref={containerRef} />
          </div>
          {!audio ? (
            <p className="py-[96px] text-center text-small text-stage-muted">{status === 'decoding' ? 'Wird dekodiert …' : 'Warten auf den Ton …'}</p>
          ) : null}
          {pending ? (
            /* A dragged range is a question, not a pad yet — or the place to cut. */
            <div className="rise absolute left-[12px] top-[30px] z-10 flex flex-wrap items-center gap-[6px] bg-stage/90 p-[6px] pl-[12px] ring-1 ring-inset ring-stage-line backdrop-blur-[6px]">
              <span className="value mr-[4px] text-small text-stage-ink">
                {formatTimecode(pending.start)} – {formatTimecode(pending.end)} · {(pending.end - pending.start).toFixed(2).replace('.', ',')} s
              </span>
              <button type="button" onClick={playPending} className="press rounded-nav px-[10px] py-[5px] text-small text-stage-ink ring-1 ring-inset ring-stage-line hover:bg-stage-line">
                Hören
              </button>
              <button type="button" onClick={confirmPending} className="press rounded-nav bg-stage-ink px-[10px] py-[5px] text-small font-semibold text-stage hover:bg-stage-ink/85" title="Eingabetaste">
                Als ein Pad
              </button>
              <button
                type="button"
                onClick={() => applyPlan({ start: pending.start, end: pending.end })}
                className="press rounded-nav px-[10px] py-[5px] text-small text-stage-ink ring-1 ring-inset ring-stage-line hover:bg-stage-line"
                title={`${describeMethod(planSettings)}, nur in diesem Bereich`}
              >
                Darin schneiden ({METHODS.find((entry) => entry.value === chop.method)?.label})
              </button>
              <button type="button" onClick={discardPending} className="press rounded-nav px-[10px] py-[5px] text-small text-stage-muted hover:text-stage-ink">
                Verwerfen
              </button>
            </div>
          ) : audio && slices.length === 0 ? (
            <p className="pointer-events-none absolute inset-x-[12px] bottom-[20px] z-10 mx-auto w-fit max-w-[calc(100%-24px)] bg-stage/85 px-[12px] py-[6px] text-center text-small text-stage-ink ring-1 ring-inset ring-stage-line backdrop-blur-[6px]">
              Die gestrichelten Linien zeigen, wo geschnitten würde — „Schneiden“ macht Pads daraus.
            </p>
          ) : null}
        </div>

        {/* Transport */}
        <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] border-t border-line px-[12px] py-[8px]">
          <div className="flex items-center gap-[4px]">
            <button
              type="button"
              disabled={!waveReady}
              onClick={() => void waveRef.current?.playPause()}
              aria-label={wavePlaying ? 'Anhalten' : 'Alles abspielen'}
              title={wavePlaying ? 'Anhalten' : 'Alles abspielen'}
              className="press inline-flex h-[36px] w-[36px] items-center justify-center rounded-pill bg-ink text-on-ink hover:bg-ink-hover disabled:opacity-40"
            >
              {wavePlaying ? IconPause : IconPlay}
            </button>
            <IconButton
              label="Alles stoppen (Leertaste)"
              onClick={() => {
                stopAll()
                waveRef.current?.pause()
              }}
            >
              {IconStop}
            </IconButton>
          </div>
          <span className="hidden text-small text-prose sm:inline">
            Ziehen wählt · Eingabetaste legt an · 1–4 · Q–R · A–F · Y–V spielen · Entf löscht
          </span>
          <div className="ml-auto flex items-center gap-[4px]">
            <IconButton label="Herauszoomen" onClick={() => setZoom((value) => Math.max(0, value - 50))} disabled={!waveReady || zoom === 0}>
              {IconZoomOut}
            </IconButton>
            <input
              type="range"
              min={0}
              max={400}
              step={10}
              value={zoom}
              disabled={!waveReady}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="w-[96px] sm:w-[140px]"
              aria-label="Zoom"
            />
            <IconButton label="Hineinzoomen" onClick={() => setZoom((value) => Math.min(400, value + 50))} disabled={!waveReady || zoom >= 400}>
              {IconZoomIn}
            </IconButton>
          </div>
        </div>
      </section>

      {/* ---- pads and pattern, one rack ------------------------------------- */}
      {slices.length > 0 ? (
        <StepSequencer
          slices={slices}
          buffers={() => (bufferRef.current ? { forward: bufferRef.current, reversed: reversedRef.current } : null)}
          initialBpm={bpm}
          choke={choke}
          baseName={baseName}
          note={
            slices.length > MAX_PADS
              ? `Die ersten ${MAX_PADS} von ${slices.length} Pads liegen auf Tasten und im Pattern; exportiert werden alle.`
              : undefined
          }
          head={padHead}
          aside={
            <>
              <div role="tablist" aria-label="Einstellungen" className="flex gap-[4px] border-b border-line p-[8px]">
                {(
                  [
                    { id: 'pad', label: selected ? `Pad ${selectedIndex + 1}` : 'Pad' },
                    { id: 'kit', label: 'Alle Pads' },
                    { id: 'export', label: 'Export' },
                    { id: 'vorgaben', label: 'Vorgaben' },
                  ] as const
                ).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={side === entry.id}
                    onClick={() => setSide(entry.id)}
                    className={`press flex-1 rounded-nav px-[6px] py-[7px] text-small ${
                      side === entry.id ? 'bg-ink text-on-ink' : 'text-prose hover:bg-panel-soft'
                    }`}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
              <div key={side} role="tabpanel" className="rise flex flex-col gap-[14px] p-[16px]">
                {sideContent}
              </div>
            </>
          }
          onPreviewPad={(index, semitone) => {
            if (!slices[index]) return
            // A key auditioned in the roll only sounds; selecting the pad
            // would redraw the panels around the roll mid-gesture.
            if (semitone === undefined) setActiveSlice(slices[index].id)
            triggerPad(index, semitone)
          }}
          onBounce={(pattern, name) => {
            addToSession([{ name, piece: pattern, bytes: encodeWav(pattern, 24) }])
            log('sampler', `${name} in die Sitzung übernommen`)
          }}
        />
      ) : null}
    </div>
  )
}

/** A labelled control in the options row, for the ones that are not sliders. */
function OptionGroup({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col gap-[6px] ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="text-small text-prose">{label}</span>
      {children}
    </div>
  )
}
