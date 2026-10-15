/**
 * The plain audio editor: pick a stretch, do something to it, hear it, save it.
 *
 * Everything here is arithmetic on sample buffers that already existed for the
 * sampler and the loudness tools — nothing is fetched, nothing is uploaded, and
 * no WebAssembly has to load before the first cut. The panel's whole job is to
 * put a selection on a waveform and a history behind it.
 *
 * Non-destructive in the way that matters: the session file is never touched.
 * Every operation produces new audio, the previous version stays on a stack,
 * and the original is one click away no matter how many steps have been taken.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { getAudioContext, resumeAudioContext, sliceAudio, applyFades, reverseAudio, toAudioBuffer, fromAudioBuffer } from '../../lib/audio'
import { detectSilenceRegions, stripSilence } from '../../lib/audio/silence'
import { saveBytes } from '../../lib/download'
import {
  channelTrick,
  concatAudio,
  cutRange,
  durationOf,
  frameCount,
  normalizePeak,
  peakDb,
  removeDcOffset,
  resampleAudio,
  setChannels,
} from '../../lib/edit'
import {
  copyRange,
  duplicateRange,
  fadeRange,
  insertAt,
  insertSilence,
  learnNoise,
  muteRange,
  processRange,
  removeNoise,
} from '../../lib/effects'
import {
  createShifter,
  loadShifter,
  NEUTRAL_SOUND,
  renderSound,
  soundIsNeutral,
  SoundChain,
  tailSeconds,
  type SoundSettings,
} from '../../lib/liveSound'
import { removeClicks, type ClickStrength } from '../../lib/declick'
import { formatBytes, formatTimecode } from '../../lib/format'
import { pitchShift, stretchAudio } from '../../lib/timestretch'
import { encodeWav, type AudioData, type WavBitDepth } from '../../lib/wav'
import { useDecodedAudio } from '../../hooks/useDecodedAudio'
import { useActiveAssetOfKind, useAssetsOfKind, useSession } from '../../state/store'
import { FileDrop } from '../FileDrop'
import type { WaveFade } from '../Waveform'
import { ChoiceRow, EditorShell, IconButton, ToolHeading, type EditorTool } from '../editor/EditorShell'
import {
  IconClean,
  IconCut,
  IconEq,
  IconExport,
  IconHistory,
  IconLevel,
  IconLoop,
  IconPause,
  IconPlay,
  IconRedo,
  IconRoom,
  IconStop,
  IconTempo,
  IconUndo,
  IconZoomIn,
  IconZoomOut,
} from '../editor/icons'
import { SoundStage } from '../editor/SoundStage'
import { ArrowRight, Button, Card, Notice, Select, Slider, Toggle } from '../ui/primitives'

/** The rail: one job each, and only that job's controls in the column beside it. */
type ToolId = 'schnitt' | 'pegel' | 'klang' | 'saeubern' | 'raum' | 'tempo' | 'ausgabe' | 'verlauf'

/** What can be switched on to be heard live, before it is written in. */
type LiveId = 'fade' | 'highpass' | 'lowpass' | 'tone' | 'comp' | 'clicks' | 'noise' | 'echo' | 'room' | 'pitch' | 'tempo'

/** The live shifter's speed: the new pitch, divided by how fast the file runs. */
const shifterRatio = (semitones: number, tempo: number) => Math.min(4, Math.max(0.25, 2 ** (semitones / 12) / tempo))

const comma = (value: number, digits = 1) => value.toFixed(digits).replace('.', ',')

interface Step {
  audio: AudioData
  /** What produced it, for the history line. */
  label: string
}

