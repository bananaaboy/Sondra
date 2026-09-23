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

import { getAudioContext, resumeAudioContext, sliceAudio, applyFades, reverseAudio, toAudioBuffer } from '../../lib/audio'
import { saveBytes } from '../../lib/download'
import {
  channelTrick,
  concatAudio,
  cutRange,
  detectSilence,
  durationOf,
  frameCount,
  normalizePeak,
  peakDb,
  removeSilence,
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
import { formatBytes, formatTimecode } from '../../lib/format'
import { pitchShift, stretchAudio } from '../../lib/timestretch'
import { encodeWav, type AudioData, type WavBitDepth } from '../../lib/wav'
import { useDecodedAudio } from '../../hooks/useDecodedAudio'
import { useActiveAssetOfKind, useAssetsOfKind, useSession } from '../../state/store'
import { FileDrop } from '../FileDrop'
import { Waveform } from '../Waveform'
import { FadeOverlay, type FadeShape } from '../editor/FadeOverlay'
import {
  ArrowRight,
  Button,
  Card,
  SectionHead,
  Field,
  Notice,
  Reveal,
  Select,
  Slider,
  Toggle,
} from '../ui/primitives'

/** What can be switched on to be heard live, before it is written in. */
type LiveId = 'fade' | 'highpass' | 'lowpass' | 'tone' | 'comp' | 'noise' | 'echo' | 'room' | 'pitch' | 'tempo'

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
  // Sound shaping.
  const [highpassHz, setHighpassHz] = useState(80)
  const [lowpassHz, setLowpassHz] = useState(12000)
  const [bassDb, setBassDb] = useState(0)
  const [trebleDb, setTrebleDb] = useState(0)
  const [compThreshold, setCompThreshold] = useState(-24)
  const [compRatio, setCompRatio] = useState(3)
  const [noise, setNoise] = useState<Float32Array | null>(null)
  const [noiseCut, setNoiseCut] = useState(12)
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
      try {
        const next = await operation(current)
        if (frameCount(next) === 0) throw new Error('Das hätte nichts übrig gelassen.')
        setHistory((stack) => [...stack.slice(-19), { audio: current, label }])
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
    [current, log],
  )

  const undo = useCallback(() => {
    setHistory((stack) => {
      const last = stack.at(-1)
      if (!last || !current) return stack
      setFuture((ahead) => [{ audio: current, label: last.label }, ...ahead])
      setCurrent(last.audio)
      return stack.slice(0, -1)
    })
  }, [current])

  const redo = useCallback(() => {
    setFuture((ahead) => {
      const next = ahead[0]
      if (!next || !current) return ahead
      setHistory((stack) => [...stack, { audio: current, label: next.label }])
      setCurrent(next.audio)
      return ahead.slice(1)
    })
  }, [current])

  // The clipboard handlers change with every render; the listener reads the
  // current ones through this ref instead of being re-attached each time.
  const shortcutsRef = useRef<Record<'c' | 'x' | 'v', () => boolean>>({ c: () => false, x: () => false, v: () => false })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      const key = event.key.toLowerCase()
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
  }, [undo, redo])

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

  // Noise reduction is spectral and runs over the whole file, so it is heard
  // from a second buffer, rebuilt when the profile or the strength changes.
  const noiseReady =
    denoised !== null && denoised.source === current && denoised.profile === noise && denoised.cut === noiseCut
  useEffect(() => {
    if (!noiseLive || !current || !noise || noiseReady) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      const audio = removeNoise(current, noise, noiseCut)
      if (!cancelled) setDenoised({ source: current, profile: noise, cut: noiseCut, audio })
    }, 40)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [noiseLive, current, noise, noiseCut, noiseReady])

  useEffect(() => {
    const timer = window.setTimeout(() => setFadeHeard({ in: fadeIn, out: fadeOut }), 160)
    return () => window.clearTimeout(timer)
  }, [fadeIn, fadeOut])

  /** The buffer that plays: the file, cleaned and faded if that is switched on. */
  const liveAudio = useMemo(() => {
    if (!current || compare) return current
    let audio = noiseLive && noiseReady && denoised ? denoised.audio : current
    if (fading && (fadeHeard.in > 0 || fadeHeard.out > 0)) audio = applyFades(audio, fadeHeard.in, fadeHeard.out)
    return audio
  }, [current, compare, noiseLive, noiseReady, denoised, fading, fadeHeard])

  /** In words, for the bar under the waveform and the history. */
  const liveParts: string[] = []
  if (gain !== 0) liveParts.push(`Pegel ${gain > 0 ? '+' : ''}${comma(gain)} dB`)
  if (fading) liveParts.push(`Blenden ${comma(fadeIn, 2)} / ${comma(fadeOut, 2)} s`)
  if (on.highpass) liveParts.push(`Tiefen unter ${highpassHz} Hz weg`)
  if (on.lowpass) liveParts.push(`Höhen über ${comma(lowpassHz / 1000)} kHz weg`)
  if (on.tone && (bassDb !== 0 || trebleDb !== 0)) liveParts.push(`Bass ${bassDb > 0 ? '+' : ''}${bassDb} dB, Höhen ${trebleDb > 0 ? '+' : ''}${trebleDb} dB`)
  if (on.comp) liveParts.push(`Kompressor ${comma(compRatio)}:1 ab ${compThreshold} dBFS`)
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
      setOn({})
      setGain(0)
      setCompare(false)
    }
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
  const fadeShapes: FadeShape[] = []
  if (fading && !compare) {
    const lead = Math.min(fadeIn, duration)
    if (lead > 0) fadeShapes.push({ from: 0, to: lead, direction: 'in' })
    const tail = Math.min(fadeOut, duration - lead)
    if (tail > 0) fadeShapes.push({ from: duration - tail, to: duration, direction: 'out' })
  }
  if (fadeHover && hasSelection) fadeShapes.push({ from: span.start, to: span.end, direction: fadeHover })

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

  const silence = detectSilence(current)

  return (
    <div className="grid gap-[16px] lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-[16px]">
        <Card tone="keylime">
          <div className="flex flex-wrap items-baseline justify-between gap-[12px]">
            <span className="value text-small text-muted">
              {formatTimecode(duration)} · {current.channels.length === 1 ? 'Mono' : 'Stereo'} ·{' '}
              {(current.sampleRate / 1000).toFixed(1)} kHz · Spitze {peakDb(current).toFixed(1)} dBFS
            </span>
          </div>

          {/* -- the waveform, and the selection on it ----------------------- */}
          <div
            ref={frameRef}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              const at = secondsAt(event.clientX)
              setDragging({ start: at, end: at })
            }}
            onPointerMove={(event) => {
              if (!dragging) return
              setDragging((value) => (value ? { ...value, end: secondsAt(event.clientX) } : value))
            }}
            onPointerUp={() => {
              if (!dragging) return
              const next = {
                start: Math.min(dragging.start, dragging.end),
                end: Math.max(dragging.start, dragging.end),
              }
              setDragging(null)
              // A click rather than a drag clears the selection.
              setSelection(next.end - next.start < 0.02 ? null : next)
            }}
            className="relative mt-[16px] cursor-text touch-none bg-panel-soft p-[12px] select-none"
          >
            <Waveform audio={shown} height={130} position={positionInView} selection={liveInView} />
            <FadeOverlay fades={fadeShapes} viewStart={viewStart} viewEnd={viewEnd} />
          </div>

          {/* -- what is heard live, and writing it in ------------------------ */}
          {liveParts.length > 0 || noiseLive ? (
            <div className="mt-[8px] flex flex-wrap items-center gap-x-[12px] gap-y-[8px] border-l-2 border-ink pl-[12px]">
              <p className="min-w-0 flex-1 text-small text-prose">
                <span className="font-semibold text-ink">Live zu hören:</span> {liveParts.join(' · ')}
                {noiseLive && !noiseReady ? <span className="text-muted"> — Rauschminderung wird gerechnet…</span> : null}
              </p>
              <div role="group" aria-label="Vergleich" className="flex rounded-pill bg-panel-soft p-[2px]">
                {([false, true] as const).map((value) => (
                  <button
                    key={String(value)}
                    type="button"
                    aria-pressed={compare === value}
                    onClick={() => setCompare(value)}
                    className={`press rounded-pill px-[12px] py-[4px] text-small ${compare === value ? 'bg-ink text-on-ink' : 'text-ink hover:bg-panel-mid'}`}
                  >
                    {value ? 'Vorher' : 'Nachher'}
                  </button>
                ))}
              </div>
              <Button size="sm" disabled={busy !== null || (noiseLive && !noiseReady && liveParts.length === 1)} onClick={() => void commit()}>
                Übernehmen
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== null}
                onClick={() => {
                  setOn({})
                  setGain(0)
                  setCompare(false)
                }}>
                Alles aus
              </Button>
            </div>
          ) : null}

          <div className="mt-[8px] flex flex-wrap items-center gap-[8px]">
            <Button size="sm" onClick={() => void play()}>
              {hasSelection ? 'Auswahl hören' : 'Alles hören'}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => stop()}>
              Stopp
            </Button>
            <button
              type="button"
              role="switch"
              aria-checked={loop}
              onClick={() => {
                stop()
                setLoop((value) => !value)
              }}
              className={`press rounded-pill px-[12px] py-[6px] text-small ${loop ? 'bg-ink text-on-ink' : 'bg-panel-soft text-ink hover:bg-panel-mid'}`}
            >
              Schleife
            </button>
            {hasSelection && !(view && Math.abs(view.start - span.start) < 1e-3 && Math.abs(view.end - span.end) < 1e-3) ? (
              <Button size="sm" variant="ghost" onClick={() => setView({ start: span.start, end: span.end })}>
                Auf Auswahl zoomen
              </Button>
            ) : null}
            {view ? (
              <Button size="sm" variant="ghost" onClick={() => setView(null)}>
                Ganz zeigen
              </Button>
            ) : null}
            <span className="value text-small text-muted">
              {hasSelection
                ? `${formatTimecode(span.start)} – ${formatTimecode(span.end)} · ${(span.end - span.start).toFixed(2)} s`
                : 'Über die Wellenform ziehen wählt einen Ausschnitt'}
            </span>
            <div className="ml-auto flex gap-[8px]">
              <Button size="sm" variant="ghost" disabled={history.length === 0} onClick={undo}>
                Rückgängig
              </Button>
              <Button size="sm" variant="ghost" disabled={future.length === 0} onClick={redo}>
                Wiederholen
              </Button>
            </div>
          </div>

          {error ? (
            <div className="mt-[16px]">
              <Notice tone="error" title="Ging nicht">{error}</Notice>
            </div>
          ) : null}

          {/* -- cutting ------------------------------------------------------ */}
          <div className="mt-[16px] flex flex-wrap gap-[8px]">
            {/* The two cuts exist only once there is something to cut. Shown
                greyed out beforehand they were two dead buttons on every visit,
                and the line above already says how to make a selection. */}
            {hasSelection ? (
              <>
                <Button size="sm" disabled={busy !== null}
                  onClick={() => void apply('Ausschnitt behalten', (a) => sliceAudio(a, span.start, span.end))}>
                  Nur den Ausschnitt behalten
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null}
                  onClick={() => void apply('Ausschnitt entfernt', (a) => cutRange(a, span.start, span.end))}>
                  Ausschnitt herausschneiden
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null} onClick={copySelection} title="Strg/Cmd + C">
                  Kopieren
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null} onClick={cutSelection} title="Strg/Cmd + X">
                  Ausschneiden
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null}
                  onClick={() => void apply('Ausschnitt verdoppelt', (a) => duplicateRange(a, span.start, span.end))}>
                  Verdoppeln
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null}
                  onClick={() => void apply('Ausschnitt stumm', (a) => muteRange(a, span.start, span.end))}>
                  Stumm
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null}
                  onPointerEnter={() => setFadeHover('in')} onPointerLeave={() => setFadeHover(null)}
                  onFocus={() => setFadeHover('in')} onBlur={() => setFadeHover(null)}
                  onClick={() => {
                    setFadeHover(null)
                    void apply('Über den Ausschnitt eingeblendet', (a) => fadeRange(a, span.start, span.end, 'in'))
                  }}>
                  Hier einblenden
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null}
                  onPointerEnter={() => setFadeHover('out')} onPointerLeave={() => setFadeHover(null)}
                  onFocus={() => setFadeHover('out')} onBlur={() => setFadeHover(null)}
                  onClick={() => {
                    setFadeHover(null)
                    void apply('Über den Ausschnitt ausgeblendet', (a) => fadeRange(a, span.start, span.end, 'out'))
                  }}>
                  Hier ausblenden
                </Button>
              </>
            ) : null}
            {clipboard ? (
              <Button size="sm" variant="quiet" disabled={busy !== null} onClick={paste} title="Strg/Cmd + V">
                {hasSelection ? 'Auswahl ersetzen' : 'Einfügen'} ({durationOf(clipboard).toFixed(1)} s)
              </Button>
            ) : null}
            <Button size="sm" variant="quiet" disabled={busy !== null}
              onClick={() => void apply('Umgekehrt', reverseAudio)}>
              Umkehren
            </Button>
            {selection ? (
              <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
                Auswahl aufheben
              </Button>
            ) : null}
          </div>

          {/* -- level and shape ---------------------------------------------- */}
          <div className="mt-[20px] grid gap-[16px] border-t border-line pt-[16px] sm:grid-cols-2">
            <div>
              <Slider
                label={hasSelection ? 'Pegel im Ausschnitt' : 'Pegel'}
                display={`${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`}
                min={-24} max={12} step={0.5} value={gain}
                onChange={(event) => setGain(Number(event.target.value))}
              />
              <div className="mt-[8px] flex gap-[8px]">
                <Button size="sm" variant="quiet" disabled={busy !== null}
                  onClick={() => void apply('Auf −0,3 dBFS normalisiert', (a) => normalizePeak(a, -0.3))}>
                  Auf −0,3 dBFS bringen
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-[8px]">
              <Toggle label="Blenden am Anfang und Ende" checked={Boolean(on.fade)} onChange={toggle('fade')}
                hint="Die Kurve steht auf der Wellenform, zu hören ist sie sofort." />
              <div className="grid grid-cols-2 gap-[12px]">
                <Slider label="Einblenden" display={`${comma(fadeIn, 2)} s`}
                  min={0} max={Math.min(5, duration)} step={0.05} value={fadeIn}
                  onChange={(event) => {
                    setFadeIn(Number(event.target.value))
                    enable('fade')
                  }} />
                <Slider label="Ausblenden" display={`${comma(fadeOut, 2)} s`}
                  min={0} max={Math.min(5, duration)} step={0.05} value={fadeOut}
                  onChange={(event) => {
                    setFadeOut(Number(event.target.value))
                    enable('fade')
                  }} />
              </div>
            </div>
          </div>

          {/* -- silence ------------------------------------------------------- */}
          {/* Nothing found is one quiet line; the explanation and the button
              only appear when there is silence to remove. */}
          {silence.length === 0 ? (
            <p className="mt-[20px] border-t border-line pt-[12px] text-small text-muted">
              Keine nennenswerte Stille gefunden.
            </p>
          ) : (
            <div className="mt-[20px] flex flex-wrap items-center gap-[8px] border-t border-line pt-[16px]">
              <div className="min-w-0 flex-1">
                <p className="text-small text-ink">
                  {`${silence.length} stille Stelle${silence.length === 1 ? '' : 'n'} gefunden — zusammen ${
                    silence.reduce((sum, r) => sum + (r.endSeconds - r.startSeconds), 0).toFixed(1)
                  } s.`}
                </p>
                <p className="mt-[4px] text-small leading-[1.45] text-muted">
                  Unter −50 dBFS und länger als 0,35 s. An den Rändern bleiben 50 ms stehen, sonst
                  klingt der Schnitt abgehackt.
                </p>
              </div>
              <Button size="sm" variant="quiet" disabled={busy !== null}
                onClick={() => void apply('Stille entfernt', (a) => removeSilence(a))}>
                Stille entfernen
              </Button>
            </div>
          )}

          {/* -- a pause, put in ------------------------------------------------ */}
          <div className="mt-[16px] flex flex-wrap items-center gap-[8px] border-t border-line pt-[16px]">
            <span className="text-small text-prose">Stille einfügen</span>
            <Select
              value={silenceLength}
              onChange={(event) => setSilenceLength(Number(event.target.value))}
              aria-label="Länge der Stille"
              className="w-auto! py-[6px] text-small"
            >
              {[0.25, 0.5, 1, 2, 5].map((value) => (
                <option key={value} value={value}>
                  {value.toString().replace('.', ',')} s
                </option>
              ))}
            </Select>
            <Button size="sm" variant="quiet" disabled={busy !== null}
              onClick={() => {
                const at = hasSelection ? span.start : (position ?? duration)
                void apply(`${silenceLength} s Stille eingefügt`, (a) => insertSilence(a, at, silenceLength))
              }}>
              {hasSelection ? 'Am Auswahlbeginn' : position !== null ? 'An der Abspielstelle' : 'Am Ende'}
            </Button>
          </div>

          {/* -- sound: filters, dynamics, noise, space --------------------------- */}
          {/* Every block is a switch. Moving a slider switches it on, and what
              is on plays live — „Übernehmen“ under the waveform writes it in. */}
          <Reveal label={`Klang: Filter, Bass und Höhen, Kompressor, Rauschen, Echo, Hall${hasSelection ? ' — gilt für den Ausschnitt' : ''}`} className="mt-[16px]">
            <div className="grid gap-[20px] rounded-card bg-panel-soft p-[16px] sm:grid-cols-2">
              <div className="flex flex-col gap-[8px]">
                <Toggle label="Tiefen entfernen" checked={Boolean(on.highpass)} onChange={toggle('highpass')}
                  hint="Rumpeln, Trittschall, Brummen. Für Stimme 80–120 Hz." />
                <Slider label="unter" display={`${highpassHz} Hz`}
                  min={20} max={400} step={5} value={highpassHz}
                  onChange={(event) => {
                    setHighpassHz(Number(event.target.value))
                    enable('highpass')
                  }} />
              </div>

              <div className="flex flex-col gap-[8px]">
                <Toggle label="Höhen entfernen" checked={Boolean(on.lowpass)} onChange={toggle('lowpass')}
                  hint="Zischen und Rauschen oben, oder der Klang „durchs Telefon“." />
                <Slider label="über" display={`${comma(lowpassHz / 1000)} kHz`}
                  min={1000} max={20000} step={250} value={lowpassHz}
                  onChange={(event) => {
                    setLowpassHz(Number(event.target.value))
                    enable('lowpass')
                  }} />
              </div>

              <div className="flex flex-col gap-[8px]">
                <Toggle label="Bass und Höhen" checked={Boolean(on.tone)} onChange={toggle('tone')}
                  hint="Kuhschwanz-Filter bei 120 Hz und 6 kHz." />
                <div className="grid grid-cols-2 gap-[12px]">
                  <Slider label="Bass" display={`${bassDb > 0 ? '+' : ''}${bassDb} dB`}
                    min={-12} max={12} step={1} value={bassDb}
                    onChange={(event) => {
                      setBassDb(Number(event.target.value))
                      enable('tone')
                    }} />
                  <Slider label="Höhen" display={`${trebleDb > 0 ? '+' : ''}${trebleDb} dB`}
                    min={-12} max={12} step={1} value={trebleDb}
                    onChange={(event) => {
                      setTrebleDb(Number(event.target.value))
                      enable('tone')
                    }} />
                </div>
              </div>

              <div className="flex flex-col gap-[8px]">
                <Toggle label="Kompressor" checked={Boolean(on.comp)} onChange={toggle('comp')}
                  hint="Laute Stellen zurücknehmen, leise näher heran; gleicht den Pegel danach aus." />
                <div className="grid grid-cols-2 gap-[12px]">
                  <Slider label="Ab" display={`${compThreshold} dBFS`}
                    min={-50} max={-3} step={1} value={compThreshold}
                    onChange={(event) => {
                      setCompThreshold(Number(event.target.value))
                      enable('comp')
                    }} />
                  <Slider label="Verhältnis" display={`${comma(compRatio)}:1`}
                    min={1.5} max={10} step={0.5} value={compRatio}
                    onChange={(event) => {
                      setCompRatio(Number(event.target.value))
                      enable('comp')
                    }} />
                </div>
              </div>

              <div className="flex flex-col gap-[8px] sm:col-span-2">
                {noise ? (
                  <Toggle label="Rauschen entfernen" checked={Boolean(on.noise)} onChange={toggle('noise')}
                    hint="Rauschprofil gelernt. Eingeschaltet ist die Aufnahme sofort ohne es zu hören." />
                ) : (
                  <>
                    <p className="text-small text-prose">Rauschen entfernen</p>
                    <p className="text-small leading-[1.45] text-muted">
                      Erst eine Stelle auswählen, an der nur das Rauschen zu hören ist, und daraus lernen.
                    </p>
                  </>
                )}
                <div className="flex flex-wrap items-center gap-[8px]">
                  <Button size="sm" variant="quiet" disabled={busy !== null || !hasSelection}
                    onClick={() => {
                      if (!current) return
                      setNoise(learnNoise(copyRange(current, span.start, span.end)))
                      enable('noise')
                      log('ton', `Rauschprofil aus ${(span.end - span.start).toFixed(2)} s gelernt`)
                    }}>
                    {noise ? 'Neu lernen aus der Auswahl' : 'Rauschprofil aus der Auswahl'}
                  </Button>
                  {noise ? (
                    <Select value={noiseCut}
                      onChange={(event) => {
                        setNoiseCut(Number(event.target.value))
                        enable('noise')
                      }}
                      aria-label="Stärke" className="w-auto! py-[6px] text-small">
                      {[6, 12, 18, 24].map((value) => (
                        <option key={value} value={value}>bis {value} dB</option>
                      ))}
                    </Select>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-col gap-[8px]">
                <Toggle label="Echo" checked={Boolean(on.echo)} onChange={toggle('echo')} />
                <div className="grid grid-cols-3 gap-[12px]">
                  <Slider label="Abstand" display={`${echoDelay} ms`} min={40} max={1200} step={10} value={echoDelay}
                    onChange={(event) => {
                      setEchoDelay(Number(event.target.value))
                      enable('echo')
                    }} />
                  <Slider label="Wiederholen" display={`${Math.round(echoFeedback * 100)} %`} min={0} max={0.85} step={0.05} value={echoFeedback}
                    onChange={(event) => {
                      setEchoFeedback(Number(event.target.value))
                      enable('echo')
                    }} />
                  <Slider label="Anteil" display={`${Math.round(echoMix * 100)} %`} min={0.05} max={1} step={0.05} value={echoMix}
                    onChange={(event) => {
                      setEchoMix(Number(event.target.value))
                      enable('echo')
                    }} />
                </div>
              </div>

              <div className="flex flex-col gap-[8px]">
                <Toggle label="Hall" checked={Boolean(on.room)} onChange={toggle('room')} />
                <div className="grid grid-cols-2 gap-[12px]">
                  <Slider label="Raumgrösse" display={`${comma(roomSeconds)} s`} min={0.3} max={5} step={0.1} value={roomSeconds}
                    onChange={(event) => {
                      setRoomSeconds(Number(event.target.value))
                      enable('room')
                    }} />
                  <Slider label="Anteil" display={`${Math.round(roomMix * 100)} %`} min={0.05} max={1} step={0.05} value={roomMix}
                    onChange={(event) => {
                      setRoomMix(Number(event.target.value))
                      enable('room')
                    }} />
                </div>
              </div>
            </div>
          </Reveal>

          {/* -- the expert half ------------------------------------------------ */}
          <Reveal label="Tonhöhe, Tempo, Kanäle und Abtastrate" className="mt-[16px]">
            <div className="grid gap-[16px] rounded-card bg-panel-soft p-[16px] sm:grid-cols-2">
              <div className="flex flex-col gap-[8px]">
                <Toggle label="Tonhöhe" checked={Boolean(on.pitch)} onChange={toggle('pitch')}
                  hint="Länge bleibt gleich. Live klingt es etwas körniger; übernommen rechnet ein Phasenvocoder." />
                <Slider label="Halbtöne" display={`${semitones > 0 ? '+' : ''}${semitones}`}
                  min={-12} max={12} step={1} value={semitones}
                  onChange={(event) => {
                    setSemitones(Number(event.target.value))
                    enable('pitch')
                  }} />
              </div>

              <div className="flex flex-col gap-[8px]">
                <Toggle label="Tempo" checked={Boolean(on.tempo)} onChange={toggle('tempo')}
                  hint="Tonhöhe bleibt gleich. Gilt für die ganze Aufnahme." />
                <Slider label="Faktor" display={tempo === 1 ? 'unverändert' : `${comma(tempo, 2)}×`}
                  min={0.5} max={2} step={0.05} value={tempo}
                  onChange={(event) => {
                    setTempo(Number(event.target.value))
                    enable('tempo')
                  }} />
              </div>

              <Field label="Kanäle" hint="Mono spart die Hälfte; Stereo verdoppelt einen Mono-Kanal.">
                <div className="flex flex-wrap gap-[8px]">
                  <Button size="sm" variant="quiet" disabled={busy !== null || current.channels.length === 1}
                    onClick={() => void apply('Auf Mono gelegt', (a) => setChannels(a, 1))}>
                    Mono
                  </Button>
                  <Button size="sm" variant="quiet" disabled={busy !== null || current.channels.length === 2}
                    onClick={() => void apply('Auf Stereo gelegt', (a) => setChannels(a, 2))}>
                    Stereo
                  </Button>
                  {current.channels.length === 2 ? (
                    <Button size="sm" variant="quiet" disabled={busy !== null}
                      onClick={() => void apply('Kanäle getauscht', (a) => channelTrick(a, 'swap'))}>
                      L/R tauschen
                    </Button>
                  ) : null}
                </div>
              </Field>

              <Field label="Abtastrate" hint="Lineare Interpolation — gut fürs Musikalische, kein Studio-Konverter.">
                <div className="flex flex-wrap gap-[8px]">
                  {[22050, 44100, 48000].map((rate) => (
                    <Button key={rate} size="sm" variant="quiet"
                      disabled={busy !== null || current.sampleRate === rate}
                      onClick={() => void apply(`${rate / 1000} kHz`, (a) => resampleAudio(a, rate))}>
                      {rate / 1000} kHz
                    </Button>
                  ))}
                </div>
              </Field>
            </div>
          </Reveal>

          {/* -- export --------------------------------------------------------- */}
          <div className="mt-[16px] flex flex-wrap items-center gap-[8px]">
            <Button disabled={!bytes || busy !== null}
              onClick={() => bytes && saveBytes(bytes, outputName, 'audio/wav')}>
              Als WAV speichern
              <ArrowRight />
            </Button>
            <Button variant="quiet" disabled={!bytes || busy !== null} onClick={keep}>
              In die Sitzung übernehmen
            </Button>
            <Select
              value={bitDepth}
              onChange={(event) => setBitDepth(Number(event.target.value) as WavBitDepth)}
              aria-label="Bittiefe"
              className="w-auto! py-[8px] text-small"
            >
              <option value={16}>16 bit</option>
              <option value={24}>24 bit</option>
              <option value={32}>32 bit Float</option>
            </Select>
            {bytes ? <span className="value text-small text-muted">{formatBytes(bytes.byteLength)}</span> : null}
            {busy ? <span className="text-small text-muted">{busy}…</span> : null}
          </div>
        </Card>
      </div>

      <aside className="flex flex-col gap-[16px]">
        <Card tone="cream" size="compact">
          <SectionHead rule={false}>Verlauf</SectionHead>
          {history.length === 0 ? (
            <p className="mt-[8px] text-small leading-[1.5] text-muted">
              Noch unverändert. Strg/Cmd + Z nimmt jeden Schritt zurück; die Ausgangsdatei bleibt
              unangetastet.
            </p>
          ) : (
            <ol className="mt-[8px] flex flex-col gap-[4px] text-small">
              {history.map((step, index) => (
                <li key={`${step.label}-${index}`} className="flex gap-[8px] text-muted">
                  <span className="value shrink-0">{index + 1}.</span>
                  <span className="text-prose/85">{step.label}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>

        {others.length > 1 ? (
          <Card tone="cream" size="compact">
            <SectionHead>Anhängen</SectionHead>
            <p className="mt-[8px] text-small leading-[1.5] text-prose/85">
              Eine zweite Aufnahme hinten anfügen, mit kurzer Überblendung.
            </p>
            <div className="mt-[12px] flex flex-col gap-[8px]">
              <Select value={joinWith} onChange={(event) => setJoinWith(event.target.value)}>
                <option value="">Datei wählen…</option>
                {others.filter((entry) => entry.id !== asset.id).map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.name}</option>
                ))}
              </Select>
              <Button size="sm" disabled={!joinWith || busy !== null}
                onClick={() => {
                  const other = others.find((entry) => entry.id === joinWith)
                  if (!other?.audio) {
                    setError('Diese Datei ist noch nicht dekodiert — einmal auswählen, dann geht es.')
                    return
                  }
                  void apply(`${other.name} angehängt`, (a) => concatAudio([a, other.audio!], 0.05))
                }}>
                Anhängen
              </Button>
            </div>
          </Card>
        ) : null}


      </aside>
    </div>
  )
}
