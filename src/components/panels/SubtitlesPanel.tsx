/**
 * What is said, as text: a transcript, subtitle files, or subtitles in the
 * video itself — recognised by Whisper on this machine.
 *
 * The one thing that crosses the network is the model, once: its files come
 * from Hugging Face and stay in the browser's cache. The recording never
 * leaves. Every line can be corrected before anything is written, because a
 * recogniser that is right nine times in ten still needs the tenth fixed.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { saveBytes } from '../../lib/download'
import { loadFfmpeg, probeVideo, runFfmpeg } from '../../lib/ffmpegClient'
import { formatBytes, formatTimecode, withExtension } from '../../lib/format'
import {
  SPEECH_LANGUAGES,
  SPEECH_MODELS,
  renderCueStrips,
  toSpeechSamples,
  toSrt,
  toText,
  toVtt,
  transcribe,
  type TranscriptSegment,
} from '../../lib/transcribe'
import { useDecodedAudio } from '../../hooks/useDecodedAudio'
import { useActiveAsset, useSession, type Asset } from '../../state/store'
import { FileDrop } from '../FileDrop'
import { ArrowRight, Button, Card, Field, Notice, Progress, SectionHead, Select } from '../ui/primitives'

const MODEL_KEY = 'sondra:sprachmodell'
const LANGUAGE_KEY = 'sondra:sprache'

/** ISO 639-2 for the subtitle track's language tag. */
const THREE_LETTER: Record<string, string> = {
  de: 'ger', en: 'eng', fr: 'fre', it: 'ita', es: 'spa', pt: 'por', nl: 'dut', pl: 'pol', tr: 'tur', sq: 'alb',
  sr: 'srp', hr: 'hrv', ta: 'tam',
}


function remembered(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* only a preference */
  }
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'decoding' }
  | { kind: 'loading'; loaded: number; total: number }
  | { kind: 'listening'; fraction: number; done: number }
  | { kind: 'writing'; what: string }

