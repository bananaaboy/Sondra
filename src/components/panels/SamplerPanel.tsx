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
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region } from 'wavesurfer.js/plugins/regions'

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
import { detectOnsets, divideEvenly } from '../../lib/onsets'
import { beatGrid, estimateTempo, snapToZeroCrossing, type TempoEstimate } from '../../lib/tempo'
import { readPalette, withAlpha, type ResolvedTheme } from '../../lib/theme'
import { encodeWav, type AudioData } from '../../lib/wav'
import { renderSliceInWorker } from '../../lib/workerClient'
import { SLICE_DEFAULTS, startVoice, type PlayMode, type Slice, type Voice } from '../../lib/pattern'
import { StepSequencer } from './StepSequencer'
import { createZip } from '../../lib/zip'
import { useDecodedAudio } from '../../hooks/useDecodedAudio'
import { useActiveAsset, useSession } from '../../state/store'
import { AudioPreview } from '../AudioPreview'
import { FileDrop } from '../FileDrop'
import {
  ArrowRight,
  Badge,
  Button,
  Card,
  SectionHead,
  Field,
  Notice,
  Progress,
  Select,
  Slider,
  Toggle,
} from '../ui/primitives'


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
function PadWave({ audio, from, to }: { audio: AudioData; from: number; to: number }) {
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
    <svg viewBox="0 0 22 10" preserveAspectRatio="none" className="h-[26px] w-full" aria-hidden>
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

const GRID_DIVISIONS: { value: number; label: string }[] = [
  { value: 0.25, label: '1/16' },
  { value: 0.5, label: '1/8' },
  { value: 1, label: '1/4 (Beat)' },
  { value: 2, label: '1/2' },
  { value: 4, label: 'Takt' },
]

const MODE_LABELS: Record<PlayMode, string> = {
  oneshot: 'One-Shot',
  gate: 'Gate (Taste halten)',
  loop: 'Schleife',
}

export function SamplerPanel({ theme }: { theme: ResolvedTheme }) {
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
  const [snap, setSnap] = useState(true)
  const [fadeMs, setFadeMs] = useState(4)
  const [normalize, setNormalize] = useState(false)
  const [preserveDuration, setPreserveDuration] = useState(true)

  const [tempo, setTempo] = useState<TempoEstimate | null>(null)
  const [bpm, setBpm] = useState(120)
  const [division, setDivision] = useState(1)
  const [sliceCount, setSliceCount] = useState(16)
  const [zoom, setZoom] = useState(0)
  /** Wavesurfer rejects most calls until it has decoded the audio. */
  const [waveReady, setWaveReady] = useState(false)

  const [rendering, setRendering] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  /** The selected pad rendered exactly as it would export. */
  const [rendered, setRendered] = useState<{ id: string; audio: AudioData } | null>(null)

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

    const palette = readPalette()
    const regions = RegionsPlugin.create()
    const wave = WaveSurfer.create({
      container,
      height: 148,
      waveColor: withAlpha(palette.ink, 0.35),
      progressColor: palette.ink,
      cursorColor: palette.ink,
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      plugins: [regions],
    })

    waveRef.current = wave
    regionsRef.current = regions
    setWaveReady(false)
    wave.on('ready', () => setWaveReady(true))

    const context = getAudioContext()
    bufferRef.current = toAudioBuffer(audio, context)
    reversedRef.current = toAudioBuffer(reverseAudio(audio), context)
    wave.loadBlob(new Blob([encodeWav(audio, 16).slice().buffer], { type: 'audio/wav' }))

    regions.enableDragSelection({ color: withAlpha(palette.ink, 0.12) })

    const sync = () => {
      setSlices((current) => {
        const previous = new Map(current.map((slice) => [slice.id, slice]))
        return regions
          .getRegions()
          .filter((region) => region.id !== pendingRef.current)
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

    const pendingColor = withAlpha(palette.ink, 0.28)
    regions.on('region-created', (region: Region) => {
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
      if (region.id === pendingRef.current) setPending({ id: region.id, start: region.start, end: region.end })
      else sync()
    })
    regions.on('region-removed', (region: Region) => {
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
      setWavePlaying(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio])

  /* --- theme: recolour rather than rebuild -------------------------------- */
  useEffect(() => {
    const wave = waveRef.current
    if (!wave) return
    const frame = requestAnimationFrame(() => {
      const palette = readPalette()
      wave.setOptions({
        waveColor: withAlpha(palette.ink, 0.35),
        progressColor: palette.ink,
        cursorColor: palette.ink,
      })
      regionsRef.current?.getRegions().forEach((region) => {
        region.setOptions({ color: withAlpha(palette.ink, 0.1), start: region.start, end: region.end })
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [theme])

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
    (index: number, semitone = 0) => {
      const pad = slices[index]
      const buffer = bufferRef.current
      if (!pad || !buffer) return
      const slice = semitone === 0 ? pad : { ...pad, semitones: pad.semitones + semitone }

      const context = getAudioContext()
      if (context.state === 'suspended') {
        // A click is a user gesture, so this is allowed — but it resolves
        // asynchronously, and starting a node before it does produces silence.
        void resumeAudioContext().then(() => triggerPad(index, semitone))
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
    region.setOptions({ color: withAlpha(readPalette().ink, 0.1), start: region.start, end: region.end })
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

  useEffect(() => stopAll, [stopAll])

  /* --- chopping ----------------------------------------------------------- */
  const applyCuts = useCallback(
    (points: number[], label: string) => {
      const regions = regionsRef.current
      if (!regions || !audio) return

      const cuts = snap ? points.map((at) => snapToZeroCrossing(audio, at)) : points
      const unique = [...new Set(cuts.map((at) => Math.max(0, Math.min(duration, at))))].sort((a, b) => a - b)

      cuttingRef.current = true
      regions.clearRegions()
      const palette = readPalette()
      let made = 0
      unique.forEach((start, index) => {
        // Each slice runs to the next cut, so they tile the file with no gaps.
        const end = index + 1 < unique.length ? unique[index + 1] : duration
        if (end - start < 0.015) return
        regions.addRegion({ start, end, color: withAlpha(palette.ink, 0.1), drag: true, resize: true })
        made += 1
      })
      cuttingRef.current = false
      log('sampler', `${label}: ${made} Slices${snap ? ', an Nulldurchgänge gerastet' : ''}`)
    },
    [audio, duration, log, snap],
  )

  const chopTransients = () => {
    if (!audio) return
    applyCuts(detectOnsets(audio), 'Transienten')
  }

  const chopGrid = () => {
    if (!audio) return
    applyCuts(
      beatGrid({ bpm, offsetSeconds: tempo?.offsetSeconds ?? 0, beatsPerSlice: division, durationSeconds: duration }),
      `Raster ${bpm} BPM`,
    )
  }

  const chopEven = () => {
    if (!audio) return
    applyCuts(divideEvenly(duration, sliceCount), `${sliceCount} gleiche Teile`)
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

  const confident = (tempo?.confidence ?? 0) >= 0.5

  return (
    <div className="grid gap-[16px] lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-[16px]">
        <Card tone="keylime" size="compact">
          <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[4px]">
            <span className="text-small text-muted">
              Ziehen wählt einen Bereich, „Als Pad anlegen“ macht ihn zum Pad. Tasten 1–4 · Q–R · A–F · Y–V spielen.
            </span>
          </div>

          {!asset ? (
            <div className="mt-[16px]">
              <FileDrop />
            </div>
          ) : (
            <>
              <div className="sondra-wave mt-[16px] overflow-x-auto bg-panel-soft p-[16px]">
                <div ref={containerRef} />
                {!audio ? (
                  <p className="py-[28px] text-center text-small text-muted">
                    {status === 'decoding' ? 'Wird dekodiert…' : 'Warten auf Audio'}
                  </p>
                ) : null}
              </div>

              {/* A dragged range is a question, not a pad yet. */}
              {pending ? (
                <div className="mt-[8px] flex flex-wrap items-center gap-[8px] border-l-2 border-ink pl-[12px]">
                  <span className="value text-small text-ink">
                    {formatTimecode(pending.start)} – {formatTimecode(pending.end)} · {(pending.end - pending.start).toFixed(2)} s
                  </span>
                  <Button size="sm" variant="quiet" onClick={playPending}>
                    Auswahl hören
                  </Button>
                  <Button size="sm" onClick={confirmPending}>
                    Als Pad anlegen
                  </Button>
                  <Button size="sm" variant="ghost" onClick={discardPending}>
                    Verwerfen
                  </Button>
                  <span className="text-small text-muted">Eingabetaste legt an</span>
                </div>
              ) : null}

              {/* ---- chop controls ------------------------------------------ */}
              <div className="mt-[16px] grid gap-[12px] sm:grid-cols-3">
                <div className="flex flex-col gap-[8px] rounded-card bg-panel-soft p-[16px] ring-1 ring-inset ring-ink/20">
                  <span className="text-small font-semibold text-ink">
                    Nach Anschlägen
                  </span>
                  <p className="text-small leading-[1.4] text-muted">
                    Schneidet, wo etwas anfängt. Meistens die richtige Wahl.
                  </p>
                  <Button size="sm" onClick={chopTransients} disabled={!audio} className="mt-auto">
                    Schneiden
                  </Button>
                </div>

                <div className="flex flex-col gap-[8px] rounded-card bg-panel-soft p-[16px]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-small font-semibold text-ink">
                      Nach Takt
                    </span>
                    {tempo ? (
                      <span className="value text-micro text-muted">
                        {confident ? 'erkannt' : 'unsicher'}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-[4px]">
                    <button
                      type="button"
                      onClick={() => setBpm((value) => Math.max(30, Math.round(value / 2)))}
                      className="rounded-nav bg-panel-soft px-[8px] py-[4px] text-small text-ink hover:bg-panel-mid"
                      title="Halbes Tempo"
                    >
                      ÷2
                    </button>
                    <input
                      type="number"
                      value={bpm}
                      min={30}
                      max={300}
                      step={0.1}
                      onChange={(event) => setBpm(Number(event.target.value) || 120)}
                      aria-label="Tempo in BPM"
                      className="value w-full min-w-0 rounded-nav bg-panel-soft px-[8px] py-[4px] text-center text-small text-ink outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setBpm((value) => Math.min(300, Math.round(value * 2)))}
                      className="rounded-nav bg-panel-soft px-[8px] py-[4px] text-small text-ink hover:bg-panel-mid"
                      title="Doppeltes Tempo"
                    >
                      ×2
                    </button>
                  </div>
                  <Select
                    value={division}
                    onChange={(event) => setDivision(Number(event.target.value))}
                    aria-label="Rasterweite"
                    className="py-[8px] text-small"
                  >
                    {GRID_DIVISIONS.map((entry) => (
                      <option key={entry.label} value={entry.value}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" variant="quiet" onClick={chopGrid} disabled={!audio}>
                    Schneiden
                  </Button>
                </div>

                <div className="flex flex-col gap-[8px] rounded-card bg-panel-soft p-[16px]">
                  <span className="text-small font-semibold text-ink">
                    Gleiche Teile
                  </span>
                  <Select
                    value={sliceCount}
                    onChange={(event) => setSliceCount(Number(event.target.value))}
                    aria-label="Anzahl der Teile"
                    className="py-[8px] text-small"
                  >
                    {[2, 4, 8, 12, 16].map((count) => (
                      <option key={count} value={count}>
                        {count} Teile
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" variant="quiet" onClick={chopEven} disabled={!audio} className="mt-auto">
                    Schneiden
                  </Button>
                </div>
              </div>

              <div className="mt-[12px] flex flex-wrap items-center gap-[8px]">
                <Button size="sm" variant="quiet" disabled={!waveReady} onClick={() => void waveRef.current?.playPause()}>
                  {wavePlaying ? 'Pause' : 'Alles hören'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => regionsRef.current?.clearRegions()}>
                  Leeren
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    stopAll()
                    waveRef.current?.pause()
                  }}
                >
                  Stopp (Leertaste)
                </Button>
                <label className="ml-auto flex items-center gap-[8px] text-small text-muted">
                  Zoom
                  <input
                    type="range"
                    min={0}
                    max={400}
                    step={10}
                    value={zoom}
                    disabled={!waveReady}
                    onChange={(event) => setZoom(Number(event.target.value))}
                    className="w-[120px]"
                    aria-label="Zoom"
                  />
                </label>
              </div>
            </>
          )}
        </Card>

        {/* ---- pads --------------------------------------------------------- */}
        {slices.length > 0 ? (
          <Card tone="slate" size="compact">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <SectionHead>Pads · {slices.length}</SectionHead>
              {slices.length > MAX_PADS ? (
                <span className="text-small text-muted">
                  Nur die ersten {MAX_PADS} liegen auf Tasten; exportiert werden alle.
                </span>
              ) : null}
            </div>

            <div className="mt-[16px] grid max-w-[420px] grid-cols-4 gap-[8px]">
              {slices.slice(0, MAX_PADS).map((slice, index) => {
                const isPlaying = playing.includes(index)
                const isSelected = slice.id === activeSlice
                return (
                  <button
                    key={slice.id}
                    type="button"
                    onPointerDown={() => {
                      setActiveSlice(slice.id)
                      triggerPad(index)
                    }}
                    onPointerUp={() => {
                      if (slice.mode !== 'oneshot') stopPad(index)
                    }}
                    onPointerLeave={() => {
                      if (slice.mode === 'gate') stopPad(index)
                    }}
                    className={`press flex aspect-square flex-col justify-between rounded-card p-[8px] text-left ${
                      isPlaying
                        ? 'bg-ink text-on-ink'
                        : isSelected
                          ? 'bg-panel-mid text-ink ring-1 ring-inset ring-ink/40'
                          : 'bg-raised text-ink hover:bg-panel-soft'
                    }`}
                  >
                    <span className="flex items-center justify-between text-small font-semibold opacity-70">
                      {PAD_KEYS[index]}
                      <span className="flex gap-[4px] text-micro">
                        {slice.reverse ? '◀' : ''}
                        {slice.mode === 'loop' ? '∞' : slice.mode === 'gate' ? '⌷' : ''}
                        {slice.semitones !== 0 ? (slice.semitones > 0 ? `+${slice.semitones}` : slice.semitones) : ''}
                      </span>
                    </span>
                    {audio ? <PadWave audio={audio} from={slice.start} to={slice.end} /> : null}
                    <span className="value text-micro opacity-70">
                      {(slice.end - slice.start).toFixed(2)} s
                    </span>
                  </button>
                )
              })}
            </div>

            {/* The chosen pad comes first: what was cut is what goes on. All
                chops at once is a pack, and a pack belongs in a ZIP — only a
                handful are offered for the session, never a few hundred. */}
            <div className="mt-[16px] flex flex-wrap gap-[8px]">
              {selected ? (
                <>
                  <Button size="sm" onClick={() => exportOne(selected, selectedIndex, 'file')} disabled={rendering}>
                    Pad {selectedIndex + 1} als WAV
                    <ArrowRight />
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => exportOne(selected, selectedIndex, 'session')} disabled={rendering}>
                    Pad {selectedIndex + 1} in die Sitzung
                  </Button>
                </>
              ) : (
                <span className="self-center text-small text-muted">Pad antippen, um ihn einzeln zu speichern.</span>
              )}
              <Button size="sm" variant="quiet" onClick={() => renderAll('zip')} disabled={rendering}>
                {rendering ? 'Rendert…' : `Alle ${slices.length} als ZIP`}
              </Button>
              {slices.length <= MAX_PADS ? (
                <Button size="sm" variant="quiet" onClick={() => renderAll('session')} disabled={rendering}>
                  Alle {slices.length} in die Sitzung
                </Button>
              ) : null}
            </div>

            {rendering ? (
              <div className="mt-[12px]">
                <Progress value={progress} label="Wird gerendert" />
              </div>
            ) : null}
          </Card>
        ) : null}

        {/* ---- pattern ------------------------------------------------------ */}
        {slices.length > 0 ? (
          <StepSequencer
            slices={slices}
            buffers={() => (bufferRef.current ? { forward: bufferRef.current, reversed: reversedRef.current } : null)}
            initialBpm={bpm}
            choke={choke}
            baseName={baseName}
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

        {audio && slices.length === 0 ? (
          <Notice title="Noch nichts zerschnitten">
            Wählen Sie oben ein Verfahren, oder ziehen Sie mit der Maus über die Wellenform und legen
            den Bereich dann als Pad an.
          </Notice>
        ) : null}
      </div>

      {/* ---- sidebar: the selected pad, then defaults --------------------- */}
      <aside className="flex flex-col gap-[16px]">
        <Card tone="mint" size="compact">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <SectionHead>{selected ? `Pad ${selectedIndex + 1}` : 'Pad'}</SectionHead>
            {selected ? (
              <button
                type="button"
                onClick={applyToAll}
                className="rounded-nav text-small text-muted underline-offset-2 hover:text-ink hover:underline"
              >
                Auf alle übertragen
              </button>
            ) : null}
          </div>

          {selected ? (
            <div className="mt-[12px] flex flex-wrap gap-[8px]">
              <Button size="sm" variant="quiet" onClick={() => triggerPad(selectedIndex)}>
                Anhören
              </Button>
              <Button size="sm" variant="ghost" onClick={() => deletePad(selected.id)} title="Entf">
                Pad löschen
              </Button>
            </div>
          ) : null}

          {selected ? (
            <div className="mt-[12px] flex flex-col gap-[16px]">
              <div className="flex flex-wrap gap-[4px]">
                <Badge>{formatTimecode(selected.start)}</Badge>
                <Badge tone="forest">{(selected.end - selected.start).toFixed(3)} s</Badge>
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
                display={`${selected.gainDb > 0 ? '+' : ''}${selected.gainDb.toFixed(1)} dB`}
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
              <Field label="Verhalten">
                <Select
                  value={selected.mode}
                  onChange={(event) => updateSlice(selected.id, { mode: event.target.value as PlayMode })}
                >
                  {(Object.keys(MODE_LABELS) as PlayMode[]).map((mode) => (
                    <option key={mode} value={mode}>
                      {MODE_LABELS[mode]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Toggle
                label="Rückwärts"
                checked={selected.reverse}
                onChange={(value) => updateSlice(selected.id, { reverse: value })}
              />

              {/* The pads play at varispeed and without fades, because that has
                  to be instant. The export goes through the phase vocoder and
                  the blends, so it can sound different — this is that version. */}
              {rendered?.id === selected.id ? (
                <AudioPreview
                  sources={[{ id: rendered.id, label: 'Wie exportiert', audio: rendered.audio }]}
                  waveHeight={40}
                />
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
                  {rendering ? 'Rendert…' : 'So anhören, wie es exportiert wird'}
                </Button>
              )}
            </div>
          ) : (
            <p className="mt-[12px] text-small leading-[1.5] text-muted">
              Ein Pad anklicken oder eine Taste drücken, um es hier einzustellen. Tonhöhe, Pegel,
              Richtung und Verhalten gelten je Pad.
            </p>
          )}
        </Card>

        <Card tone="cream" size="compact">
          <SectionHead>Voreinstellungen</SectionHead>
          <div className="mt-[12px] flex flex-col gap-[16px]">
            <Field label="Neue Pads spielen als">
              <Select value={defaultMode} onChange={(event) => setDefaultMode(event.target.value as PlayMode)}>
                {(Object.keys(MODE_LABELS) as PlayMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABELS[mode]}
                  </option>
                ))}
              </Select>
            </Field>
            <Slider
              label="Blende"
              display={`${fadeMs} ms`}
              min={0}
              max={60}
              step={1}
              value={fadeMs}
              onChange={(event) => setFadeMs(Number(event.target.value))}
            />
            <Toggle
              label="An Nulldurchgänge rasten"
              hint="Verschiebt Schnitte um wenige Millisekunden und spart die Klicks."
              checked={snap}
              onChange={setSnap}
            />
            <Toggle
              label="Neuer Anschlag stoppt den alten"
              checked={choke}
              onChange={setChoke}
            />
            <Toggle
              label="Länge beim Transponieren halten"
              hint="Phasenvocoder beim Export. Die Pads spielen immer per Abspielrate."
              checked={preserveDuration}
              onChange={setPreserveDuration}
            />
            <Toggle label="Auf −0,3 dBFS normalisieren" checked={normalize} onChange={setNormalize} />
          </div>
        </Card>

      </aside>
    </div>
  )
}
