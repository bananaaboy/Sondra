/**
 * Recording the screen: a whole screen or one window, with the computer's
 * sound and the microphone if wanted, straight into the session.
 *
 * The recording becomes a video like any other, so cutting it and putting
 * subtitles under it are the existing tools, one click away. In the app the
 * screens and windows are chosen here, with pictures; in a browser the
 * browser asks, in its own dialog, because only it may.
 */

import { useEffect, useRef, useState } from 'react'

import { saveBytes } from '../../lib/download'
import { formatBytes, formatTimecode } from '../../lib/format'
import {
  canRecordScreen,
  captureSources,
  finishRecording,
  startScreenRecording,
  type CaptureSource,
  type ScreenRecording,
} from '../../lib/screenRecord'
import { holdScreenAwake } from '../../lib/wakeLock'
import { useSession, type Asset } from '../../state/store'
import { ArrowRight, Button, Card, Field, Notice, Progress, Select, Toggle } from '../ui/primitives'

const SETTINGS_KEY = 'sondra:bildschirm'

interface Settings {
  systemAudio: boolean
  microphone: boolean
  frameRate: 30 | 60
}

function rememberedSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')
    if (saved && typeof saved === 'object') {
      return { systemAudio: saved.systemAudio !== false, microphone: saved.microphone === true, frameRate: saved.frameRate === 60 ? 60 : 30 }
    }
  } catch {
    /* only a preference */
  }
  return { systemAudio: true, microphone: false, frameRate: 30 }
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; paused: boolean; bytes: number; seconds: number }
  | { kind: 'finishing' }

function fileName(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `Bildschirm ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}.webm`
}

