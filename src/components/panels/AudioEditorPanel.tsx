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
  applyGain,
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
  compressAudio,
  copyRange,
  duplicateRange,
  echo,
  fadeRange,
  highpassFilter,
  insertAt,
  insertSilence,
  learnNoise,
  lowpassFilter,
  muteRange,
  processRange,
  removeNoise,
  reverb,
  shelfEq,
} from '../../lib/effects'
import { formatBytes, formatTimecode } from '../../lib/format'
import { pitchShift, stretchAudio } from '../../lib/timestretch'
import { encodeWav, type AudioData, type WavBitDepth } from '../../lib/wav'
import { useDecodedAudio } from '../../hooks/useDecodedAudio'
import { useActiveAssetOfKind, useAssetsOfKind, useSession } from '../../state/store'
import { FileDrop } from '../FileDrop'
import { Waveform } from '../Waveform'
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
} from '../ui/primitives'

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
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
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
    async (label: string, operation: (audio: AudioData) => AudioData | Promise<AudioData>) => {
      if (!current) return
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
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
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

  /* -- playing ------------------------------------------------------------- */

  const stop = useCallback(() => {
    sourceRef.current?.stop()
    sourceRef.current = null
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPosition(null)
  }, [])

  const play = useCallback(async () => {
    if (!current) return
    stop()
    await resumeAudioContext()
    const context = getAudioContext()
    const from = hasSelection ? span.start : 0
    const until = hasSelection ? span.end : duration
    const source = context.createBufferSource()
    source.buffer = toAudioBuffer(current, context)
    source.connect(context.destination)
    const length = Math.max(0.01, until - from)
    if (loop) {
      // Round and round until „Stopp“ — the way a cut is judged in a DAW.
      source.loop = true
      source.loopStart = from
      source.loopEnd = until
      source.start(0, from)
    } else {
      source.start(0, from, length)
    }
    sourceRef.current = source
    const startedAt = context.currentTime
    const follow = () => {
      const elapsed = context.currentTime - startedAt
      if (!loop && elapsed >= length) return stop()
      setPosition(from + (loop ? elapsed % length : elapsed))
      rafRef.current = requestAnimationFrame(follow)
    }
    follow()
    source.onended = () => {
      if (sourceRef.current === source) stop()
    }
  }, [current, hasSelection, span.start, span.end, duration, stop, loop])

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

  /** Runs an effect on the selection if there is one, otherwise on everything. */
  const shape = (label: string, fn: (audio: AudioData) => AudioData | Promise<AudioData>) =>
    void apply(hasSelection ? `${label} (Ausschnitt)` : label, (audio) =>
      hasSelection ? processRange(audio, span.start, span.end, fn) : fn(audio),
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
            className="mt-[16px] cursor-text touch-none bg-panel-soft p-[12px] select-none"
          >
            <Waveform audio={shown} height={130} position={positionInView} selection={liveInView} />
          </div>

          <div className="mt-[8px] flex flex-wrap items-center gap-[8px]">
            <Button size="sm" onClick={() => void play()}>
              {hasSelection ? 'Auswahl hören' : 'Alles hören'}
            </Button>
            <Button size="sm" variant="quiet" onClick={stop}>
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
                  onClick={() => void apply('Über den Ausschnitt eingeblendet', (a) => fadeRange(a, span.start, span.end, 'in'))}>
                  Hier einblenden
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null}
                  onClick={() => void apply('Über den Ausschnitt ausgeblendet', (a) => fadeRange(a, span.start, span.end, 'out'))}>
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
                <Button size="sm" variant="quiet" disabled={busy !== null || gain === 0}
                  onClick={() => void apply(`Pegel ${gain > 0 ? '+' : ''}${gain} dB`,
                    (a) => applyGain(a, gain, hasSelection ? span.start : 0, hasSelection ? span.end : Infinity))}>
                  Anwenden
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null}
                  onClick={() => void apply('Auf −0,3 dBFS normalisiert', (a) => normalizePeak(a, -0.3))}>
                  Auf −0,3 dBFS bringen
                </Button>
              </div>
            </div>

            <div>
              <div className="grid grid-cols-2 gap-[12px]">
                <Slider label="Einblenden" display={`${fadeIn.toFixed(2)} s`}
                  min={0} max={5} step={0.05} value={fadeIn}
                  onChange={(event) => setFadeIn(Number(event.target.value))} />
                <Slider label="Ausblenden" display={`${fadeOut.toFixed(2)} s`}
                  min={0} max={5} step={0.05} value={fadeOut}
                  onChange={(event) => setFadeOut(Number(event.target.value))} />
              </div>
              <div className="mt-[8px]">
                <Button size="sm" variant="quiet" disabled={busy !== null || (fadeIn === 0 && fadeOut === 0)}
                  onClick={() => void apply('Blenden gesetzt', (a) => applyFades(a, fadeIn, fadeOut))}>
                  Blenden anwenden
                </Button>
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
          <Reveal label={`Klang: Filter, Bass und Höhen, Kompressor, Rauschen, Echo, Hall${hasSelection ? ' — gilt für den Ausschnitt' : ''}`} className="mt-[16px]">
            <div className="grid gap-[20px] rounded-card bg-panel-soft p-[16px] sm:grid-cols-2">
              <div className="flex flex-col gap-[8px]">
                <Slider label="Tiefen entfernen unter" display={`${highpassHz} Hz`}
                  min={20} max={400} step={5} value={highpassHz}
                  onChange={(event) => setHighpassHz(Number(event.target.value))} />
                <div>
                  <Button size="sm" variant="quiet" disabled={busy !== null}
                    onClick={() => shape(`Tiefen unter ${highpassHz} Hz entfernt`, (a) => highpassFilter(a, highpassHz))}>
                    Tiefen entfernen
                  </Button>
                </div>
                <p className="text-small leading-[1.45] text-muted">Rumpeln, Trittschall, Brummen. Für Stimme 80–120 Hz.</p>
              </div>

              <div className="flex flex-col gap-[8px]">
                <Slider label="Höhen entfernen über" display={`${(lowpassHz / 1000).toFixed(1).replace('.', ',')} kHz`}
                  min={1000} max={20000} step={250} value={lowpassHz}
                  onChange={(event) => setLowpassHz(Number(event.target.value))} />
                <div>
                  <Button size="sm" variant="quiet" disabled={busy !== null}
                    onClick={() => shape(`Höhen über ${(lowpassHz / 1000).toFixed(1)} kHz entfernt`, (a) => lowpassFilter(a, lowpassHz))}>
                    Höhen entfernen
                  </Button>
                </div>
                <p className="text-small leading-[1.45] text-muted">Zischen und Rauschen oben, oder der Klang „durchs Telefon“.</p>
              </div>

              <div className="flex flex-col gap-[8px]">
                <div className="grid grid-cols-2 gap-[12px]">
                  <Slider label="Bass" display={`${bassDb > 0 ? '+' : ''}${bassDb} dB`}
                    min={-12} max={12} step={1} value={bassDb}
                    onChange={(event) => setBassDb(Number(event.target.value))} />
                  <Slider label="Höhen" display={`${trebleDb > 0 ? '+' : ''}${trebleDb} dB`}
                    min={-12} max={12} step={1} value={trebleDb}
                    onChange={(event) => setTrebleDb(Number(event.target.value))} />
                </div>
                <div>
                  <Button size="sm" variant="quiet" disabled={busy !== null || (bassDb === 0 && trebleDb === 0)}
                    onClick={() => shape(`Bass ${bassDb > 0 ? '+' : ''}${bassDb} dB, Höhen ${trebleDb > 0 ? '+' : ''}${trebleDb} dB`, (a) => shelfEq(a, bassDb, trebleDb))}>
                    Klang anpassen
                  </Button>
                </div>
                <p className="text-small leading-[1.45] text-muted">Kuhschwanz-Filter bei 120 Hz und 6 kHz.</p>
              </div>

              <div className="flex flex-col gap-[8px]">
                <div className="grid grid-cols-2 gap-[12px]">
                  <Slider label="Ab" display={`${compThreshold} dBFS`}
                    min={-50} max={-3} step={1} value={compThreshold}
                    onChange={(event) => setCompThreshold(Number(event.target.value))} />
                  <Slider label="Verhältnis" display={`${compRatio}:1`}
                    min={1.5} max={10} step={0.5} value={compRatio}
                    onChange={(event) => setCompRatio(Number(event.target.value))} />
                </div>
                <div>
                  <Button size="sm" variant="quiet" disabled={busy !== null}
                    onClick={() => shape(`Kompressor ${compRatio}:1 ab ${compThreshold} dBFS`, (a) => compressAudio(a, compThreshold, compRatio).audio)}>
                    Komprimieren
                  </Button>
                </div>
                <p className="text-small leading-[1.45] text-muted">Laute Stellen zurücknehmen, leise näher heran; gleicht die Lautheit danach etwas aus.</p>
              </div>

              <div className="flex flex-col gap-[8px] sm:col-span-2">
                <p className="text-small text-prose">Rauschen entfernen</p>
                <p className="text-small leading-[1.45] text-muted">
                  {noise
                    ? 'Rauschprofil gelernt. Jetzt die ganze Aufnahme — oder einen Ausschnitt — davon befreien.'
                    : 'Erst eine Stelle auswählen, an der nur das Rauschen zu hören ist, und daraus lernen.'}
                </p>
                <div className="flex flex-wrap items-center gap-[8px]">
                  <Button size="sm" variant="quiet" disabled={busy !== null || !hasSelection}
                    onClick={() => {
                      if (!current) return
                      setNoise(learnNoise(copyRange(current, span.start, span.end)))
                      log('ton', `Rauschprofil aus ${(span.end - span.start).toFixed(2)} s gelernt`)
                    }}>
                    Rauschprofil aus der Auswahl
                  </Button>
                  {noise ? (
                    <>
                      <Select value={noiseCut} onChange={(event) => setNoiseCut(Number(event.target.value))}
                        aria-label="Stärke" className="w-auto! py-[6px] text-small">
                        {[6, 12, 18, 24].map((value) => (
                          <option key={value} value={value}>bis {value} dB</option>
                        ))}
                      </Select>
                      <Button size="sm" disabled={busy !== null}
                        onClick={() => shape(`Rauschen um bis zu ${noiseCut} dB gesenkt`, (a) => removeNoise(a, noise, noiseCut))}>
                        Rauschen entfernen
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-col gap-[8px]">
                <div className="grid grid-cols-3 gap-[12px]">
                  <Slider label="Abstand" display={`${echoDelay} ms`} min={40} max={1200} step={10} value={echoDelay}
                    onChange={(event) => setEchoDelay(Number(event.target.value))} />
                  <Slider label="Wiederholen" display={`${Math.round(echoFeedback * 100)} %`} min={0} max={0.85} step={0.05} value={echoFeedback}
                    onChange={(event) => setEchoFeedback(Number(event.target.value))} />
                  <Slider label="Anteil" display={`${Math.round(echoMix * 100)} %`} min={0.05} max={1} step={0.05} value={echoMix}
                    onChange={(event) => setEchoMix(Number(event.target.value))} />
                </div>
                <div>
                  <Button size="sm" variant="quiet" disabled={busy !== null}
                    onClick={() => shape(`Echo ${echoDelay} ms`, (a) => echo(a, echoDelay, echoFeedback, echoMix, !hasSelection))}>
                    Echo
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-[8px]">
                <div className="grid grid-cols-2 gap-[12px]">
                  <Slider label="Raumgrösse" display={`${roomSeconds.toFixed(1).replace('.', ',')} s`} min={0.3} max={5} step={0.1} value={roomSeconds}
                    onChange={(event) => setRoomSeconds(Number(event.target.value))} />
                  <Slider label="Anteil" display={`${Math.round(roomMix * 100)} %`} min={0.05} max={1} step={0.05} value={roomMix}
                    onChange={(event) => setRoomMix(Number(event.target.value))} />
                </div>
                <div>
                  <Button size="sm" variant="quiet" disabled={busy !== null}
                    onClick={() => shape(`Hall ${roomSeconds.toFixed(1)} s`, (a) => reverb(a, roomSeconds, roomMix, !hasSelection))}>
                    Hall
                  </Button>
                </div>
              </div>
            </div>
          </Reveal>

          {/* -- the expert half ------------------------------------------------ */}
          <Reveal label="Tonhöhe, Tempo, Kanäle und Abtastrate" className="mt-[16px]">
            <div className="grid gap-[16px] rounded-card bg-panel-soft p-[16px] sm:grid-cols-2">
              <div>
                <Slider label="Tonhöhe" display={`${semitones > 0 ? '+' : ''}${semitones} Halbtöne`}
                  min={-12} max={12} step={1} value={semitones}
                  onChange={(event) => setSemitones(Number(event.target.value))} />
                <div className="mt-[8px]">
                  <Button size="sm" variant="quiet" disabled={busy !== null || semitones === 0}
                    onClick={() => void apply(`Tonhöhe ${semitones > 0 ? '+' : ''}${semitones}`,
                      (a) => pitchShift(a, { semitones, preserveDuration: true }))}>
                    Transponieren
                  </Button>
                </div>
                <p className="mt-[8px] text-small leading-[1.45] text-muted">
                  Länge bleibt gleich — ein Phasenvocoder, kein schnelleres Abspielen.
                </p>
              </div>

              <div>
                <Slider label="Tempo" display={tempo === 1 ? 'unverändert' : `${tempo.toFixed(2)}×`}
                  min={0.5} max={2} step={0.05} value={tempo}
                  onChange={(event) => setTempo(Number(event.target.value))} />
                <div className="mt-[8px]">
                  <Button size="sm" variant="quiet" disabled={busy !== null || tempo === 1}
                    onClick={() => void apply(`Tempo ${tempo.toFixed(2)}×`, (a) => stretchAudio(a, 1 / tempo))}>
                    Dehnen
                  </Button>
                </div>
                <p className="mt-[8px] text-small leading-[1.45] text-muted">
                  Tonhöhe bleibt gleich.
                </p>
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