export function AudioEditorPanel() {
  const asset = useActiveAssetOfKind('audio')
  const others = useAssetsOfKind('audio')
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)
  const { audio: decoded, decode, status } = useDecodedAudio(asset)

  const [history, setHistory] = useState<Step[]>([])
  const [future, setFuture] = useState<Step[]>([])
  const [current, setCurrent] = useState<AudioData | null>(null)
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null)
  const [dragging, setDragging] = useState<{ start: number; end: number } | null>(null)
  const [position, setPosition] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gain, setGain] = useState(0)
  const [fadeIn, setFadeIn] = useState(0.05)
  const [fadeOut, setFadeOut] = useState(0.05)
  const [semitones, setSemitones] = useState(0)
  const [tempo, setTempo] = useState(1)
  const [bitDepth, setBitDepth] = useState<WavBitDepth>(24)
  const [joinWith, setJoinWith] = useState('')
  /** What „Kopieren“ or „Ausschneiden“ put aside, for „Einfügen“. */
  const [clipboard, setClipboard] = useState<AudioData | null>(null)
  /** The stretch of time the waveform shows; null is all of it. */
  const [view, setView] = useState<{ start: number; end: number } | null>(null)
  const [loop, setLoop] = useState(false)
  const [silenceLength, setSilenceLength] = useState(1)
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-45)
  const [silenceModalOpen, setSilenceModalOpen] = useState(false)
  const silenceDialogRef = useRef<HTMLDialogElement | null>(null)
  const [targetPeakDb, setTargetPeakDb] = useState(-0.3)
  const [tapTimes, setTapTimes] = useState<number[]>([])
  const [tappedBpm, setTappedBpm] = useState<number | null>(null)

  const handleTap = useCallback(() => {
    const now = performance.now()
    setTapTimes((prev) => {
      const valid = prev.length > 0 && now - prev[prev.length - 1] > 2500 ? [] : prev
      const updated = [...valid, now].slice(-8)
      if (updated.length >= 2) {
        const deltas: number[] = []
        for (let i = 1; i < updated.length; i++) {
          deltas.push(updated[i] - updated[i - 1])
        }
        const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length
        if (avg > 0) {
          const calculated = Math.round(60000 / avg)
          if (calculated >= 30 && calculated <= 300) {
            setTappedBpm(calculated)
          }
        }
      }
      return updated
    })
  }, [])
  // Sound shaping.
  const [highpassHz, setHighpassHz] = useState(80)
  const [lowpassHz, setLowpassHz] = useState(12000)
  const [bassDb, setBassDb] = useState(0)
  const [trebleDb, setTrebleDb] = useState(0)
  const [compThreshold, setCompThreshold] = useState(-24)
  const [compRatio, setCompRatio] = useState(3)
  const [noise, setNoise] = useState<Float32Array | null>(null)
  const [noiseCut, setNoiseCut] = useState(12)
  const [clickStrength, setClickStrength] = useState<ClickStrength>('mittel')
  const [declicked, setDeclicked] = useState<{ source: AudioData; strength: ClickStrength; audio: AudioData; repaired: number } | null>(null)
  const [echoDelay, setEchoDelay] = useState(300)
  const [echoFeedback, setEchoFeedback] = useState(0.35)
  const [echoMix, setEchoMix] = useState(0.4)
  const [roomSeconds, setRoomSeconds] = useState(1.6)
  const [roomMix, setRoomMix] = useState(0.3)
  const frameRef = useRef<HTMLDivElement>(null)
  /** What is switched on and therefore heard; written in by „Übernehmen“. */
  const [on, setOn] = useState<Partial<Record<LiveId, boolean>>>({})
  /** Hear the file as it is, without anything switched on. */
  const [compare, setCompare] = useState(false)
  const [denoised, setDenoised] = useState<{ source: AudioData; profile: Float32Array; cut: number; audio: AudioData } | null>(null)
  /** The fades as last heard: the buffer is rebuilt when a slider rests. */
  const [fadeHeard, setFadeHeard] = useState({ in: 0.05, out: 0.05 })
  /** A selection fade whose button is under the pointer — drawn, not yet done. */
  const [fadeHover, setFadeHover] = useState<'in' | 'out' | null>(null)
  const engineRef = useRef<{
    context: AudioContext
    source: AudioBufferSourceNode
    chain: SoundChain
    shifter: AudioWorkletNode | null
    audio: AudioData
    at: number
  } | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (asset && !decoded && status === 'idle') void decode()
  }, [asset, decoded, status, decode])

  // Starts over only for a different file. The same file arriving again —
  // decoded a second time, or its entry updated in the session — must not
  // throw away the edits made on it.
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    const id = decoded ? (asset?.id ?? null) : null
    if (id !== null && id === loadedFor.current) return
    loadedFor.current = id
    setCurrent(decoded ?? null)
    setHistory([])
    setFuture([])
    setSelection(null)
    setView(null)
    setNoise(null)
    setError(null)
  }, [decoded, asset?.id])

  const duration = current ? durationOf(current) : 0
  const span = selection ?? { start: 0, end: duration }
  const hasSelection = selection !== null && selection.end - selection.start > 0.01

  /* -- doing things -------------------------------------------------------- */

  /**
   * Runs one operation and remembers the version it replaced.
   *
   * Yields to the browser first: a minute of audio is several million samples,
   * and without the gap the button never gets to show that it was pressed.
   */
  const apply = useCallback(
    async (label: string, operation: (audio: AudioData) => AudioData | Promise<AudioData>): Promise<boolean> => {
      if (!current) return false
      setBusy(label)
      setError(null)
      await new Promise((resolve) => setTimeout(resolve, 16))
      const maxHistorySteps = duration > 1800 ? 5 : duration > 600 ? 10 : 20
      try {
        const next = await operation(current)
        if (frameCount(next) === 0) throw new Error('Das hätte nichts übrig gelassen.')
        setHistory((stack) => [...stack.slice(-(maxHistorySteps - 1)), { audio: current, label }])
        setFuture([])
        // A selection is a pair of timestamps, and an operation that changes
        // the length moves everything after it. Keeping the old marks would
        // leave a highlight pointing at material that is no longer there.
        if (frameCount(next) !== frameCount(current)) {
          setSelection(null)
          setView(null)
        }
        setCurrent(next)
        log('ton', `${label} — ${formatTimecode(durationOf(next))}, Spitze ${peakDb(next).toFixed(1)} dBFS`)
        return true
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
        return false
      } finally {
        setBusy(null)
      }
    },
    [current, duration, log],
  )

  const undo = useCallback(() => {
    const maxHistorySteps = duration > 1800 ? 5 : duration > 600 ? 10 : 20
    setHistory((stack) => {
      const last = stack.at(-1)
      if (!last || !current) return stack
      setFuture((ahead) => [{ audio: current, label: last.label }, ...ahead].slice(0, maxHistorySteps))
      setCurrent(last.audio)
      return stack.slice(0, -1)
    })
  }, [current, duration])

  const redo = useCallback(() => {
    const maxHistorySteps = duration > 1800 ? 5 : duration > 600 ? 10 : 20
    setFuture((ahead) => {
      const next = ahead[0]
      if (!next || !current) return ahead
      setHistory((stack) => [...stack.slice(-(maxHistorySteps - 1)), { audio: current, label: next.label }])
      setCurrent(next.audio)
      return ahead.slice(1)
    })
  }, [current, duration])

  // The clipboard handlers change with every render; the listener reads the
  // current ones through this ref instead of being re-attached each time.
  const shortcutsRef = useRef<Record<'c' | 'x' | 'v', () => boolean>>({ c: () => false, x: () => false, v: () => false })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      const key = event.key.toLowerCase()

      if (key === 't' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        handleTap()
        return
      }

      if (!(event.metaKey || event.ctrlKey)) return
      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (key === 'c' || key === 'x' || key === 'v') {
        // Only when there is audio to act on — otherwise the page's own copy
        // and paste stay untouched.
        const handler = shortcutsRef.current[key]
        if (handler && handler()) event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, handleTap])

  /* -- live: what is switched on is what is heard ------------------------- */

  const enable = (id: LiveId) => setOn((value) => (value[id] ? value : { ...value, [id]: true }))
  const toggle = (id: LiveId) => (value: boolean) => setOn((state) => ({ ...state, [id]: value }))

  /** The settings as they will be written in, whatever the comparison says. */
  const wanted: SoundSettings = useMemo(
    () => ({
      gainDb: gain,
      highpassHz: on.highpass ? highpassHz : null,
      lowpassHz: on.lowpass ? lowpassHz : null,
      bassDb: on.tone ? bassDb : 0,
      trebleDb: on.tone ? trebleDb : 0,
      compressor: on.comp ? { thresholdDb: compThreshold, ratio: compRatio } : null,
      echo: on.echo ? { delayMs: echoDelay, feedback: echoFeedback, mix: echoMix } : null,
      room: on.room ? { seconds: roomSeconds, mix: roomMix } : null,
    }),
    [gain, on, highpassHz, lowpassHz, bassDb, trebleDb, compThreshold, compRatio, echoDelay, echoFeedback, echoMix, roomSeconds, roomMix],
  )
  const sound = compare ? NEUTRAL_SOUND : wanted
  const livePitch = !compare && on.pitch ? semitones : 0
  const liveTempo = !compare && on.tempo ? tempo : 1
  const fading = Boolean(on.fade) && (fadeIn > 0 || fadeOut > 0)
  const noiseLive = Boolean(on.noise) && noise !== null
  const clickLive = Boolean(on.clicks)

  // Clicks and noise run over the whole file, so they are heard from second
  // buffers: clicks first, then noise on what is left, each rebuilt when its
  // input or its setting changes.
  const clickReady = declicked !== null && declicked.source === current && declicked.strength === clickStrength
  useEffect(() => {
    if (!clickLive || !current || clickReady) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      const { audio, repaired } = removeClicks(current, clickStrength)
      if (!cancelled) setDeclicked({ source: current, strength: clickStrength, audio, repaired })
    }, 40)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [clickLive, current, clickStrength, clickReady])
  const cleanBase = clickLive ? (clickReady && declicked ? declicked.audio : null) : current

  const noiseReady =
    denoised !== null && cleanBase !== null && denoised.source === cleanBase && denoised.profile === noise && denoised.cut === noiseCut
  useEffect(() => {
    if (!noiseLive || !cleanBase || !noise || noiseReady) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      const audio = removeNoise(cleanBase, noise, noiseCut)
      if (!cancelled) setDenoised({ source: cleanBase, profile: noise, cut: noiseCut, audio })
    }, 40)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [noiseLive, cleanBase, noise, noiseCut, noiseReady])

  useEffect(() => {
    const timer = window.setTimeout(() => setFadeHeard({ in: fadeIn, out: fadeOut }), 160)
    return () => window.clearTimeout(timer)
  }, [fadeIn, fadeOut])

  /** The buffer that plays: the file, cleaned and faded if that is switched on. */
  const liveAudio = useMemo(() => {
    if (!current || compare) return current
    let audio = noiseLive && noiseReady && denoised ? denoised.audio : (cleanBase ?? current)
    if (fading && (fadeHeard.in > 0 || fadeHeard.out > 0)) audio = applyFades(audio, fadeHeard.in, fadeHeard.out)
    return audio
  }, [current, compare, noiseLive, noiseReady, denoised, cleanBase, fading, fadeHeard])

  /** In words, for the bar under the waveform and the history. */
  const liveParts: string[] = []
  if (gain !== 0) liveParts.push(`Pegel ${gain > 0 ? '+' : ''}${comma(gain)} dB`)
  if (fading) liveParts.push(`Blenden ${comma(fadeIn, 2)} / ${comma(fadeOut, 2)} s`)
  if (on.highpass) liveParts.push(`Tiefen unter ${highpassHz} Hz weg`)
  if (on.lowpass) liveParts.push(`Höhen über ${comma(lowpassHz / 1000)} kHz weg`)
  if (on.tone && (bassDb !== 0 || trebleDb !== 0)) liveParts.push(`Bass ${bassDb > 0 ? '+' : ''}${bassDb} dB, Höhen ${trebleDb > 0 ? '+' : ''}${trebleDb} dB`)
  if (on.comp) liveParts.push(`Kompressor ${comma(compRatio)}:1 ab ${compThreshold} dBFS`)
  if (clickLive) liveParts.push(clickReady && declicked ? `${declicked.repaired} ${declicked.repaired === 1 ? 'Klick' : 'Klicks'} entfernt (${clickStrength})` : 'Klicks entfernen')
  if (noiseLive) liveParts.push(`Rauschen bis ${noiseCut} dB leiser`)
  if (on.echo) liveParts.push(`Echo ${echoDelay} ms`)
  if (on.room) liveParts.push(`Hall ${comma(roomSeconds)} s`)
  if (on.tempo && tempo !== 1) liveParts.push(`Tempo ${comma(tempo, 2)}×`)
  if (on.pitch && semitones !== 0) liveParts.push(`Tonhöhe ${semitones > 0 ? '+' : ''}${semitones}`)

  /** Writes what is heard into the audio, then switches it all off again. */
  const commit = async () => {
    const ranged = hasSelection
    const label = liveParts.join(' · ') + (ranged ? ' (Ausschnitt)' : '')
    const done = await apply(label, async (input) => {
      let audio = input
      const part = (fn: (a: AudioData) => AudioData | Promise<AudioData>) =>
        ranged ? processRange(audio, span.start, span.end, fn) : Promise.resolve(fn(audio))
      if (clickLive) audio = await part((a) => removeClicks(a, clickStrength).audio)
      if (noiseLive && noise) audio = await part((a) => removeNoise(a, noise, noiseCut))
      if (!soundIsNeutral(wanted)) audio = await part((a) => renderSound(a, wanted, !ranged))
      if (fading) audio = applyFades(audio, fadeIn, fadeOut)
      // Tempo and pitch go through the phase vocoder: cleaner than the live
      // shifter, and over the whole file, since they change what follows.
      if (on.tempo && tempo !== 1) audio = stretchAudio(audio, 1 / tempo)
      if (on.pitch && semitones !== 0) audio = pitchShift(audio, { semitones, preserveDuration: true })
      return audio
    })
    if (done) {
      if (on.pitch) setSemitones(0)
      if (on.tempo) setTempo(1)
      setOn({})
      setGain(0)
      setCompare(false)
    }
  }

  const applyPitchShift = () => {
    if (semitones === 0) return
    const label = `Tonhöhe ${semitones > 0 ? '+' : ''}${semitones} Halbtöne` + (hasSelection ? ' (Ausschnitt)' : '')
    void apply(label, async (a) => {
      if (hasSelection) {
        return processRange(a, span.start, span.end, (part) =>
          pitchShift(part, { semitones, preserveDuration: true })
        )
      }
      return pitchShift(a, { semitones, preserveDuration: true })
    }).then((ok) => {
      if (ok) {
        setOn((s) => ({ ...s, pitch: false }))
        setSemitones(0)
      }
    })
  }

  const applyTimeStretch = () => {
    if (tempo === 1) return
    const label = `Tempo ${comma(tempo, 2)}×` + (hasSelection ? ' (Ausschnitt)' : '')
    void apply(label, async (a) => {
      if (hasSelection) {
        return processRange(a, span.start, span.end, (part) =>
          stretchAudio(part, 1 / tempo)
        )
      }
      return stretchAudio(a, 1 / tempo)
    }).then((ok) => {
      if (ok) {
        setOn((s) => ({ ...s, tempo: false }))
        setTempo(1)
      }
    })
  }

  /* -- playing ------------------------------------------------------------- */

  const soundRef = useRef(sound)
  soundRef.current = sound
  const tempoRef = useRef(liveTempo)
  tempoRef.current = liveTempo
  const pitchRef = useRef(livePitch)
  pitchRef.current = livePitch

  /** `ringOut` lets echo and room fade on after the last sample. */
  const stop = useCallback((ringOut = false) => {
    const engine = engineRef.current
    engineRef.current = null
    if (engine) {
      try {
        engine.source.stop()
      } catch {
        /* never started */
      }
      const drop = () => {
        engine.chain.dispose()
        engine.shifter?.disconnect()
        engine.source.disconnect()
      }
      if (ringOut) window.setTimeout(drop, tailSeconds(soundRef.current) * 1000 + 150)
      else drop()
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPosition(null)
  }, [])

  const play = useCallback(async (startAt?: number) => {
    if (!liveAudio) return
    stop()
    await resumeAudioContext()
    const context = getAudioContext()
    const canShift = await loadShifter(context)
    const from = hasSelection ? span.start : 0
    const until = hasSelection ? span.end : duration
    const begin = startAt !== undefined && startAt >= from && startAt < until ? startAt : from
    const source = context.createBufferSource()
    source.buffer = toAudioBuffer(liveAudio, context)
    source.playbackRate.value = tempoRef.current
    const chain = new SoundChain(context, context.destination, soundRef.current)
    let shifter: AudioWorkletNode | null = null
    if (canShift) {
      shifter = createShifter(context)
      shifter.parameters.get('ratio')!.value = shifterRatio(pitchRef.current, tempoRef.current)
      source.connect(shifter).connect(chain.input)
    } else {
      source.connect(chain.input)
    }
    if (loop) {
      // Round and round until „Stopp“ — the way a cut is judged in a DAW.
      source.loop = true
      source.loopStart = from
      source.loopEnd = until
      source.start(0, begin)
    } else {
      source.start(0, begin, Math.max(0.01, until - begin))
    }
    const engine = { context, source, chain, shifter, audio: liveAudio, at: begin }
    engineRef.current = engine
    // The playhead follows the file's own time, which runs at the tempo.
    let last = context.currentTime
    const follow = () => {
      if (engineRef.current !== engine) return
      const now = context.currentTime
      engine.at += (now - last) * tempoRef.current
      last = now
      if (loop) {
        while (engine.at >= until) engine.at -= Math.max(0.01, until - from)
      } else if (engine.at >= until) {
        return stop(true)
      }
      setPosition(engine.at)
      rafRef.current = requestAnimationFrame(follow)
    }
    follow()
  }, [liveAudio, hasSelection, span.start, span.end, duration, stop, loop])

  // Sliders move the running graph; nothing restarts.
  useEffect(() => {
    engineRef.current?.chain.update(sound)
  }, [sound])
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    const now = engine.context.currentTime
    engine.source.playbackRate.setTargetAtTime(liveTempo, now, 0.02)
    engine.shifter?.parameters.get('ratio')!.setValueAtTime(shifterRatio(livePitch, liveTempo), now)
  }, [livePitch, liveTempo])
  // A new buffer (a fade, the noise, an edit) takes over where playback is.
  const playRef = useRef(play)
  playRef.current = play
  useEffect(() => {
    const engine = engineRef.current
    if (engine && liveAudio && engine.audio !== liveAudio) void playRef.current(engine.at)
  }, [liveAudio])

  useEffect(() => stop, [stop])

  /* -- selecting ----------------------------------------------------------- */

  // What the waveform shows. Zoomed in, it is a slice of the file, and every
  // position on it is offset by where that slice starts.
  const viewStart = view ? Math.min(view.start, duration) : 0
  const viewEnd = view ? Math.min(view.end, duration) : duration
  const shown = useMemo(
    () => (current && view ? sliceAudio(current, viewStart, viewEnd) : current),
    [current, view, viewStart, viewEnd],
  )

  // The wheel over the waveform zooms around the pointer; with Shift (or a
  // sideways swipe) it moves the view along. A native listener, because React
  // registers wheel handlers as passive and the page would scroll as well.
  const wheelRef = useRef({ duration, viewStart, viewEnd })
  wheelRef.current = { duration, viewStart, viewEnd }
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const onWheel = (event: WheelEvent) => {
      const { duration: total, viewStart: start, viewEnd: end } = wheelRef.current
      if (total <= 0) return
      event.preventDefault()
      const box = frame.getBoundingClientRect()
      const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
      const span = end - start
      const sideways = event.shiftKey ? event.deltaY : event.deltaX
      if (Math.abs(sideways) > Math.abs(event.shiftKey ? 0 : event.deltaY)) {
        if (span >= total) return
        const shift = (sideways / box.width) * span
        const nextStart = Math.min(total - span, Math.max(0, start + shift))
        setView({ start: nextStart, end: nextStart + span })
        return
      }
      const at = start + fraction * span
      const nextSpan = Math.min(total, Math.max(0.05, span * Math.exp(event.deltaY * 0.0015)))
      if (nextSpan >= total * 0.999) {
        setView(null)
        return
      }
      const nextStart = Math.min(total - nextSpan, Math.max(0, at - fraction * nextSpan))
      setView({ start: nextStart, end: nextStart + nextSpan })
    }
    frame.addEventListener('wheel', onWheel, { passive: false })
    return () => frame.removeEventListener('wheel', onWheel)
  }, [current])

  const secondsAt = (clientX: number) => {
    const box = frameRef.current?.getBoundingClientRect()
    if (!box || duration <= 0) return 0
    const fraction = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
    return viewStart + fraction * (viewEnd - viewStart)
  }

  const live = dragging
    ? { start: Math.min(dragging.start, dragging.end), end: Math.max(dragging.start, dragging.end) }
    : selection
  const liveInView =
    live && live.end > viewStart && live.start < viewEnd
      ? { start: Math.max(live.start, viewStart) - viewStart, end: Math.min(live.end, viewEnd) - viewStart }
      : null
  const positionInView = position !== null && position >= viewStart && position <= viewEnd ? position - viewStart : null

  // The fades as they will fall: the file's own ends while the fade switch is
  // on, and the selection while a pointer rests on one of its fade buttons.
  const fadeShapes: WaveFade[] = []
  if (fading && !compare) {
    const lead = Math.min(fadeIn, duration)
    if (lead > 0) fadeShapes.push({ from: 0, to: lead, direction: 'in' })
    const tail = Math.min(fadeOut, duration - lead)
    if (tail > 0) fadeShapes.push({ from: duration - tail, to: duration, direction: 'out' })
  }
  if (fadeHover && hasSelection) fadeShapes.push({ from: span.start, to: span.end, direction: fadeHover })
  // The waveform draws the view, so the fades move into its time.
  const fadesInView = useMemo(
    () => fadeShapes.map((fade) => ({ ...fade, from: fade.from - viewStart, to: fade.to - viewStart })),
    [fadeShapes.map((fade) => `${fade.direction}${fade.from}-${fade.to}`).join(','), viewStart],
  )

  const copySelection = () => {
    if (!current || !hasSelection) return
    setClipboard(copyRange(current, span.start, span.end))
    log('ton', `${(span.end - span.start).toFixed(2)} s kopiert`)
  }
  const cutSelection = () => {
    if (!current || !hasSelection) return
    setClipboard(copyRange(current, span.start, span.end))
    void apply('Ausgeschnitten', (audio) => cutRange(audio, span.start, span.end))
  }
  const paste = () => {
    if (!clipboard) return
    // Into the selection's place if there is one; otherwise where the playhead
    // stopped, or at the end.
    const at = hasSelection ? span.start : (position ?? duration)
    void apply(`${durationOf(clipboard).toFixed(2)} s eingefügt`, (audio) =>
      insertAt(hasSelection ? cutRange(audio, span.start, span.end) : audio, at, clipboard),
    )
  }
  const textSelected = () => (window.getSelection()?.toString() ?? '').length > 0
  shortcutsRef.current = {
    c: () => (hasSelection && !textSelected() ? (copySelection(), true) : false),
    x: () => (hasSelection && !textSelected() ? (cutSelection(), true) : false),
    v: () => (clipboard ? (paste(), true) : false),
  }

  /* -- output --------------------------------------------------------------- */

  const bytes = useMemo(() => (current ? encodeWav(current, bitDepth) : null), [current, bitDepth])
  const outputName = asset ? `${asset.name.replace(/\.[^.]+$/, '')}-bearbeitet.wav` : 'bearbeitet.wav'

  const keep = () => {
    if (!bytes) return
    addAsset({
      name: outputName,
      bytes,
      mime: 'audio/wav',
      sizeBytes: bytes.byteLength,
      kind: 'audio',
      audio: current,
      durationSeconds: duration,
      origin: 'derived',
    })
    log('ton', `${outputName} in die Sitzung übernommen`)
  }

  /* -- the studio around it ---------------------------------------------- */

  const [tool, setTool] = useState<ToolId>('schnitt')

  // The space bar starts and stops, as in every program that plays sound.
  // Left alone in fields and on buttons, where it already means something.
  const transportRef = useRef({ ready: false, toggle: () => {} })
  transportRef.current = {
    ready: current !== null,
    toggle: () => (engineRef.current ? stop() : void play()),
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ' ' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable)) return
      if (!transportRef.current.ready) return
      event.preventDefault()
      transportRef.current.toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const currentBuffer = useMemo(() => {
    if (!current) return null
    return toAudioBuffer(current, getAudioContext())
  }, [current])

  const detectedSilenceRegions = useMemo(() => {
    if (!currentBuffer || (!silenceModalOpen && tool !== 'saeubern')) return []
    return detectSilenceRegions(currentBuffer, silenceThresholdDb, 300)
  }, [currentBuffer, silenceModalOpen, tool, silenceThresholdDb])

  const totalSilenceDuration = useMemo(() => {
    return detectedSilenceRegions.reduce((sum, r) => sum + r.duration, 0)
  }, [detectedSilenceRegions])

  const handleConfirmStripSilence = useCallback(async () => {
    if (!current) return
    setSilenceModalOpen(false)
    const ctx = getAudioContext()
    await apply(`Stille entfernt (${silenceThresholdDb} dBFS)`, (audioData) => {
      const inBuf = toAudioBuffer(audioData, ctx)
      const outBuf = stripSilence(inBuf, ctx, silenceThresholdDb, 300)
      return fromAudioBuffer(outBuf)
    })
  }, [apply, current, silenceThresholdDb])

  useEffect(() => {
    const node = silenceDialogRef.current
    if (!node) return
    if (silenceModalOpen && !node.open) {
      node.showModal()
    } else if (!silenceModalOpen && node.open) {
      node.close()
    }
  }, [silenceModalOpen])

  /** Zooms around the playhead, the selection, or the middle of the view. */
  const zoomBy = (factor: number) => {
    if (duration <= 0) return
    const centre = position ?? (hasSelection ? (span.start + span.end) / 2 : (viewStart + viewEnd) / 2)
    const next = Math.min(duration, Math.max(0.05, (viewEnd - viewStart) * factor))
    if (next >= duration * 0.999) {
      setView(null)
      return
    }
    const from = Math.min(duration - next, Math.max(0, centre - next / 2))
    setView({ start: from, end: from + next })
  }

  if (!asset) {
    return (
      <Card tone="keylime">
        <h2 className="display-md mt-[8px] mb-[12px]">Schneiden, blenden, angleichen</h2>
        <p className="mb-[16px] max-w-[62ch] text-body leading-[1.55] text-prose/85">
          In der Sitzung liegt noch keine Tondatei. Alles hier rechnet direkt auf den Abtastwerten —
          kein Warten auf eine Engine, und die Ausgangsdatei wird nie verändert.
        </p>
        <FileDrop />
      </Card>
    )
  }

  if (!current) {
    return (
      <Card tone="keylime">
        <p className="mt-[16px] text-small text-muted">
          {status === 'decoding' ? 'Wird dekodiert…' : status === 'error' ? 'Diese Datei lässt sich nicht dekodieren.' : 'Wird vorbereitet…'}
        </p>
      </Card>
    )
  }

  const playing = position !== null
  const where = hasSelection ? 'den Ausschnitt' : 'die ganze Datei'
  const idle = busy !== null
  const save = () => {
    if (!bytes) return
    saveBytes(bytes, outputName, 'audio/wav')
    log('ton', `${outputName} gespeichert (${formatBytes(bytes.byteLength)})`)
  }

  const tools: EditorTool[] = [
    { id: 'schnitt', label: 'Schnitt', icon: IconCut },
    { id: 'pegel', label: 'Pegel', icon: IconLevel, touched: gain !== 0 || Boolean(on.fade) },
    { id: 'klang', label: 'Klang', icon: IconEq, touched: Boolean(on.highpass || on.lowpass || on.tone || on.comp) },
    { id: 'saeubern', label: 'Säubern', icon: IconClean, touched: Boolean(on.clicks || on.noise) },
    { id: 'raum', label: 'Raum', icon: IconRoom, touched: Boolean(on.echo || on.room) },
    { id: 'tempo', label: 'Tempo', icon: IconTempo, touched: Boolean(on.pitch || on.tempo) },
    { id: 'ausgabe', label: 'Ausgabe', icon: IconExport },
    { id: 'verlauf', label: 'Verlauf', icon: IconHistory, touched: history.length > 0 },
  ]

  const fadeButton = (direction: 'in' | 'out') => ({
    onPointerEnter: () => setFadeHover(direction),
    onPointerLeave: () => setFadeHover(null),
    onFocus: () => setFadeHover(direction),
    onBlur: () => setFadeHover(null),
    onClick: () => {
      setFadeHover(null)
      void apply(
        direction === 'in' ? 'Über den Ausschnitt eingeblendet' : 'Über den Ausschnitt ausgeblendet',
        (a) => fadeRange(a, span.start, span.end, direction),
      )
    },
  })

  const inspector = (() => {
    switch (tool) {
      case 'schnitt':
        return (
          <>
            <ToolHeading
              title="Schnitt"
              hint={
                hasSelection
                  ? `Auswahl ${formatTimecode(span.start)} – ${formatTimecode(span.end)}, ${comma(span.end - span.start, 2)} s.`
                  : 'Über die Welle ziehen wählt einen Ausschnitt. Ohne Auswahl wirkt alles auf die ganze Datei.'
              }
            />
            {hasSelection ? (
              <>
                <Button size="sm" disabled={idle} onClick={() => void apply('Ausschnitt behalten', (a) => sliceAudio(a, span.start, span.end))}>
                  Nur die Auswahl behalten
                </Button>
                <div className="grid grid-cols-2 gap-[4px]">
                  <Button size="sm" variant="quiet" disabled={idle} onClick={() => void apply('Ausschnitt entfernt', (a) => cutRange(a, span.start, span.end))}>
                    Entfernen
                  </Button>
                  <Button size="sm" variant="quiet" disabled={idle} onClick={copySelection} title="Strg/Cmd + C">
                    Kopieren
                  </Button>
                  <Button size="sm" variant="quiet" disabled={idle} onClick={cutSelection} title="Strg/Cmd + X">
                    Ausschneiden
                  </Button>
                  <Button size="sm" variant="quiet" disabled={idle} onClick={() => void apply('Ausschnitt verdoppelt', (a) => duplicateRange(a, span.start, span.end))}>
                    Verdoppeln
                  </Button>
                  <Button size="sm" variant="quiet" disabled={idle} onClick={() => void apply('Ausschnitt stumm', (a) => muteRange(a, span.start, span.end))}>
                    Stumm
                  </Button>
                  <Button size="sm" variant="quiet" disabled={idle} {...fadeButton('in')}>
                    Einblenden
                  </Button>
                  <Button size="sm" variant="quiet" disabled={idle} {...fadeButton('out')}>
                    Ausblenden
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setSelection(null)}>
                    Aufheben
                  </Button>
                </div>
              </>
            ) : null}
            {clipboard ? (
              <Button size="sm" variant="quiet" disabled={idle} onClick={paste} title="Strg/Cmd + V">
                {hasSelection ? 'Auswahl ersetzen' : position !== null ? 'An der Abspielstelle einfügen' : 'Am Ende einfügen'} ({comma(durationOf(clipboard))} s)
              </Button>
            ) : null}
            <Module
              title="Stille einfügen"
              hint={`Länge in Sekunden, ${hasSelection ? 'am Beginn der Auswahl' : position !== null ? 'an der Abspielstelle' : 'am Ende der Datei'}.`}
            >
              <ChoiceRow
                value={silenceLength}
                columns={5}
                onChange={setSilenceLength}
                options={[0.25, 0.5, 1, 2, 5].map((value) => ({ value, label: comma(value, value === 0.25 ? 2 : value < 1 ? 1 : 0), title: `${comma(value, 2)} Sekunden` }))}
              />
              <Button
                size="sm"
                variant="quiet"
                disabled={idle}
                onClick={() => {
                  const at = hasSelection ? span.start : (position ?? duration)
                  void apply(`${comma(silenceLength, 2)} s Stille eingefügt`, (a) => insertSilence(a, at, silenceLength))
                }}
              >
                Einfügen
              </Button>
            </Module>
            <Module title="Ganze Datei">
              <Button size="sm" variant="quiet" disabled={idle} onClick={() => void apply('Umgekehrt', reverseAudio)}>
                Rückwärts drehen
              </Button>
            </Module>
            {others.length > 1 ? (
              <Module title="Anhängen" hint="Eine zweite Aufnahme hinten anfügen, mit kurzer Überblendung.">
                <Select value={joinWith} onChange={(event) => setJoinWith(event.target.value)} aria-label="Datei zum Anhängen">
                  <option value="">Datei wählen…</option>
                  {others
                    .filter((entry) => entry.id !== asset.id)
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                </Select>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={!joinWith || idle}
                  onClick={() => {
                    const other = others.find((entry) => entry.id === joinWith)
                    if (!other?.audio) {
                      setError('Diese Datei ist noch nicht dekodiert — einmal auswählen, dann geht es.')
                      return
                    }
                    void apply(`${other.name} angehängt`, (a) => concatAudio([a, other.audio!], 0.05))
                  }}
                >
                  Anhängen
                </Button>
              </Module>
            ) : null}
          </>
        )

      case 'pegel':
        return (
          <>
            <ToolHeading title="Pegel" hint={`Gilt für ${where}. Zu hören sofort, geschrieben mit „Übernehmen“.`} />
            <Slider
              label="Lautstärke"
              display={`${gain > 0 ? '+' : ''}${comma(gain)} dB`}
              min={-24}
              max={12}
              step={0.5}
              value={gain}
              onChange={(event) => setGain(Number(event.target.value))}
            />
            <Module title="Normalisieren" hint="Hebt die lauteste Stelle genau auf den Zielwert.">
              <ChoiceRow
                value={targetPeakDb}
                columns={3}
                onChange={setTargetPeakDb}
                options={[
                  { value: -0.3, label: '−0,3', title: 'Bis knapp unter die Grenze' },
                  { value: -1, label: '−1,0', title: 'Was Spotify und Apple verlangen' },
                  { value: -2, label: '−2,0', title: 'Reserve für weitere Bearbeitung' },
                ]}
              />
              <Button
                size="sm"
                variant="quiet"
                disabled={idle}
                onClick={() => void apply(`Auf ${comma(targetPeakDb)} dBFS normalisiert`, (a) => normalizePeak(a, targetPeakDb))}
              >
                Auf {comma(targetPeakDb)} dBFS bringen
              </Button>
            </Module>
            <Module>
              <Toggle
                label="Blenden am Anfang und Ende"
                checked={Boolean(on.fade)}
                onChange={toggle('fade')}
                hint="Die Kurve steht in der Welle, bevor sie gerechnet ist."
              />
              <Slider
                label="Einblenden"
                display={`${comma(fadeIn, 2)} s`}
                min={0}
                max={Math.min(5, duration)}
                step={0.05}
                value={fadeIn}
                onChange={(event) => {
                  setFadeIn(Number(event.target.value))
                  enable('fade')
                }}
              />
              <Slider
                label="Ausblenden"
                display={`${comma(fadeOut, 2)} s`}
                min={0}
                max={Math.min(5, duration)}
                step={0.05}
                value={fadeOut}
                onChange={(event) => {
                  setFadeOut(Number(event.target.value))
                  enable('fade')
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setFadeIn(Math.min(1, duration / 2))
                  setFadeOut(Math.min(2, duration / 2))
                  enable('fade')
                }}
                className="press self-start rounded-nav text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
              >
                Üblich: 1 s ein, 2 s aus
              </button>
            </Module>
          </>
        )

      case 'klang':
        return (
          <>
            <ToolHeading title="Klang" hint={`Gilt für ${where}. Ein Regler schaltet seinen Block ein.`} />
            <Module>
              <Toggle label="Tiefen entfernen" checked={Boolean(on.highpass)} onChange={toggle('highpass')} hint="Rumpeln, Trittschall, Brummen. Für Stimme 80–120 Hz." />
              <Slider label="unter" display={`${highpassHz} Hz`} min={20} max={400} step={5} value={highpassHz}
                onChange={(event) => { setHighpassHz(Number(event.target.value)); enable('highpass') }} />
            </Module>
            <Module>
              <Toggle label="Höhen entfernen" checked={Boolean(on.lowpass)} onChange={toggle('lowpass')} hint="Zischen und Rauschen oben, oder der Klang „durchs Telefon“." />
              <Slider label="über" display={`${comma(lowpassHz / 1000)} kHz`} min={1000} max={20000} step={250} value={lowpassHz}
                onChange={(event) => { setLowpassHz(Number(event.target.value)); enable('lowpass') }} />
            </Module>
            <Module>
              <Toggle label="Bass und Höhen" checked={Boolean(on.tone)} onChange={toggle('tone')} hint="Kuhschwanz-Filter bei 120 Hz und 6 kHz." />
              <Slider label="Bass" display={`${bassDb > 0 ? '+' : ''}${bassDb} dB`} min={-12} max={12} step={1} value={bassDb}
                onChange={(event) => { setBassDb(Number(event.target.value)); enable('tone') }} />
              <Slider label="Höhen" display={`${trebleDb > 0 ? '+' : ''}${trebleDb} dB`} min={-12} max={12} step={1} value={trebleDb}
                onChange={(event) => { setTrebleDb(Number(event.target.value)); enable('tone') }} />
            </Module>
            <Module>
              <Toggle label="Kompressor" checked={Boolean(on.comp)} onChange={toggle('comp')} hint="Laute Stellen zurück, leise näher heran; gleicht den Pegel danach aus." />
              <Slider label="Ab" display={`${compThreshold} dBFS`} min={-50} max={-3} step={1} value={compThreshold}
                onChange={(event) => { setCompThreshold(Number(event.target.value)); enable('comp') }} />
              <Slider label="Verhältnis" display={`${comma(compRatio)}:1`} min={1.5} max={10} step={0.5} value={compRatio}
                onChange={(event) => { setCompRatio(Number(event.target.value)); enable('comp') }} />
            </Module>
          </>
        )

      case 'saeubern':
        return (
          <>
            <ToolHeading title="Säubern" hint={`Klicks, Rauschen und Pausen. Gilt für ${where}.`} />
            <Module>
              <Toggle
                label="Klicks und Knackser entfernen"
                checked={clickLive}
                onChange={toggle('clicks')}
                hint={
                  clickLive && clickReady && declicked
                    ? declicked.repaired === 0
                      ? 'Nichts gefunden, was wie ein Klick aussieht.'
                      : `${declicked.repaired} ${declicked.repaired === 1 ? 'Stelle' : 'Stellen'} ausgebessert.`
                    : 'Alte Platten, Kabelknacken, Schmatzen am Mikrofon. Schläge und Konsonanten bleiben.'
                }
              />
              <ChoiceRow
                value={clickStrength}
                columns={3}
                onChange={(value) => {
                  setClickStrength(value)
                  enable('clicks')
                }}
                options={[
                  { value: 'sanft', label: 'Sanft' },
                  { value: 'mittel', label: 'Mittel' },
                  { value: 'stark', label: 'Stark' },
                ]}
              />
              {clickLive && !clickReady ? <p className="text-small text-prose">Wird gesucht …</p> : null}
            </Module>
            <Module>
              {noise ? (
                <Toggle label="Rauschen entfernen" checked={Boolean(on.noise)} onChange={toggle('noise')} hint="Aus dem gelernten Rauschprofil, sofort zu hören." />
              ) : (
                <ToolHeading title="Rauschen entfernen" hint="Erst eine Stelle wählen, an der nur das Rauschen zu hören ist, und daraus lernen." />
              )}
              <Button
                size="sm"
                variant="quiet"
                disabled={idle || !hasSelection}
                onClick={() => {
                  setNoise(learnNoise(copyRange(current, span.start, span.end)))
                  enable('noise')
                  log('ton', `Rauschprofil aus ${(span.end - span.start).toFixed(2)} s gelernt`)
                }}
              >
                {noise ? 'Neu lernen aus der Auswahl' : 'Aus der Auswahl lernen'}
              </Button>
              {noise ? (
                <ChoiceRow
                  value={noiseCut}
                  columns={4}
                  onChange={(value) => {
                    setNoiseCut(value)
                    enable('noise')
                  }}
                  options={[6, 12, 18, 24].map((value) => ({ value, label: `${value} dB`, title: `Rauschen bis ${value} dB leiser` }))}
                />
              ) : null}
            </Module>
            <Module title="Stille entfernen" hint="Erkennt stille Abschnitte automatisch und schneidet sie mit sanften 5-ms-Überblendungen heraus.">
              <Button size="sm" variant="quiet" disabled={idle} onClick={() => setSilenceModalOpen(true)}>
                Stille entfernen …
              </Button>
              {detectedSilenceRegions.length > 0 ? (
                <p className="text-small text-prose">
                  {detectedSilenceRegions.length} {detectedSilenceRegions.length === 1 ? 'stiller Abschnitt' : 'stille Abschnitte'} ({comma(totalSilenceDuration, 2)} s) bei {silenceThresholdDb} dBFS erkannt.
                </p>
              ) : null}
            </Module>
            <Module title="Gleichspannung" hint="Rückt eine verschobene Nulllinie zurück in die Mitte.">
              <Button size="sm" variant="quiet" disabled={idle} onClick={() => void apply('DC-Offset entfernt', removeDcOffset)}>
                DC-Offset entfernen
              </Button>
            </Module>
          </>
        )

      case 'raum':
        return (
          <>
            <ToolHeading title="Raum" hint={`Echo und Hall. Gilt für ${where}; klingt über das Ende hinaus nach.`} />
            <Module>
              <Toggle label="Echo" checked={Boolean(on.echo)} onChange={toggle('echo')} />
              <Slider label="Abstand" display={`${echoDelay} ms`} min={40} max={1200} step={10} value={echoDelay}
                onChange={(event) => { setEchoDelay(Number(event.target.value)); enable('echo') }} />
              <Slider label="Wiederholen" display={`${Math.round(echoFeedback * 100)} %`} min={0} max={0.85} step={0.05} value={echoFeedback}
                onChange={(event) => { setEchoFeedback(Number(event.target.value)); enable('echo') }} />
              <Slider label="Anteil" display={`${Math.round(echoMix * 100)} %`} min={0.05} max={1} step={0.05} value={echoMix}
                onChange={(event) => { setEchoMix(Number(event.target.value)); enable('echo') }} />
            </Module>
            <Module>
              <Toggle label="Hall" checked={Boolean(on.room)} onChange={toggle('room')} />
              <Slider label="Raumgrösse" display={`${comma(roomSeconds)} s`} min={0.3} max={5} step={0.1} value={roomSeconds}
                onChange={(event) => { setRoomSeconds(Number(event.target.value)); enable('room') }} />
              <Slider label="Anteil" display={`${Math.round(roomMix * 100)} %`} min={0.05} max={1} step={0.05} value={roomMix}
                onChange={(event) => { setRoomMix(Number(event.target.value)); enable('room') }} />
            </Module>
          </>
        )

      case 'tempo':
        return (
          <>
            <ToolHeading title="Tonhöhe und Tempo" hint={`Gilt für ${where}. Zu hören über einen schnellen Schieber; gerechnet wird mit dem Phasenvocoder.`} />
            <Module>
              <Slider
                label="Tonhöhe"
                display={semitones === 0 ? 'Original' : `${semitones > 0 ? '+' : ''}${semitones} Halbtöne`}
                min={-12}
                max={12}
                step={1}
                value={semitones}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  setSemitones(value)
                  if (value !== 0) enable('pitch')
                }}
              />
              <ChoiceRow
                value={semitones}
                columns={5}
                onChange={(value) => {
                  setSemitones(value)
                  if (value !== 0) enable('pitch')
                }}
                options={[-12, -1, 0, 1, 12].map((value) => ({ value, label: value === 0 ? '0' : value > 0 ? `+${value}` : `−${-value}` }))}
              />
              <Button size="sm" variant="quiet" disabled={idle || semitones === 0} onClick={applyPitchShift}>
                Tonhöhe übernehmen
              </Button>
            </Module>
            <Module>
              <Slider
                label="Tempo"
                display={tempo === 1 ? 'Original' : `${comma(tempo, 2)}×`}
                min={0.5}
                max={2}
                step={0.05}
                value={tempo}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  setTempo(value)
                  if (value !== 1) enable('tempo')
                }}
              />
              <ChoiceRow
                value={tempo}
                columns={5}
                onChange={(value) => {
                  setTempo(value)
                  if (value !== 1) enable('tempo')
                }}
                options={[0.5, 0.75, 1, 1.25, 1.5].map((value) => ({ value, label: `${comma(value, value === 1 ? 0 : 2)}×` }))}
              />
              <Button size="sm" variant="quiet" disabled={idle || tempo === 1} onClick={applyTimeStretch}>
                Tempo übernehmen
              </Button>
            </Module>
            <Module title="Tempo klopfen" hint="Im Takt tippen, oder T auf der Tastatur.">
              <div className="flex items-center gap-[12px]">
                <Button size="sm" onClick={handleTap}>
                  Tippen
                </Button>
                <span className="value text-body text-ink">{tappedBpm ? `${tappedBpm} BPM` : '— BPM'}</span>
                {tapTimes.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setTapTimes([])
                      setTappedBpm(null)
                    }}
                    className="press ml-auto rounded-nav text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                  >
                    Neu
                  </button>
                ) : null}
              </div>
              {tappedBpm ? (
                <p className="value text-small text-prose">
                  1/4 = {Math.round(60000 / tappedBpm)} ms · 1/8 = {Math.round(30000 / tappedBpm)} ms
                </p>
              ) : null}
            </Module>
          </>
        )

      case 'ausgabe':
        return (
          <>
            <ToolHeading title="Ausgabe" hint="Gespeichert wird als WAV; die Ausgangsdatei bleibt, wie sie war." />
            <Module title="Bittiefe">
              <ChoiceRow
                value={bitDepth}
                columns={3}
                onChange={setBitDepth}
                options={[
                  { value: 16, label: '16 bit' },
                  { value: 24, label: '24 bit' },
                  { value: 32, label: '32 Float' },
                ]}
              />
              {bytes ? <p className="value text-small text-prose">{formatBytes(bytes.byteLength)}</p> : null}
            </Module>
            <div className="flex flex-col gap-[4px]">
              <Button size="sm" disabled={!bytes || idle} onClick={save}>
                Als WAV speichern
                <ArrowRight />
              </Button>
              <Button size="sm" variant="quiet" disabled={!bytes || idle} onClick={keep}>
                In die Sitzung übernehmen
              </Button>
            </div>
            <Module title="Kanäle" hint="Mono spart die Hälfte; Stereo verdoppelt einen Mono-Kanal.">
              <div className="grid grid-cols-3 gap-[4px]">
                <Button size="sm" variant="quiet" disabled={idle || current.channels.length === 1} onClick={() => void apply('Auf Mono gelegt', (a) => setChannels(a, 1))}>
                  Mono
                </Button>
                <Button size="sm" variant="quiet" disabled={idle || current.channels.length === 2} onClick={() => void apply('Auf Stereo gelegt', (a) => setChannels(a, 2))}>
                  Stereo
                </Button>
                <Button size="sm" variant="quiet" disabled={idle || current.channels.length !== 2} onClick={() => void apply('Kanäle getauscht', (a) => channelTrick(a, 'swap'))}>
                  L/R tauschen
                </Button>
              </div>
            </Module>
            <Module title="Abtastrate" hint="Lineare Interpolation — gut fürs Musikalische, kein Studio-Wandler.">
              <ChoiceRow
                value={current.sampleRate}
                columns={3}
                onChange={(rate) => {
                  if (rate !== current.sampleRate) void apply(`${comma(rate / 1000)} kHz`, (a) => resampleAudio(a, rate))
                }}
                options={[22050, 44100, 48000].map((rate) => ({ value: rate, label: `${comma(rate / 1000)} kHz` }))}
              />
            </Module>
          </>
        )

      case 'verlauf':
        return (
          <>
            <ToolHeading
              title="Verlauf"
              hint={history.length === 0 ? 'Noch unverändert. Jeder Schritt landet hier und ist mit Strg/Cmd + Z zurückzunehmen.' : 'Der unterste ist der neueste. Die Ausgangsdatei bleibt unangetastet.'}
            />
            {history.length > 0 ? (
              <ol className="flex flex-col text-small">
                <li className="flex items-baseline gap-[8px] border-t border-line py-[6px] text-prose">
                  <span className="value w-[2ch] shrink-0 text-right">0</span>
                  <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                </li>
                {history.map((entry, index) => (
                  <li
                    key={`${entry.label}-${index}`}
                    className={`flex items-baseline gap-[8px] border-t border-line py-[6px] ${index === history.length - 1 ? 'font-semibold text-ink' : 'text-prose'}`}
                  >
                    <span className="value w-[2ch] shrink-0 text-right">{index + 1}</span>
                    <span className="min-w-0 flex-1">{entry.label}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {future.length > 0 ? (
              <p className="text-small text-prose">
                {future.length} {future.length === 1 ? 'Schritt lässt' : 'Schritte lassen'} sich wiederholen.
              </p>
            ) : null}
            {history.length > 0 && decoded ? (
              <Button size="sm" variant="quiet" disabled={idle} onClick={() => void apply('Zurück zum Original', () => decoded)}>
                Zurück zum Original
              </Button>
            ) : null}
          </>
        )
    }
  })()

  return (
    <div className="flex flex-col gap-[16px]">
      <EditorShell
        title={asset.name}
        subtitle={`${formatTimecode(duration)} · ${current.channels.length === 1 ? 'Mono' : 'Stereo'} · ${comma(current.sampleRate / 1000)} kHz · Spitze ${comma(peakDb(current))} dBFS`}
        actions={
          <>
            <IconButton label="Rückgängig (Strg+Z)" onClick={undo} disabled={history.length === 0}>
              {IconUndo}
            </IconButton>
            <IconButton label="Wiederholen (Strg+Umschalt+Z)" onClick={redo} disabled={future.length === 0}>
              {IconRedo}
            </IconButton>
            <Button size="sm" variant="quiet" onClick={() => setSilenceModalOpen(true)} disabled={idle || !current} className="ml-[4px]">
              Stille entfernen
            </Button>
            <Button size="sm" onClick={save} disabled={!bytes || idle} className="ml-[8px]">
              Speichern
            </Button>
          </>
        }
        tools={tools}
        tool={tool}
        onTool={(id) => setTool(id as ToolId)}
        stageClassName="bg-stage min-h-[280px] sm:min-h-[clamp(340px,46vh,580px)]"
        stage={
          <SoundStage
            audio={shown}
            start={viewStart}
            end={viewEnd}
            position={positionInView}
            selection={liveInView}
            fades={fadesInView}
            surfaceRef={frameRef}
            surface={{
              'aria-label': 'Wellenform — ziehen wählt einen Ausschnitt',
              onPointerDown: (event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                const at = secondsAt(event.clientX)
                setDragging({ start: at, end: at })
              },
              onPointerMove: (event) => {
                if (!dragging) return
                setDragging((value) => (value ? { ...value, end: secondsAt(event.clientX) } : value))
              },
              onPointerUp: () => {
                if (!dragging) return
                const next = { start: Math.min(dragging.start, dragging.end), end: Math.max(dragging.start, dragging.end) }
                setDragging(null)
                // A click rather than a drag clears the selection.
                setSelection(next.end - next.start < 0.02 ? null : next)
              },
            }}
          />
        }
        underStage={
          <>
            {/* The transport: what a studio has under its arrangement. */}
            <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] px-[12px] py-[8px]">
              <div className="flex items-center gap-[4px]">
                <button
                  type="button"
                  onClick={() => (playing ? stop() : void play())}
                  aria-label={playing ? 'Anhalten (Leertaste)' : hasSelection ? 'Auswahl abspielen (Leertaste)' : 'Abspielen (Leertaste)'}
                  title={playing ? 'Anhalten (Leertaste)' : hasSelection ? 'Auswahl abspielen (Leertaste)' : 'Abspielen (Leertaste)'}
                  className="press inline-flex h-[36px] w-[36px] items-center justify-center rounded-pill bg-ink text-on-ink hover:bg-ink-hover"
                >
                  {playing ? IconPause : IconPlay}
                </button>
                <IconButton label="Stopp" onClick={() => stop()} disabled={!playing}>
                  {IconStop}
                </IconButton>
                <IconButton
                  label={loop ? 'Schleife aus' : 'In Schleife spielen'}
                  active={loop}
                  onClick={() => {
                    stop()
                    setLoop((value) => !value)
                  }}
                >
                  {IconLoop}
                </IconButton>
              </div>
              <p className="value whitespace-nowrap text-body text-ink">
                {formatTimecode(position ?? (hasSelection ? span.start : 0))}
                <span className="text-small text-muted"> / {formatTimecode(duration)}</span>
              </p>
              {hasSelection ? (
                <p className="value whitespace-nowrap text-small text-prose">
                  Auswahl {comma(span.end - span.start, 2)} s
                </p>
              ) : null}
              <div className="ml-auto flex items-center gap-[4px]">
                {hasSelection && !(view && Math.abs(view.start - span.start) < 1e-3 && Math.abs(view.end - span.end) < 1e-3) ? (
                  <Button size="sm" variant="quiet" onClick={() => setView({ start: span.start, end: span.end })}>
                    Auswahl zeigen
                  </Button>
                ) : null}
                {view ? (
                  <Button size="sm" variant="quiet" onClick={() => setView(null)}>
                    Ganz zeigen
                  </Button>
                ) : null}
                <IconButton label="Herauszoomen" onClick={() => zoomBy(2)} disabled={!view}>
                  {IconZoomOut}
                </IconButton>
                <IconButton label="Hineinzoomen (oder Mausrad)" onClick={() => zoomBy(0.5)} disabled={duration <= 0.06}>
                  {IconZoomIn}
                </IconButton>
              </div>
            </div>
            {/* What is switched on, in one sentence, with the one decision it
                asks for: keep it or not. */}
            {liveParts.length > 0 || noiseLive ? (
              <div className="rise flex flex-wrap items-center gap-x-[12px] gap-y-[8px] border-t border-line bg-panel-soft px-[12px] py-[8px]">
                <p className="min-w-0 flex-1 text-small text-prose">
                  <span className="font-semibold text-ink">Zu hören:</span> {liveParts.join(' · ')}
                  {noiseLive && !noiseReady ? ' — Rauschminderung wird gerechnet …' : ''}
                </p>
                <div role="group" aria-label="Vergleich" className="flex rounded-pill bg-raised p-[2px] ring-1 ring-inset ring-line">
                  {([false, true] as const).map((value) => (
                    <button
                      key={String(value)}
                      type="button"
                      aria-pressed={compare === value}
                      onClick={() => setCompare(value)}
                      className={`press rounded-pill px-[12px] py-[3px] text-small ${compare === value ? 'bg-ink text-on-ink' : 'text-ink hover:bg-panel-mid'}`}
                    >
                      {value ? 'Vorher' : 'Nachher'}
                    </button>
                  ))}
                </div>
                <Button size="sm" disabled={idle || (noiseLive && !noiseReady && liveParts.length === 1)} onClick={() => void commit()}>
                  Übernehmen
                </Button>
                <button
                  type="button"
                  disabled={idle}
                  onClick={() => {
                    setOn({})
                    setGain(0)
                    setCompare(false)
                  }}
                  className="press rounded-nav text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink disabled:opacity-40"
                >
                  Alles aus
                </button>
              </div>
            ) : null}
          </>
        }
        inspector={inspector}
        status={
          <>
            {busy ? (
              <span className="flex items-center gap-[8px] text-ink">
                <span aria-hidden className="pulse-dot h-[7px] w-[7px] rounded-pill bg-ink" />
                {busy} …
              </span>
            ) : (
              <span className="hidden sm:inline">Ziehen wählt aus · Mausrad zoomt · Umschalt + Mausrad schiebt · Leertaste spielt</span>
            )}
            <span className="ml-auto">
              {history.length > 0 ? `${history.length} ${history.length === 1 ? 'Schritt' : 'Schritte'} · ` : ''}Läuft auf diesem Gerät
            </span>
          </>
        }
      />

      {error ? (
        <Notice tone="error" title="Ging nicht">
          {error}
        </Notice>
      ) : null}

      <dialog
        ref={silenceDialogRef}
        onClose={() => setSilenceModalOpen(false)}
        onClick={(e) => {
          if (e.target === silenceDialogRef.current) setSilenceModalOpen(false)
        }}
        className="m-auto w-[min(480px,calc(100vw-32px))] rounded-card bg-raised p-0 text-prose backdrop:bg-ink/50 backdrop:backdrop-blur-[3px] ring-1 ring-inset ring-line shadow-2xl"
      >
        <div className="flex flex-col gap-[16px] p-[20px]">
          <div className="flex items-start justify-between gap-[12px]">
            <div>
              <h3 className="text-body font-semibold text-ink">Stille entfernen</h3>
              <p className="mt-[2px] text-small text-muted">
                Erkennt stille Abschnitte automatisch und schneidet sie mit sanften 5-ms-Überblendungen heraus.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSilenceModalOpen(false)}
              aria-label="Schließen"
              className="grid h-[24px] w-[24px] place-items-center rounded-nav text-muted hover:bg-panel-soft hover:text-ink"
            >
              <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" aria-hidden>
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="flex flex-col gap-[8px] rounded-card bg-panel-soft p-[14px] ring-1 ring-inset ring-line/50">
            <Slider
              label="Schwellenwert"
              display={`${silenceThresholdDb} dBFS`}
              min={-60}
              max={-25}
              step={1}
              value={silenceThresholdDb}
              onChange={(e) => setSilenceThresholdDb(Number(e.target.value))}
            />
            <div className="flex justify-between text-micro text-muted">
              <span>−60 dB (nur Stille)</span>
              <span>−45 dB (Standard)</span>
              <span>−25 dB (aggressiv)</span>
            </div>
          </div>

          <div className="rounded-card bg-panel-mid p-[12px] ring-1 ring-inset ring-line/70">
            <span className="text-micro font-semibold uppercase tracking-[0.05em] text-muted">
              Vorschau
            </span>
            <p className="mt-[4px] text-small text-ink">
              {detectedSilenceRegions.length === 0 ? (
                <span className="text-muted">Keine stillen Abschnitte unter {silenceThresholdDb} dBFS gefunden (mind. 300 ms Dauer).</span>
              ) : (
                <>
                  <strong className="font-semibold text-ink">{detectedSilenceRegions.length}</strong>{' '}
                  {detectedSilenceRegions.length === 1 ? 'stiller Abschnitt' : 'stille Abschnitte'} erkannt, zusammen{' '}
                  <strong className="font-semibold text-ink">{comma(totalSilenceDuration, 2)} s</strong>.
                </>
              )}
            </p>
            {detectedSilenceRegions.length > 0 && current ? (
              <p className="mt-[4px] text-micro text-muted">
                Dauer nach Zuschnitt: {formatTimecode(Math.max(0, duration - totalSilenceDuration))} (vorher {formatTimecode(duration)})
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-[8px] pt-[4px]">
            <Button
              size="sm"
              variant="quiet"
              onClick={() => setSilenceModalOpen(false)}
            >
              Abbrechen
            </Button>
            <Button
              size="sm"
              disabled={detectedSilenceRegions.length === 0 || idle}
              onClick={() => void handleConfirmStripSilence()}
            >
              {detectedSilenceRegions.length > 0
                ? `${detectedSilenceRegions.length === 1 ? 'Abschnitt' : 'Abschnitte'} entfernen`
                : 'Stille entfernen'}
            </Button>
          </div>
        </div>
      </dialog>
    </div>
  )
}

/** One group in the inspector: a hairline above, a name if it needs one. */
function Module({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[10px] border-t border-line pt-[12px]">
      {title ? <ToolHeading title={title} hint={hint} /> : null}
      {children}
    </section>
  )
}