export function ScreenPanel() {
  const addAsset = useSession((state) => state.addAsset)
  const setActiveAsset = useSession((state) => state.setActiveAsset)
  const setPanel = useSession((state) => state.setPanel)
  const log = useSession((state) => state.log)

  const supported = canRecordScreen()
  const [settings, setSettings] = useState<Settings>(rememberedSettings)
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [listing, setListing] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ asset: Asset; url: string; fixed: boolean } | null>(null)
  const recordingRef = useRef<ScreenRecording | null>(null)
  const previewRef = useRef<HTMLVideoElement>(null)

  const update = (patch: Partial<Settings>) =>
    setSettings((current) => {
      const next = { ...current, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      } catch {
        /* only a preference */
      }
      return next
    })

  const list = async () => {
    setListing(true)
    try {
      const found = await captureSources()
      setSources(found)
      if (found && !found.some((source) => source.id === sourceId)) setSourceId(found.find((source) => source.kind === 'screen')?.id ?? found[0]?.id ?? null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setListing(false)
    }
  }

  useEffect(() => {
    if (supported) void list()
    // Leaving the tool ends a recording rather than leaving it running unseen.
    return () => recordingRef.current?.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The result's object URL belongs to this view.
  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url)
  }, [result])

  const start = async () => {
    setError(null)
    setStage({ kind: 'starting' })
    let release: (() => void) | null = null
    try {
      const recording = await startScreenRecording({ ...settings, sourceId: sourceId ?? undefined })
      recordingRef.current = recording
      release = await holdScreenAwake()
      if (previewRef.current) previewRef.current.srcObject = new MediaStream(recording.stream.getVideoTracks())
      setStage({ kind: 'recording', paused: false, bytes: 0, seconds: 0 })
      recording.onSize((bytes, seconds) =>
        setStage((current) => (current.kind === 'recording' ? { ...current, bytes, seconds } : current)),
      )
      const heard = [recording.sound.system ? 'Ton des Rechners' : '', recording.sound.microphone ? 'Mikrofon' : ''].filter(Boolean)
      log('bildschirm', `Aufnahme läuft${heard.length ? ` · ${heard.join(' und ')}` : ' · ohne Ton'}`)
      if (settings.systemAudio && !recording.sound.system) {
        setError('Der Ton des Rechners ist nicht dabei. Im Browser beim Teilen „Audio teilen“ anhaken; Fenster geben im Browser keinen Ton.')
      }

      const recorded = await recording.done
      recordingRef.current = null
      setStage({ kind: 'finishing' })
      const finished = await finishRecording(recorded.bytes)
      const asset = addAsset({
        name: fileName(),
        bytes: finished.bytes,
        mime: 'video/webm',
        sizeBytes: finished.bytes.byteLength,
        kind: 'video',
        audio: null,
        durationSeconds: recorded.seconds || null,
        origin: 'derived',
      })
      setActiveAsset(asset.id)
      setResult({ asset, url: URL.createObjectURL(new Blob([finished.bytes as BlobPart], { type: 'video/webm' })), fixed: finished.fixed })
      log('bildschirm', `${asset.name}: ${formatTimecode(recorded.seconds)}, ${formatBytes(finished.bytes.byteLength)}`)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      log('bildschirm', message, 'warn')
    } finally {
      release?.()
      recordingRef.current = null
      setStage({ kind: 'idle' })
    }
  }

  const togglePause = () => {
    const recording = recordingRef.current
    if (!recording || stage.kind !== 'recording') return
    if (stage.paused) recording.resume()
    else recording.pause()
    setStage({ ...stage, paused: !stage.paused })
  }

  if (!supported) {
    return (
      <Card tone="cream">
        <h2 className="display-md mt-[8px] mb-[12px]">Bildschirm aufnehmen</h2>
        <Notice tone="warn" title="Hier nicht möglich">
          Dieser Browser kann den Bildschirm nicht aufnehmen — auf Telefonen und Tablets geht das meist nicht. Am Rechner in
          Edge, Chrome oder Firefox, oder in der App.
        </Notice>
      </Card>
    )
  }

  const recording = stage.kind === 'recording'
  const busy = stage.kind !== 'idle'
  const screens = sources?.filter((source) => source.kind === 'screen') ?? []
  const windows = sources?.filter((source) => source.kind === 'window') ?? []

  return (
    <div className="flex flex-col gap-[16px]">
      <Card tone="cream">
        <h2 className="display-md mt-[8px] mb-[12px]">Bildschirm aufnehmen</h2>

        {/* Live: the picture being recorded, and how long and how big. */}
        <div className={recording ? 'flex flex-col gap-[16px]' : 'hidden'}>
          <video ref={previewRef} autoPlay muted playsInline className="max-h-[360px] w-full max-w-[640px] bg-stage object-contain" />
          {stage.kind === 'recording' ? (
            <p className="flex items-center gap-[10px] text-small text-prose" role="status">
              <span className={`h-[10px] w-[10px] rounded-pill bg-ink ${stage.paused ? 'opacity-40' : 'animate-pulse'}`} aria-hidden />
              {stage.paused ? 'Pausiert' : 'Aufnahme'}
              <span className="value text-ink">{formatTimecode(stage.seconds)}</span>
              <span className="value text-muted">· {formatBytes(stage.bytes)}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-[8px]">
            <Button onClick={() => recordingRef.current?.stop()}>Aufnahme beenden</Button>
            <Button variant="quiet" onClick={togglePause}>
              {stage.kind === 'recording' && stage.paused ? 'Weiter' : 'Pause'}
            </Button>
          </div>
        </div>

        {stage.kind === 'finishing' ? <Progress value={null} label="Datei wird fertiggestellt" /> : null}

        {!busy ? (
          <>
            {sources ? (
              <div className="flex flex-col gap-[16px]">
                {[
                  ['Bildschirme', screens],
                  ['Fenster', windows],
                ].map(([title, group]) =>
                  (group as CaptureSource[]).length ? (
                    <div key={title as string} className="flex flex-col gap-[8px]">
                      <p className="text-small font-semibold text-ink">{title as string}</p>
                      <div className="grid max-h-[420px] grid-cols-2 gap-[8px] overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
                        {(group as CaptureSource[]).map((source) => (
                          <button
                            key={source.id}
                            type="button"
                            aria-pressed={source.id === sourceId}
                            onClick={() => setSourceId(source.id)}
                            className={`press flex flex-col gap-[6px] rounded-card p-[8px] text-left ${
                              source.id === sourceId ? 'bg-panel-mid ring-2 ring-inset ring-ink' : 'bg-panel-soft hover:bg-panel-mid'
                            }`}
                          >
                            {source.thumbnail ? (
                              <img src={source.thumbnail} alt="" className="aspect-video w-full rounded-nav bg-stage object-contain" />
                            ) : (
                              <span className="aspect-video w-full rounded-nav bg-stage" />
                            )}
                            <span className="truncate text-small text-prose">{source.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null,
                )}
                {sources.length === 0 ? <p className="text-small text-muted">Windows meldet nichts, was sich aufnehmen liesse.</p> : null}
                <div>
                  <Button variant="ghost" size="sm" onClick={() => void list()} disabled={listing}>
                    {listing ? 'Wird gesucht …' : 'Liste neu laden'}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="max-w-[64ch] text-small leading-[1.55] text-prose">
                Nach dem Start fragt der Browser, was Sie teilen: einen ganzen Bildschirm, ein Fenster oder einen Tab.
              </p>
            )}

            <div className="mt-[20px] grid max-w-[720px] gap-[16px] sm:grid-cols-[1fr_1fr_200px]">
              <Toggle
                label="Ton des Rechners"
                hint={sources ? 'Alles, was der Rechner gerade abspielt.' : 'Im Browser-Dialog „Audio teilen“ anhaken.'}
                checked={settings.systemAudio}
                onChange={(value) => update({ systemAudio: value })}
              />
              <Toggle
                label="Mikrofon dazu"
                hint="Für Erklärungen und Anleitungen."
                checked={settings.microphone}
                onChange={(value) => update({ microphone: value })}
              />
              <Field label="Bilder pro Sekunde">
                <Select value={settings.frameRate} onChange={(event) => update({ frameRate: event.target.value === '60' ? 60 : 30 })}>
                  <option value={30}>30 · Standard</option>
                  <option value={60}>60 · flüssiger, grösser</option>
                </Select>
              </Field>
            </div>

            <div className="mt-[20px]">
              <Button onClick={() => void start()} disabled={Boolean(sources) && !sourceId}>
                Aufnahme starten
                <ArrowRight />
              </Button>
            </div>
            <p className="mt-[8px] max-w-[64ch] text-small leading-[1.55] text-muted">
              Die Aufnahme bleibt auf diesem Gerät und landet als Video in der Sitzung.
            </p>
          </>
        ) : null}
        {stage.kind === 'starting' ? <Progress value={null} label="Aufnahme wird vorbereitet" /> : null}
      </Card>

      {error ? (
        <Notice tone="warn" title="Hinweis">
          {error}
        </Notice>
      ) : null}

      {result && !busy ? (
        <Card tone="mint">
          <div className="flex flex-wrap items-baseline justify-between gap-[12px]">
            <p className="text-small font-semibold text-ink">Aufnahme</p>
            <span className="value text-small text-prose">
              {result.asset.name} · {formatBytes(result.asset.sizeBytes)}
            </span>
          </div>
          <video src={result.url} controls className="mt-[12px] max-h-[420px] w-full bg-stage object-contain" />
          {!result.fixed ? (
            <p className="mt-[8px] text-small text-prose">Ohne Zeitindex gespeichert: manche Player können darin nicht springen.</p>
          ) : null}
          <div className="mt-[16px] flex flex-wrap gap-[8px]">
            <Button
              onClick={() => {
                setActiveAsset(result.asset.id)
                setPanel('video')
              }}
            >
              Schneiden
              <ArrowRight />
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setActiveAsset(result.asset.id)
                setPanel('subtitles')
              }}
            >
              Untertitel dazu
            </Button>
            <Button variant="quiet" onClick={() => saveBytes(result.asset.bytes, result.asset.name, 'video/webm')}>
              Als WebM speichern
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  )
}