export function SubtitlesPanel() {
  const active = useActiveAsset()
  const asset: Asset | null = active && (active.kind === 'audio' || active.kind === 'video') ? active : null
  const addAsset = useSession((state) => state.addAsset)
  const setActiveAsset = useSession((state) => state.setActiveAsset)
  const log = useSession((state) => state.log)
  const { decode } = useDecodedAudio(asset)

  const [model, setModel] = useState(() => remembered(MODEL_KEY, SPEECH_MODELS[0].id))
  const [language, setLanguage] = useState(() => remembered(LANGUAGE_KEY, 'de'))
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // A different file makes the last transcript someone else's.
  useEffect(() => {
    setSegments(null)
    setError(null)
    setElapsed(null)
  }, [asset?.id])

  const chosen = SPEECH_MODELS.find((entry) => entry.id === model) ?? SPEECH_MODELS[0]
  const busy = stage.kind !== 'idle'
  const stem = asset ? asset.name.replace(/\.[^.]+$/, '') : 'untertitel'

  const run = async () => {
    if (!asset) return
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setSegments(null)
    const started = performance.now()
    try {
      setStage({ kind: 'decoding' })
      const audio = await decode()
      if (!audio) throw new Error('Die Tonspur liess sich nicht lesen.')
      const samples = await toSpeechSamples(audio)
      setStage({ kind: 'loading', loaded: 0, total: chosen.bytes })
      const result = await transcribe(samples, {
        model: chosen.id,
        language,
        signal: controller.signal,
        onLoading: (loaded, total) => setStage({ kind: 'loading', loaded, total: Math.max(total, loaded, chosen.bytes) }),
        onProgress: (fraction, done) => setStage({ kind: 'listening', fraction, done }),
        onPartial: (partial) => setSegments(partial),
      })
      setSegments(result)
      setElapsed((performance.now() - started) / 1000)
      log('untertitel', `${asset.name}: ${result.length} ${result.length === 1 ? "Abschnitt" : "Abschnitte"} erkannt (${chosen.label})`)
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') {
        log('untertitel', 'Abgebrochen', 'warn')
      } else {
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(message)
        log('untertitel', message, 'error')
      }
    } finally {
      setStage({ kind: 'idle' })
      abortRef.current = null
    }
  }

  const edit = (index: number, text: string) =>
    setSegments((current) => current?.map((segment, at) => (at === index ? { ...segment, text } : segment)) ?? null)

  const cleaned = useMemo(() => segments?.filter((segment) => segment.text.trim()) ?? [], [segments])
  const encoder = new TextEncoder()

  /** Subtitles into the video: as a track to switch on, or drawn into the picture. */
  const intoVideo = async (burn: boolean) => {
    if (!asset || cleaned.length === 0) return
    setError(null)
    setStage({ kind: 'writing', what: burn ? 'Untertitel werden ins Bild gezeichnet' : 'Untertitelspur wird eingefügt' })
    try {
      await loadFfmpeg()
      const extension = (asset.name.split('.').pop() ?? '').toLowerCase()
      const mp4Family = ['mp4', 'm4v', 'mov'].includes(extension)
      const input = `in.${extension || 'mp4'}`
      const inputs: Record<string, Uint8Array> = { [input]: asset.bytes, 'subs.srt': encoder.encode(toSrt(cleaned)) }
      const tag = THREE_LETTER[language]
      let output: string
      let args: string[]
      if (burn) {
        const facts = await probeVideo(asset.bytes, asset.name)
        if (!facts.width || !facts.height) throw new Error('Das Video hat kein Bild, in das Untertitel gezeichnet werden könnten.')
        const strips = await renderCueStrips(cleaned, facts.width, facts.height, facts.duration || cleaned.at(-1)!.end)
        Object.assign(inputs, strips.files)
        output = 'out.mp4'
        // One input per cue, each laid over the picture for its own span.
        const chain = strips.cues
          .map((cue, index) => {
            const from = index === 0 ? '[0:v]' : `[v${index}]`
            const to = index === strips.cues.length - 1 ? '[v]' : `[v${index + 1}]`
            return `${from}[${index + 1}:v]overlay=0:H-h:enable='between(t,${cue.start.toFixed(3)},${cue.end.toFixed(3)})'${to}`
          })
          .join(';')
        args = ['-i', input, ...strips.cues.flatMap((cue) => ['-i', cue.file]),
          '-filter_complex', chain, '-map', '[v]', '-map', '0:a?',
          // `medium`: `veryfast` crashes this WebAssembly x264 (see lib/video.ts).
          '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
          ...(mp4Family ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']), output]
      } else {
        output = mp4Family ? 'out.mp4' : 'out.mkv'
        args = ['-i', input, '-i', 'subs.srt', '-map', '0', '-map', '1', '-c', 'copy', '-c:s', mp4Family ? 'mov_text' : 'srt',
          ...(tag ? ['-metadata:s:s:0', `language=${tag}`] : []), output]
      }
      const { files } = await runFfmpeg({ input: inputs, output: [output], args, folders: burn ? ['sub'] : [] })
      const bytes = files[output]
      if (!bytes || bytes.byteLength < 1024) throw new Error('FFmpeg hat kein Video geschrieben.')
      const name = `${stem} (${burn ? 'mit Untertiteln' : 'Untertitelspur'}).${output.split('.').pop()}`
      addAsset({
        name,
        bytes,
        mime: output.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4',
        sizeBytes: bytes.byteLength,
        kind: 'video',
        audio: null,
        durationSeconds: asset.durationSeconds,
        origin: 'derived',
      })
      // The new video goes into the session; the transcript stays on the
      // source, so the other way into the video is still one click away.
      setActiveAsset(asset.id)
      log('untertitel', `${name} in der Sitzung (${formatBytes(bytes.byteLength)})`)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      log('untertitel', message.split('\n')[0], 'error')
    } finally {
      setStage({ kind: 'idle' })
    }
  }

  return (
    <div className="flex flex-col gap-[16px]">
      <Card tone="cream">
        <h2 className="display-md mt-[8px] mb-[12px]">Was gesagt wird, als Text und Untertitel</h2>

        {!asset ? (
          <div className="mt-[16px]">
            <FileDrop />
          </div>
        ) : (
          <>
            <p className="text-small text-prose">
              <span className="value text-ink">{asset.name}</span>
              {asset.durationSeconds ? <span className="value text-muted"> · {formatTimecode(asset.durationSeconds)}</span> : null}
            </p>

            <div className="mt-[16px] grid max-w-[640px] gap-[16px] sm:grid-cols-2">
              <Field label="Sprache">
                <Select
                  value={language}
                  disabled={busy}
                  onChange={(event) => {
                    setLanguage(event.target.value)
                    remember(LANGUAGE_KEY, event.target.value)
                  }}
                >
                  {SPEECH_LANGUAGES.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Erkennung">
                <Select
                  value={chosen.id}
                  disabled={busy}
                  onChange={(event) => {
                    setModel(event.target.value)
                    remember(MODEL_KEY, event.target.value)
                  }}
                >
                  {SPEECH_MODELS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="mt-[8px] max-w-[64ch] text-small leading-[1.55] text-muted">
              {chosen.hint} Das Modell kommt beim ersten Mal von Hugging Face und bleibt danach auf diesem Gerät; die
              Aufnahme selbst wird nirgendwohin geschickt.
            </p>

            <div className="mt-[20px] flex flex-wrap items-center gap-[12px]">
              <Button onClick={() => void run()} disabled={busy}>
                {busy && stage.kind !== 'writing' ? 'Läuft …' : segments ? 'Noch einmal erkennen' : 'Text erkennen'}
                {!busy ? <ArrowRight /> : null}
              </Button>
              {busy && stage.kind !== 'writing' ? (
                <Button variant="quiet" onClick={() => abortRef.current?.abort()}>
                  Abbrechen
                </Button>
              ) : null}
            </div>

            {stage.kind === 'decoding' ? <div className="mt-[16px]"><Progress value={null} label="Ton wird gelesen" /></div> : null}
            {stage.kind === 'loading' ? (
              <div className="mt-[16px]">
                <Progress
                  value={stage.total > 0 ? stage.loaded / stage.total : null}
                  label={stage.loaded > 0 ? `Modell wird geladen · ${formatBytes(stage.loaded)} von ${formatBytes(stage.total)}` : 'Modell wird vorbereitet'}
                />
              </div>
            ) : null}
            {stage.kind === 'listening' ? (
              <div className="mt-[16px]">
                <Progress value={stage.fraction} label={`Wird erkannt · bei ${formatTimecode(stage.done)}`} />
              </div>
            ) : null}
            {stage.kind === 'writing' ? <div className="mt-[16px]"><Progress value={null} label={stage.what} /></div> : null}
          </>
        )}
      </Card>

      {error ? (
        <Notice tone="error" title="Hat nicht geklappt">
          {error}
        </Notice>
      ) : null}

      {segments && segments.length === 0 && !busy ? (
        <Notice tone="warn" title="Keine Sprache gefunden">
          In dieser Datei hat die Erkennung nichts Gesprochenes gehört. Eine andere Sprache einstellen oder „Genauer“ versuchen.
        </Notice>
      ) : null}

      {segments && segments.length > 0 ? (
        <Card tone="slate">
          <div className="flex flex-wrap items-baseline justify-between gap-[12px]">
            <SectionHead>Text</SectionHead>
            <span className="value text-small text-muted">
              {segments.length} {segments.length === 1 ? 'Abschnitt' : 'Abschnitte'}{elapsed !== null ? ` · in ${elapsed.toFixed(0)} s erkannt` : ' · läuft noch'}
            </span>
          </div>
          <p className="mt-[4px] text-small text-muted">Jede Zeile lässt sich korrigieren, bevor sie gespeichert wird.</p>

          <ol className="mt-[12px] flex max-h-[420px] flex-col overflow-y-auto">
            {segments.map((segment, index) => (
              <li key={`${segment.start}-${index}`} className="flex items-start gap-[12px] border-t border-line py-[8px] first:border-t-0">
                <span className="value w-[72px] shrink-0 pt-[6px] text-micro text-muted">{formatTimecode(segment.start)}</span>
                <textarea
                  value={segment.text}
                  onChange={(event) => edit(index, event.target.value)}
                  rows={Math.max(1, Math.ceil(segment.text.length / 70))}
                  aria-label={`Text ab ${formatTimecode(segment.start)}`}
                  className="min-w-0 flex-1 resize-y rounded-nav bg-transparent px-[8px] py-[4px] text-body leading-[1.5] text-prose outline-none ring-1 ring-inset ring-transparent hover:ring-line focus:ring-ink"
                />
              </li>
            ))}
          </ol>

          {!busy ? (
            <div className="mt-[20px] flex flex-wrap gap-[8px]">
              <Button onClick={() => saveBytes(encoder.encode(toSrt(cleaned)), `${stem}.srt`, 'application/x-subrip')}>
                Als SRT speichern
                <ArrowRight />
              </Button>
              <Button variant="quiet" onClick={() => saveBytes(encoder.encode(toVtt(cleaned)), `${stem}.vtt`, 'text/vtt')}>
                Als VTT
              </Button>
              <Button variant="quiet" onClick={() => saveBytes(encoder.encode(toText(cleaned)), withExtension(asset?.name ?? 'text', 'txt'), 'text/plain')}>
                Als Text
              </Button>
              <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(toText(cleaned))}>
                Text kopieren
              </Button>
            </div>
          ) : null}

          {!busy && asset?.kind === 'video' ? (
            <div className="mt-[20px] border-t border-line pt-[16px]">
              <p className="mb-[12px] text-small text-prose">Ins Video, als neue Datei in der Sitzung:</p>
              <div className="flex flex-wrap gap-[8px]">
                <Button variant="quiet" onClick={() => void intoVideo(false)}>
                  Als Untertitelspur
                </Button>
                <Button variant="quiet" onClick={() => void intoVideo(true)}>
                  Ins Bild brennen
                </Button>
              </div>
              <p className="mt-[8px] max-w-[64ch] text-small leading-[1.55] text-muted">
                Die Spur lässt sich im Player ein- und ausschalten und kostet kaum Zeit. Eingebrannt sind die Untertitel
                überall zu sehen, auch auf Instagram oder WhatsApp — dafür wird das Bild neu gerechnet.
              </p>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  )
}
