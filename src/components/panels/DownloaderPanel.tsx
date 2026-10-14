/**
 * Getting something in from an address.
 *
 * This is the only screen in Sondra that talks to a server, and it says so
 * before it does anything — at the top, in the first sentence, not in a
 * footnote. Everything else in the app runs in the tab; this one step cannot,
 * because a browser is not permitted to fetch a video from a site that did not
 * invite it, and none of them invite it.
 *
 * The panel used to open on the configuration for that: which instance, which
 * key, which cookies, which of two services. All of it real and all of it
 * necessary for the hard cases — and all of it in front of somebody who only
 * wanted to paste a link. That panel is still here, complete, one click down
 * under "Mehr Wege". In front of it is the case that needs nothing at all:
 * paste, choose, download.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { IN_DESKTOP_APP } from '../../lib/desktop'
import { saveBytes } from '../../lib/download'
import { formatBytes, formatDuration } from '../../lib/format'
import { decodeWithBrowser } from '../../lib/audio'
import { SPEECH_MODELS, toSpeechSamples, transcribe, toSrt } from '../../lib/transcribe'
import { tagAudioFile } from '../../lib/tagger'
import {
  StudioError,
  downloadStream,
  filenameFor,
  resolveViaService,
  type StealthMode,
  type StudioResult,
  type StudioStream,
} from '../../lib/studio'
import { serviceConnection } from '../../lib/serviceState'
import { kindFromMime, useSession } from '../../state/store'
import { Button, Card, Notice, Progress, Reveal, TextInput } from '../ui/primitives'
import { loadFfmpeg, runFfmpeg } from '../../lib/ffmpegClient'
import { AdvancedDownloader } from './DownloaderAdvanced'

export type AudioOutputFormat = 'mp3' | 'wav' | 'm4a' | 'flac' | 'opus' | 'original'

const AUDIO_FORMAT_CONFIGS: { id: AudioOutputFormat; label: string; desc: string; ext: string; mime: string }[] = [
  { id: 'mp3', label: 'MP3', desc: '320 kbps (Standard)', ext: 'mp3', mime: 'audio/mpeg' },
  { id: 'wav', label: 'WAV', desc: 'Verlustfrei (PCM)', ext: 'wav', mime: 'audio/wav' },
  { id: 'm4a', label: 'M4A', desc: 'AAC 256k (Apple / Mobile)', ext: 'm4a', mime: 'audio/mp4' },
  { id: 'flac', label: 'FLAC', desc: 'Verlustfrei komprimiert', ext: 'flac', mime: 'audio/flac' },
  { id: 'opus', label: 'OPUS', desc: '160k (Kompakt & Klar)', ext: 'opus', mime: 'audio/ogg' },
  { id: 'original', label: 'Original', desc: 'Audiostream unverändert', ext: 'm4a', mime: 'audio/mp4' },
]

async function processDownloadedAudio(
  bytes: Uint8Array,
  inputExt: string,
  targetFormat: AudioOutputFormat,
  hasVideo: boolean,
  meta: { title?: string | null; artist?: string | null; coverUrl?: string | null },
  signal?: AbortSignal,
  onStatus?: (status: string) => void,
): Promise<{ bytes: Uint8Array; ext: string; mime: string }> {
  const cleanInExt = (inputExt || 'mp4').replace(/^\./, '').toLowerCase()

  if (!hasVideo && (targetFormat === 'original' || cleanInExt === targetFormat)) {
    const tagged = await tagAudioFile(bytes, cleanInExt, meta, signal)
    const mimeMap: Record<string, string> = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      flac: 'audio/flac',
      opus: 'audio/ogg',
      ogg: 'audio/ogg',
    }
    return { bytes: tagged, ext: cleanInExt, mime: mimeMap[cleanInExt] || 'audio/mp4' }
  }

  await loadFfmpeg()
  const inName = `dl_in_${Date.now()}.${cleanInExt}`
  const outExt = targetFormat === 'original' ? (cleanInExt === 'webm' ? 'opus' : 'm4a') : targetFormat
  const outName = `dl_out_${Date.now()}.${outExt}`

  const args: string[] = ['-i', inName, '-vn']
  if (targetFormat === 'mp3') {
    args.push('-b:a', '320k')
  } else if (targetFormat === 'm4a') {
    args.push('-c:a', 'aac', '-b:a', '256k')
  } else if (targetFormat === 'flac') {
    args.push('-c:a', 'flac')
  } else if (targetFormat === 'opus') {
    args.push('-c:a', 'libopus', '-b:a', '160k')
  } else if (targetFormat === 'wav') {
    // wav default PCM
  } else {
    args.push('-c:a', 'aac', '-b:a', '256k')
  }
  args.push(outName)

  onStatus?.(`Tonspur wird als ${outExt.toUpperCase()} extrahiert …`)
  const { files } = await runFfmpeg({
    input: { [inName]: bytes },
    output: [outName],
    args,
    signal,
  })

  let outBytes = files[outName]
  if (!outBytes || outBytes.byteLength === 0) {
    throw new Error(`Audio-Extraktion nach ${outExt.toUpperCase()} fehlgeschlagen.`)
  }

  outBytes = await tagAudioFile(outBytes, outExt, meta, signal)

  const mimeMap: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    opus: 'audio/ogg',
  }
  return { bytes: outBytes, ext: outExt, mime: mimeMap[outExt] || 'audio/mp4' }
}

/**
 * The one place where Sondra is not local, said loudly.
 *
 * The header used to carry this as a chip on every screen. That it is local
 * everywhere else goes without saying; the exception belongs where it happens,
 * big enough that nobody pastes an address without having read it.
 */
function NotLocalNotice() {
  return (
    <div role="note" className="rounded-card bg-panel-cool p-[20px] ring-2 ring-inset ring-ink sm:p-[24px]">
      <p className="flex items-start gap-[12px] text-ink">
        <svg viewBox="0 0 16 16" className="mt-[2px] h-6 w-6 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 1.6l6.2 10.8H1.8zM8 6.2v3.1M8 11.2h.01" />
        </svg>
        <span className="flex flex-col gap-[2px]">
          <span className="text-body font-bold leading-[1.3] sm:text-[1.25rem]">
            Achtung: Herunterladen läuft nicht lokal
          </span>
          <span className="text-small text-prose">
            Das ist das einzige Werkzeug, das Ihr Gerät verlässt. Alle anderen rechnen nur hier.
          </span>
        </span>
      </p>
      <ul className="mt-[12px] flex list-disc flex-col gap-[4px] pl-[52px] text-small leading-[1.5] text-prose">
        <li>
          Die Adresse, die Sie einfügen, geht an einen Dienst dieser Seite. Er schlägt dort nach und
          holt die Datei. Ihre eigenen Dateien sieht er nie.
        </li>
        <li>
          Die Datei läuft durch diesen Dienst zu Ihnen. Gespeichert wird sie dort nicht; alles
          Weitere — schneiden, umwandeln, trennen — passiert wieder hier im Tab.
        </li>
        <li>
          Das Ganze läuft über einen Proxy, und ich hafte dafür absolut nicht. Laden Sie nur
          herunter, was Sie herunterladen dürfen. Kopierschutz wird hier nicht umgangen.
        </li>
      </ul>
    </div>
  )
}

/**
 * The same place in the app, where the premise above is not true: the app
 * runs the service itself, on this machine, so nothing here goes through a
 * server of the site. Not `panel-cool`, which says "not local" and would be
 * wrong here — but the liability sentence stays, word for word.
 */
/** Whether the browser believes it has a network — offline the tools work, this one cannot. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

function AppNotice() {
  return (
    <div role="note" className="rounded-card bg-panel-soft p-[20px] sm:p-[24px]">
      <p className="text-body font-bold leading-[1.3] text-ink sm:text-[1.25rem]">Herunterladen läuft über diesen Rechner</p>
      <ul className="mt-[12px] flex list-disc flex-col gap-[4px] pl-[20px] text-small leading-[1.5] text-prose">
        <li>
          Sondra fragt die Seite selbst, mit yt-dlp auf diesem Rechner. Kein fremder Server ist
          dazwischen; die Seite, von der Sie laden, sieht diesen Rechner.
        </li>
        <li>Die Datei landet in der Sitzung; alles Weitere passiert hier.</li>
        <li>
          Ich hafte dafür absolut nicht. Laden Sie nur herunter, was Sie herunterladen dürfen.
          Kopierschutz wird hier nicht umgangen.
        </li>
      </ul>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface BatchItem {
  url: string
  titleHint?: string
  status: 'pending' | 'resolving' | 'ready' | 'downloading' | 'done' | 'error'
  result?: StudioResult
  selectedStreamId?: string
  error?: string
  progress?: { loaded: number; total: number | null } | null
  taken?: { name: string; bytes: Uint8Array; mime: string }
}

interface NetworkAdapter {
  id: string
  name: string
  address: string | null
}

interface DownloadHistoryItem {
  id: string
  url: string
  title: string
  author: string
  format: string
  bytes?: number
  timestamp: number
}

const HISTORY_KEY = 'sondra:download_history'

function loadDownloadHistory(): DownloadHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveDownloadHistory(items: DownloadHistoryItem[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 20)))
  } catch {
    /* ignore storage errors */
  }
}

export function DownloaderPanel() {
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)

  const [history, setHistory] = useState<DownloadHistoryItem[]>(loadDownloadHistory)

  const recordDownload = useCallback(
    (targetUrl: string, title: string, author: string, format: string, byteSize?: number) => {
      setHistory((prev) => {
        const filtered = prev.filter((item) => item.url !== targetUrl)
        const newItem: DownloadHistoryItem = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          url: targetUrl,
          title: title || 'Download',
          author: author || '',
          format,
          bytes: byteSize,
          timestamp: Date.now(),
        }
        const updated = [newItem, ...filtered].slice(0, 20)
        saveDownloadHistory(updated)
        return updated
      })
    },
    [],
  )

  const [url, setUrl] = useState('')
  const [stealthMode, setStealthMode] = useState<StealthMode>('off')
  const stealthModeRef = useRef<StealthMode>(stealthMode)
  stealthModeRef.current = stealthMode

  const [adapters, setAdapters] = useState<NetworkAdapter[]>([])
  const [selectedAdapter, setSelectedAdapter] = useState<string>('default')
  const [adapterLoading, setAdapterLoading] = useState(false)

  const fetchAdapters = async () => {
    if (!IN_DESKTOP_APP) return
    setAdapterLoading(true)
    try {
      const conn = serviceConnection()
      const candidates: string[] = []
      if (conn.endpoint) candidates.push(`${conn.endpoint.replace(/\/$/, '')}/adapters`)
      candidates.push('/api/adapters', 'http://127.0.0.1:9000/adapters', 'http://localhost:9000/adapters')

      for (const targetUrl of candidates) {
        try {
          const res = await fetch(targetUrl, { signal: AbortSignal.timeout(2000) })
          if (res.ok) {
            const data = (await res.json()) as { adapters?: NetworkAdapter[]; selected?: string }
            if (Array.isArray(data.adapters) && data.adapters.length > 0) {
              setAdapters(data.adapters)
              if (data.selected) setSelectedAdapter(data.selected)
              break
            }
          }
        } catch {
          // try next candidate
        }
      }
    } finally {
      setAdapterLoading(false)
    }
  }

  useEffect(() => {
    if (IN_DESKTOP_APP) {
      void fetchAdapters()
    }
  }, [])

  const changeAdapter = async (val: string) => {
    if (!IN_DESKTOP_APP) return
    setSelectedAdapter(val)
    const conn = serviceConnection()
    const candidates: string[] = []
    if (conn.endpoint) candidates.push(`${conn.endpoint.replace(/\/$/, '')}/adapters`)
    candidates.push('/api/adapters', 'http://127.0.0.1:9000/adapters', 'http://localhost:9000/adapters')

    let succeeded = false
    for (const targetUrl of candidates) {
      try {
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bindAddress: val === 'default' ? null : val }),
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          succeeded = true
          break
        }
      } catch {
        // try next candidate
      }
    }
    if (succeeded) {
      log(
        'netzwerk',
        val === 'default' ? 'Netzwerk: Automatisch (Windows-Standard)' : `Netzwerk gebunden an: ${val}`,
      )
    } else {
      log('netzwerk', 'Adapter konnte nicht umgestellt werden (Dienst nicht erreichbar)', 'error')
    }
  }

  const [looking, setLooking] = useState(false)
  const [result, setResult] = useState<StudioResult | null>(null)
  const [batchEntries, setBatchEntries] = useState<BatchItem[] | null>(null)
  const batchEntriesRef = useRef<BatchItem[] | null>(null)
  batchEntriesRef.current = batchEntries

  const [concurrency, setConcurrency] = useState<number>(3)
  const [batchBusy, setBatchBusy] = useState(false)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null)
  /** What the last „Laden“ put into the session, so it can still be saved. */
  const [taken, setTaken] = useState<{ name: string; bytes: Uint8Array; mime: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const batchAbortRef = useRef<AbortController | null>(null)
  const resolvingMapRef = useRef<Map<number, Promise<void>>>(new Map())
  const itemAbortControllers = useRef<Map<number, AbortController>>(new Map())
  const online = useOnline()

  useEffect(() => () => {
    abortRef.current?.abort()
    batchAbortRef.current?.abort()
    itemAbortControllers.current.forEach((c) => c.abort())
    itemAbortControllers.current.clear()
  }, [])

  const [autoTranscribe, setAutoTranscribe] = useState(false)
  const autoTranscribeRef = useRef(false)
  autoTranscribeRef.current = autoTranscribe

  const [filterAudioOnly, setFilterAudioOnly] = useState(false)
  const filterAudioOnlyRef = useRef(false)
  filterAudioOnlyRef.current = filterAudioOnly

  const [targetAudioFormat, setTargetAudioFormat] = useState<AudioOutputFormat>('mp3')
  const targetAudioFormatRef = useRef<AudioOutputFormat>('mp3')
  targetAudioFormatRef.current = targetAudioFormat

  const triggerAutoTranscribe = useCallback(
    async (assetName: string, assetBytes: Uint8Array) => {
      log('holen', `Starte automatische Untertitel-Generierung für ${assetName}…`)
      try {
        const copy = new Uint8Array(assetBytes.byteLength)
        copy.set(assetBytes)
        const audioData = await decodeWithBrowser(copy.buffer as ArrayBuffer)
        if (!audioData) return
        const samples = await toSpeechSamples(audioData)
        const segments = await transcribe(samples, {
          model: SPEECH_MODELS[0].id,
          language: 'auto',
        })
        if (segments && segments.length > 0) {
          const srtText = toSrt(segments)
          const stem = assetName.replace(/\.[^.]+$/, '')
          const srtBytes = new TextEncoder().encode(srtText)
          addAsset({
            name: `${stem}.srt`,
            bytes: srtBytes,
            mime: 'application/x-subrip',
            sizeBytes: srtBytes.byteLength,
            kind: 'unknown',
            audio: null,
            durationSeconds: null,
            origin: 'derived',
          })
          log('holen', `Untertitel generiert: ${stem}.srt in die Sitzung gelegt (${segments.length} Abschnitte)`)
        }
      } catch (err) {
        log(
          'holen',
          `Untertitel-Generierung übersprungen: ${err instanceof Error ? err.message : String(err)}`,
          'warn',
        )
      }
    },
    [addAsset, log],
  )

  const look = async (overrideUrl?: string) => {
    const targetSource = overrideUrl ?? url
    const targets = targetSource
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (targets.length === 0) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLooking(true)
    setError(null)
    setResult(null)
    setBatchEntries(null)
    setTaken(null)

    if (targets.length === 1) {
      try {
        const found = await resolveViaService(targets[0], controller.signal)
        if (found.isPlaylist) {
          log('holen', `Staffel / Playlist erkannt: ${found.title} (${found.items.length} Titel)`)
          const playlistItems: BatchItem[] = found.items.map((item) => ({
            url: item.url,
            titleHint: item.title,
            status: 'pending',
          }))
          setBatchEntries(playlistItems)

          // Alle Einträge im Hintergrund auflösen (mit maximal concurrency parallelen Workern)
          let cursor = 0
          const workerCount = Math.min(concurrency, playlistItems.length)
          const workers = Array.from({ length: workerCount }, async () => {
            while (cursor < playlistItems.length) {
              if (controller.signal.aborted) break
              const i = cursor++
              await resolveBatchItem(i, controller.signal, playlistItems)
            }
          })
          void Promise.all(workers)
          return
        }
        setResult(found)
        log('holen', `${found.title} — ${found.streams.length} Spur(en) verfügbar`)
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        const studio = cause instanceof StudioError ? cause : null
        setError({
          code: studio?.code ?? 'unknown',
          message: studio?.message ?? (cause instanceof Error ? cause.message : String(cause)),
        })
        log('holen', studio?.message ?? String(cause), 'error')
      } finally {
        setLooking(false)
      }
      return
    }

    // Mehrere Adressen: Batch-Modus
    const initial: BatchItem[] = targets.map((u) => ({
      url: u,
      status: 'pending',
    }))
    setBatchEntries(initial)
    setLooking(false)

    let cursor = 0
    const workerCount = Math.min(concurrency, targets.length)
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < targets.length) {
        if (controller.signal.aborted) break
        const i = cursor++
        await resolveBatchItem(i, controller.signal, initial)
      }
    })
    void Promise.all(workers)
  }

  const resolveBatchItem = async (
    index: number,
    signal?: AbortSignal,
    fallbackEntries?: BatchItem[],
  ): Promise<void> => {
    const inFlight = resolvingMapRef.current.get(index)
    if (inFlight) return inFlight

    const list = batchEntriesRef.current ?? fallbackEntries
    const entry = list?.[index]
    if (!entry || entry.status === 'ready' || entry.status === 'done') return

    const task = (async () => {
      setBatchEntries((prev) =>
        prev ? prev.map((e, idx) => (idx === index ? { ...e, status: 'resolving', error: undefined } : e)) : null,
      )

      try {
        const res = await resolveViaService(entry.url, signal)
        if (res.isPlaylist) return
        const audioStream = res.streams.find((s) => !s.hasVideo && s.hasAudio)
        const bestStream = filterAudioOnlyRef.current && audioStream
          ? audioStream
          : res.streams.find((s) => s.hasVideo && s.hasAudio) || res.streams[0]
        setBatchEntries((prev) =>
          prev
            ? prev.map((e, idx) =>
                idx === index
                  ? {
                      ...e,
                      status: 'ready',
                      result: res,
                      selectedStreamId: bestStream?.id ?? res.streams[0]?.id,
                    }
                  : e,
              )
            : null,
        )
        log('holen', `${res.title} — bereit`)
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        const msg = cause instanceof StudioError ? cause.message : cause instanceof Error ? cause.message : String(cause)
        setBatchEntries((prev) =>
          prev ? prev.map((e, idx) => (idx === index ? { ...e, status: 'error', error: msg } : e)) : null,
        )
      } finally {
        resolvingMapRef.current.delete(index)
      }
    })()

    resolvingMapRef.current.set(index, task)
    return task
  }

  const take = async (stream: StudioStream) => {
    if (!result) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(stream.label)
    setError(null)
    setTaken(null)
    setProgress({ loaded: 0, total: stream.bytes })
    try {
      const bytes = await downloadStream(stream, {
        signal: controller.signal,
        onProgress: setProgress,
      })
      let finalBytes = bytes
      let finalExt = stream.ext
      let finalMime = stream.mime
      let finalKind = kindFromMime(stream.mime, stream.label)

      if (filterAudioOnly) {
        setBusy(`Wandle in ${targetAudioFormat.toUpperCase()} um …`)
        const audioRes = await processDownloadedAudio(
          bytes,
          stream.ext,
          targetAudioFormat,
          stream.hasVideo,
          {
            title: result.title,
            artist: result.author,
            coverUrl: result.thumbnail,
          },
          controller.signal,
          (status) => setBusy(status),
        )
        finalBytes = audioRes.bytes
        finalExt = audioRes.ext
        finalMime = audioRes.mime
        finalKind = 'audio'
      } else if (!stream.hasVideo && stream.hasAudio) {
        finalBytes = await tagAudioFile(
          bytes,
          stream.ext,
          {
            title: result.title,
            artist: result.author,
            coverUrl: result.thumbnail,
          },
          controller.signal,
        )
      }

      let name = filenameFor(result, stream, { mode: stealthMode })
      if (filterAudioOnly) {
        name = name.replace(/\.[a-zA-Z0-9]+$/, '') + `.${finalExt}`
      }

      addAsset({
        name,
        bytes: finalBytes,
        mime: finalMime,
        sizeBytes: finalBytes.byteLength,
        kind: finalKind,
        audio: null,
        durationSeconds: result.durationSeconds,
        origin: 'download',
      })
      log('holen', `${name} geladen (${formatBytes(finalBytes.byteLength)})`)
      setTaken({ name, bytes: finalBytes, mime: finalMime })
      recordDownload(url, result.title, result.author ?? '', finalExt, finalBytes.byteLength)
      if (autoTranscribe) {
        void triggerAutoTranscribe(name, finalBytes)
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      const studio = cause instanceof StudioError ? cause : null
      setError({
        code: studio?.code ?? 'unknown',
        message: studio?.message ?? (cause instanceof Error ? cause.message : String(cause)),
      })
      log('holen', studio?.message ?? String(cause), 'error')
    } finally {
      setBusy(null)
      setProgress(null)
      abortRef.current = null
    }
  }

  const takeBatchItem = async (index: number, externalSignal?: AbortSignal) => {
    let entry = batchEntriesRef.current?.[index]
    if (!entry) return

    if (entry.status !== 'ready' || !entry.result) {
      await resolveBatchItem(index, externalSignal)
      entry = batchEntriesRef.current?.[index]
      if (!entry || !entry.result) return
    }

    const stream =
      entry.result.streams.find((s) => s.id === entry.selectedStreamId) ||
      entry.result.streams[0]
    if (!stream) return

    const controller = externalSignal ? null : new AbortController()
    if (controller) {
      itemAbortControllers.current.set(index, controller)
      abortRef.current = controller
    }
    const signal = externalSignal || controller!.signal

    setBatchEntries((prev) =>
      prev
        ? prev.map((e, idx) =>
            idx === index
              ? { ...e, status: 'downloading', progress: { loaded: 0, total: stream.bytes } }
              : e,
          )
        : null,
    )

    try {
      const bytes = await downloadStream(stream, {
        signal,
        onProgress: (p) => {
          setBatchEntries((prev) =>
            prev ? prev.map((e, idx) => (idx === index ? { ...e, progress: p } : e)) : null,
          )
        },
      })
      let finalBytes = bytes
      let finalExt = stream.ext
      let finalMime = stream.mime
      let finalKind = kindFromMime(stream.mime, stream.label)

      if (filterAudioOnlyRef.current) {
        setBatchEntries((prev) =>
          prev
            ? prev.map((e, idx) =>
                idx === index ? { ...e, status: 'downloading', progress: { loaded: stream.bytes ?? 0, total: stream.bytes } } : e,
              )
            : null,
        )
        const audioRes = await processDownloadedAudio(
          bytes,
          stream.ext,
          targetAudioFormatRef.current,
          stream.hasVideo,
          {
            title: entry.result.title,
            artist: entry.result.author,
            coverUrl: entry.result.thumbnail,
          },
          signal,
        )
        finalBytes = audioRes.bytes
        finalExt = audioRes.ext
        finalMime = audioRes.mime
        finalKind = 'audio'
      } else if (!stream.hasVideo && stream.hasAudio) {
        finalBytes = await tagAudioFile(
          bytes,
          stream.ext,
          {
            title: entry.result.title,
            artist: entry.result.author,
            coverUrl: entry.result.thumbnail,
          },
          signal,
        )
      }

      let name = filenameFor(entry.result, stream, { mode: stealthModeRef.current })
      if (filterAudioOnlyRef.current) {
        name = name.replace(/\.[a-zA-Z0-9]+$/, '') + `.${finalExt}`
      }

      addAsset({
        name,
        bytes: finalBytes,
        mime: finalMime,
        sizeBytes: finalBytes.byteLength,
        kind: finalKind,
        audio: null,
        durationSeconds: entry.result.durationSeconds,
        origin: 'download',
      })
      log('holen', `${name} geladen (${formatBytes(finalBytes.byteLength)})`)
      if (autoTranscribeRef.current) {
        void triggerAutoTranscribe(name, finalBytes)
      }
      setBatchEntries((prev) =>
        prev
          ? prev.map((e, idx) =>
              idx === index
                ? {
                    ...e,
                    status: 'done',
                    progress: null,
                    taken: { name, bytes: finalBytes, mime: finalMime },
                  }
                : e,
            )
          : null,
      )
      recordDownload(entry.url, entry.result.title, entry.result.author ?? '', finalExt, finalBytes.byteLength)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      const msg =
        cause instanceof StudioError
          ? cause.message
          : cause instanceof Error
          ? cause.message
          : String(cause)
      setBatchEntries((prev) =>
        prev
          ? prev.map((e, idx) =>
              idx === index ? { ...e, status: 'error', error: msg, progress: null } : e,
            )
          : null,
      )
      log('holen', `Fehler beim Laden von ${entry.result?.title ?? entry.url}: ${msg}`, 'error')
    } finally {
      if (controller) {
        itemAbortControllers.current.delete(index)
      }
    }
  }

  const downloadAllBatch = async () => {
    if (!batchEntriesRef.current) return
    const controller = new AbortController()
    batchAbortRef.current = controller
    setBatchBusy(true)
    try {
      const indicesToProcess = batchEntriesRef.current
        .map((entry, idx) => ({ entry, idx }))
        .filter(({ entry }) => entry.status !== 'done' && entry.status !== 'downloading')
        .map(({ idx }) => idx)

      let cursor = 0
      const maxParallel = Math.max(1, Math.min(5, concurrency))
      const activeWorkers = Math.min(maxParallel, indicesToProcess.length)
      const workers = Array.from({ length: activeWorkers }, async () => {
        while (cursor < indicesToProcess.length) {
          if (controller.signal.aborted) break
          const targetIndex = indicesToProcess[cursor++]
          await takeBatchItem(targetIndex, controller.signal)
        }
      })
      await Promise.all(workers)
    } finally {
      setBatchBusy(false)
      batchAbortRef.current = null
    }
  }

  return (
    <div className="flex flex-col gap-[16px]">
      <Card tone="cream">
        <h2 className="display-md mt-[8px] mb-[12px]">Ein Video oder Lied von einer Adresse</h2>

        {IN_DESKTOP_APP ? <AppNotice /> : <NotLocalNotice />}

        {!online ? (
          <div className="mt-[16px]">
            <Notice tone="warn" title="Keine Internetverbindung">
              Herunterladen braucht das Netz. Alle anderen Werkzeuge rechnen auf diesem Gerät und gehen weiter.
            </Notice>
          </div>
        ) : null}

        <form
          className="mt-[16px] flex flex-col gap-[8px]"
          onSubmit={(event) => {
            event.preventDefault()
            void look()
          }}
        >
          <div className="flex flex-col gap-[8px] sm:flex-row">
            <TextInput
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                setError(null)
                setResult(null)
                setBatchEntries(null)
                setProgress(null)
              }}
              placeholder="https://... YouTube, AniWorld, Podcast-RSS-Feed oder direkte Mediendatei"
              inputMode="url"
              aria-label="Adresse zum Herunterladen"
              className="flex-1"
            />
            <Button type="submit" disabled={looking || url.trim().length === 0}>
              {looking ? 'Wird gesucht …' : 'Nachsehen'}
            </Button>
          </div>

          {/* Download-Optionen & Format-Wahl */}
          <div className="mt-[12px] flex flex-col gap-[12px] rounded-card bg-panel-soft p-[14px]">
            <div className="flex flex-wrap items-center justify-between gap-[8px]">
              <span className="text-small font-semibold text-ink">Download-Modus:</span>
              <div role="radiogroup" aria-label="Download-Modus" className="inline-flex rounded-nav bg-canvas p-[3px] ring-1 ring-line">
                <button
                  type="button"
                  onClick={() => setFilterAudioOnly(false)}
                  className={`rounded-nav px-[14px] py-[4px] text-small font-medium transition-colors ${
                    !filterAudioOnly ? 'bg-ink text-on-ink shadow-sm' : 'text-muted hover:text-ink'
                  }`}
                >
                  Video & Audio
                </button>
                <button
                  type="button"
                  onClick={() => setFilterAudioOnly(true)}
                  className={`rounded-nav px-[14px] py-[4px] text-small font-medium transition-colors ${
                    filterAudioOnly ? 'bg-ink text-on-ink shadow-sm' : 'text-muted hover:text-ink'
                  }`}
                >
                  Nur Tonspur (Audio)
                </button>
              </div>
            </div>

            {filterAudioOnly ? (
              <div className="flex flex-col gap-[8px] border-t border-line/60 pt-[10px]">
                <div className="flex flex-wrap items-center gap-[8px]">
                  <span className="text-small font-medium text-ink">Audioformat:</span>
                  <div className="flex flex-wrap gap-[6px]">
                    {AUDIO_FORMAT_CONFIGS.map((fmt) => (
                      <button
                        key={fmt.id}
                        type="button"
                        onClick={() => setTargetAudioFormat(fmt.id)}
                        className={`rounded-nav px-[10px] py-[3px] text-small transition-all ${
                          targetAudioFormat === fmt.id
                            ? 'bg-ink text-on-ink font-semibold shadow-sm'
                            : 'bg-canvas text-ink ring-1 ring-line hover:bg-panel-mid'
                        }`}
                        title={fmt.desc}
                      >
                        {fmt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-micro text-muted">
                  {AUDIO_FORMAT_CONFIGS.find((f) => f.id === targetAudioFormat)?.desc} — Tonspur wird extrahiert und als {targetAudioFormat.toUpperCase()} abgespeichert.
                </p>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[8px] border-t border-line/60 pt-[10px]">
              <label className="flex cursor-pointer items-center gap-[8px] text-small font-medium text-ink">
                <input
                  type="checkbox"
                  checked={autoTranscribe}
                  onChange={(e) => setAutoTranscribe(e.target.checked)}
                  className="rounded border-line text-ink focus:ring-ink"
                />
                Automatisch Untertitel generieren (.srt)
              </label>

              <div className="flex items-center gap-[8px]">
                <label htmlFor="stealth-mode-select" className="text-small font-medium text-ink">
                  Dateiname:
                </label>
                <select
                  id="stealth-mode-select"
                  value={stealthMode}
                  onChange={(e) => setStealthMode(e.target.value as StealthMode)}
                  className="rounded-nav border border-line bg-canvas px-[8px] py-[3px] text-small text-ink focus:border-ink focus:outline-none"
                >
                  <option value="off">Originaltitel</option>
                  <option value="standard">Standard (media_xxx)</option>
                  <option value="full_security">Verschleiert (Hash)</option>
                  <option value="teams_office">Office Dokument</option>
                </select>
              </div>
            </div>

            {stealthMode !== 'off' ? (
              <p className="text-micro text-muted">
                {stealthMode === 'standard' && 'Muster: media_7a8b9c.mp4 — neutraler Standardname'}
                {stealthMode === 'full_security' && 'Muster: 7a8b9c0d1e2f.mp4 — minimaler Code ohne Wörter oder Zeitbezug'}
                {stealthMode === 'teams_office' && 'Muster: Teams_Meeting_Aufzeichnung_2026-10-12_A8F2.mp4 — wirkt wie ein regulärer Office-Download'}
              </p>
            ) : null}

            {IN_DESKTOP_APP ? (
              <div className="flex flex-wrap items-center gap-[10px] border-t border-line/60 pt-[8px]">
                <label htmlFor="adapter-select" className="text-small font-medium text-ink">
                  Verbindung / Route:
                </label>
                <select
                  id="adapter-select"
                  value={selectedAdapter}
                  disabled={adapterLoading || adapters.length === 0}
                  onChange={(e) => void changeAdapter(e.target.value)}
                  className="rounded-nav border border-line bg-canvas px-[8px] py-[3px] text-small text-ink focus:border-ink focus:outline-none"
                >
                  {adapters.length === 0 ? (
                    <option value="default">Automatisch (Windows-Standard)</option>
                  ) : (
                    adapters.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => void fetchAdapters()}
                  disabled={adapterLoading}
                  title="Adapterliste aktualisieren"
                  className="cursor-pointer text-small text-muted underline hover:text-ink disabled:opacity-50"
                >
                  {adapterLoading ? 'Sucht…' : 'Neu suchen'}
                </button>
              </div>
            ) : null}
          </div>
        </form>

        {/* Seven lines under the field on every visit, for a question most
            people only have once something did not work. The warning above
            stays in full — that one is binding — and the result names the
            path that answered, so the explanation can wait a click. */}
        <Reveal label="Welche Wege probiert werden" className="mt-[12px]">
          {IN_DESKTOP_APP ? (
            <p className="mb-[8px] text-small leading-[1.5] text-muted">
              In der App fragt Sondra zuerst ihren eigenen Dienst: yt-dlp auf diesem Rechner, in voller
              Auflösung und für die Portale, die yt-dlp kennt. Beim ersten Mal fragt sie, ob yt-dlp
              geladen werden soll. Geht das nicht, bleiben die Wege unten.
            </p>
          ) : null}
          <p className="text-small leading-[1.5] text-muted">
            Der Dienst versucht drei Wege in dieser Reihenfolge: einen Anbieter, falls für diese
            Installation einer hinterlegt ist; sonst YouTube direkt, was einem Server nur die Fassung
            mit Bild und Ton in einem gibt, in der Regel 360p; sonst jede Adresse, die schon auf eine
            Datei zeigt. Welcher Weg geantwortet hat, steht beim Ergebnis. Für volle Auflösung ohne
            Anbieter führt der Weg über das eigene Gerät; das steht weiter unten.
          </p>
        </Reveal>
      </Card>

      {error ? (
        <Notice tone="error" title="Hat nicht geklappt">
          <p>{error.message}</p>
          {!IN_DESKTOP_APP && (error.code === 'youtube.sabr' || error.code === 'no-extractor' || error.code === 'youtube.signin') ? (
            <p className="mt-[8px]">
              Unter <span className="text-ink">Mehr Wege</span> steht, wie Sie yt-dlp auf Ihrem
              Rechner starten. Das ist eine Datei und ein Doppelklick, und danach geht alles: volle
              Auflösung, ohne diesen Dienst.
            </p>
          ) : null}
        </Notice>
      ) : null}

      {result ? (
        <Card tone="keylime" className="rise">
          <div className="flex flex-col gap-[16px] sm:flex-row">
            {result.thumbnail ? (
              <img
                src={result.thumbnail}
                alt=""
                className="h-[86px] w-[152px] shrink-0 rounded-nav object-cover ring-1 ring-line"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-subheading text-ink">
                {stealthMode !== 'off'
                  ? `[Verschleiert: ${filenameFor(result, result.streams[0], { mode: stealthMode })}]`
                  : result.title}
              </p>
              {stealthMode === 'off' ? (
                <p className="value mt-[2px] text-small text-muted">
                  {[result.author, result.durationSeconds ? formatDuration(result.durationSeconds) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : (
                <p className="mt-[2px] text-small text-muted">
                  Anonymisierter Dateiname: {filenameFor(result, result.streams[0], { mode: stealthMode })}
                </p>
              )}
              {/* Which route answered. Not a detail: it decides the resolution
                  on offer, and it decides who saw the address. */}
              <p className="mt-[8px] text-small text-muted">
                {result.source === 'service'
                  ? serviceConnection().info?.version.includes('in Sondra')
                    ? 'Über yt-dlp auf diesem Rechner'
                    : 'Über den Dienst, den Sie verbunden haben'
                  : result.source === 'provider'
                    ? 'Über den hinterlegten Anbieter'
                    : result.source === 'youtube'
                    ? 'YouTube direkt · nur die Fassung mit Bild und Ton in einem'
                    : result.source === 'aniworld'
                    ? 'AniWorld / SerienStream direkt'
                    : 'Direkte Datei-Adresse'}
              </p>
            </div>
          </div>

          <div className="mt-[16px] flex flex-col gap-[8px]">
            {filterAudioOnly ? (
              <p className="text-small text-muted">
                Audiospur wird als <span className="font-semibold text-ink">{targetAudioFormat.toUpperCase()}</span> extrahiert:
              </p>
            ) : null}
            {(filterAudioOnly && result.streams.some((s) => !s.hasVideo && s.hasAudio)
              ? result.streams.filter((s) => !s.hasVideo && s.hasAudio)
              : result.streams
            ).map((stream) => (
              <div
                key={stream.id}
                className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] border-t border-line px-[4px] py-[12px]"
              >
                <span className="min-w-0 flex-1 text-small text-ink">{stream.label}</span>
                <span className="value text-small text-muted">
                  {filterAudioOnly ? targetAudioFormat.toUpperCase() : stream.ext.toUpperCase()}
                  {stream.bytes ? ` · ${formatBytes(stream.bytes)}` : ''}
                </span>
                <Button size="sm" disabled={busy !== null} onClick={() => void take(stream)}>
                  {busy === stream.label
                    ? 'Lädt …'
                    : filterAudioOnly
                    ? `${targetAudioFormat.toUpperCase()} laden`
                    : 'Laden'}
                </Button>
              </div>
            ))}
          </div>

          {taken && !busy ? (
            <div className="rise mt-[16px] flex flex-wrap items-center gap-[12px] border-t border-line pt-[12px]" role="status">
              <span aria-hidden className="h-[8px] w-[8px] shrink-0 rounded-pill bg-ink" />
              <p className="min-w-0 flex-1 text-small text-ink">
                <span className="value">{taken.name}</span> ist in der Sitzung —{' '}
                <span className="text-muted">oben im Dateimenü, bereit für jedes Werkzeug.</span>
              </p>
              <Button size="sm" variant="quiet" onClick={() => saveBytes(taken.bytes, taken.name, taken.mime)}>
                Auch speichern
              </Button>
            </div>
          ) : null}

          {busy ? (
            <div className="mt-[16px] flex flex-col gap-[8px]">
              <Progress
                value={progress?.total ? progress.loaded / progress.total : null}
                label={
                  progress
                    ? `${formatBytes(progress.loaded)}${progress.total ? ` von ${formatBytes(progress.total)}` : ''}`
                    : 'läuft'
                }
              />
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="press self-start rounded-nav text-small text-ink underline underline-offset-2"
              >
                Abbrechen
              </button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {batchEntries ? (
        <Card tone="keylime" className="rise">
          <div className="flex flex-wrap items-center justify-between gap-[12px] border-b border-line pb-[12px]">
            <div>
              <h3 className="text-subheading text-ink">Mehrfach-Download ({batchEntries.length} Einträge)</h3>
              <p className="mt-[2px] text-small text-muted">
                {batchEntries.filter((e) => e.status === 'done').length} von {batchEntries.length} geladen
                {batchEntries.filter((e) => e.status === 'error').length > 0
                  ? ` · ${batchEntries.filter((e) => e.status === 'error').length} fehlgeschlagen`
                  : ''}
                {batchBusy
                  ? ` · ${batchEntries.filter((e) => e.status === 'downloading' || e.status === 'resolving').length} aktiv, ${
                      batchEntries.filter((e) => e.status === 'pending' || e.status === 'ready').length
                    } wartend`
                  : ''}
                {stealthMode !== 'off'
                  ? ` · Verschleierung aktiv (${
                      stealthMode === 'standard'
                        ? 'Standard'
                        : stealthMode === 'full_security'
                        ? 'Maximale Sicherheit'
                        : 'Teams / Office'
                    })`
                  : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-[8px]">
              <div className="flex items-center gap-[6px] text-small text-muted">
                <label htmlFor="concurrency-select" className="text-small text-muted">Gleichzeitig:</label>
                <select
                  id="concurrency-select"
                  value={concurrency}
                  disabled={batchBusy}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  className="rounded-nav border border-line bg-canvas px-[8px] py-[4px] text-small font-medium text-ink focus:border-ink focus:outline-none"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} gleichzeitig{n === 3 ? ' (Standard)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              {batchBusy ? (
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    batchAbortRef.current?.abort()
                    abortRef.current?.abort()
                    itemAbortControllers.current.forEach((c) => c.abort())
                    itemAbortControllers.current.clear()
                    setBatchBusy(false)
                  }}
                >
                  Abbrechen
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={
                  batchBusy ||
                  !batchEntries.some((e) => e.status !== 'done' && e.status !== 'downloading')
                }
                onClick={() => void downloadAllBatch()}
              >
                {batchBusy ? 'Laden läuft …' : 'Alle herunterladen'}
              </Button>
            </div>
          </div>

          <div className="mt-[16px] flex flex-col gap-[12px]">
            {batchEntries.map((entry, index) => {
              const stream =
                entry.result?.streams.find((s) => s.id === entry.selectedStreamId) ||
                entry.result?.streams[0]

              return (
                <div
                  key={`${index}-${entry.url}`}
                  className="flex flex-col gap-[8px] rounded-nav border border-line bg-panel-soft p-[12px]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-[8px]">
                    <div className="min-w-0 flex-1">
                      {entry.result ? (
                        <p className="truncate text-body font-medium text-ink">
                          {stealthMode !== 'off'
                            ? filenameFor(entry.result, stream || entry.result.streams[0], { mode: stealthMode })
                            : entry.result.title}
                        </p>
                      ) : (
                        <p className="truncate text-body font-medium text-ink">
                          {entry.titleHint || entry.url}
                        </p>
                      )}
                      {entry.result && stealthMode === 'off' ? (
                        <p className="value text-small text-muted">
                          {[entry.result.author, entry.result.durationSeconds ? formatDuration(entry.result.durationSeconds) : null]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-[8px]">
                      {entry.status === 'pending' ? (
                        <>
                          <span className="value text-small text-muted">Bereit</span>
                          <Button
                            size="sm"
                            disabled={batchBusy}
                            onClick={() => void takeBatchItem(index)}
                          >
                            Laden
                          </Button>
                        </>
                      ) : null}

                      {entry.status === 'resolving' ? (
                        <>
                          <span className="value text-small text-muted">Wird gesucht …</span>
                          <Button size="sm" variant="quiet" disabled>
                            Laden
                          </Button>
                        </>
                      ) : null}

                      {entry.status === 'ready' && entry.result ? (
                        <>
                          {entry.result.streams.length > 1 ? (
                            <select
                              value={entry.selectedStreamId}
                              disabled={batchBusy}
                              onChange={(e) => {
                                const val = e.target.value
                                setBatchEntries((prev) =>
                                  prev
                                    ? prev.map((item, idx) =>
                                        idx === index ? { ...item, selectedStreamId: val } : item
                                      )
                                    : null
                                )
                              }}
                              className="rounded-nav border border-line bg-canvas px-[8px] py-[4px] text-small text-ink focus:border-ink focus:outline-none"
                            >
                              {entry.result.streams.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.label} ({s.ext.toUpperCase()}{s.bytes ? ` · ${formatBytes(s.bytes)}` : ''})
                                </option>
                              ))}
                            </select>
                          ) : stream ? (
                            <span className="value text-small text-muted">
                              {stream.ext.toUpperCase()}
                              {stream.bytes ? ` · ${formatBytes(stream.bytes)}` : ''}
                            </span>
                          ) : null}

                          <Button
                            size="sm"
                            disabled={batchBusy}
                            onClick={() => void takeBatchItem(index)}
                          >
                            Laden
                          </Button>
                        </>
                      ) : null}

                      {entry.status === 'downloading' ? (
                        <span className="value text-small text-muted">Wird geladen …</span>
                      ) : null}

                      {entry.status === 'done' && entry.taken ? (
                        <div className="flex items-center gap-[8px]">
                          <span className="value text-small font-medium text-ink">In der Sitzung</span>
                          <Button
                            size="sm"
                            variant="quiet"
                            onClick={() => saveBytes(entry.taken!.bytes, entry.taken!.name, entry.taken!.mime)}
                          >
                            Speichern
                          </Button>
                        </div>
                      ) : null}

                      {entry.status === 'error' ? (
                        <Button
                          size="sm"
                          variant="quiet"
                          disabled={batchBusy}
                          onClick={() => void takeBatchItem(index)}
                        >
                          Erneut versuchen
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {entry.status === 'error' ? (
                    <p className="text-small text-prose font-medium text-ink">{entry.error}</p>
                  ) : null}

                  {entry.status === 'downloading' && entry.progress ? (
                    <Progress
                      value={entry.progress.total ? entry.progress.loaded / entry.progress.total : null}
                      label={`${formatBytes(entry.progress.loaded)}${
                        entry.progress.total ? ` von ${formatBytes(entry.progress.total)}` : ''
                      }`}
                    />
                  ) : null}
                </div>
              )
            })}
          </div>
        </Card>
      ) : null}

      {/* Download-Verlauf (Historie) */}
      {history.length > 0 ? (
        <Card tone="keylime">
          <div className="flex flex-wrap items-center justify-between gap-[8px] border-b border-line pb-[10px]">
            <div>
              <h3 className="text-small font-semibold text-ink">Download-Verlauf (Zuletzt abgerufen)</h3>
              <p className="text-small text-muted">Die letzten {history.length} Einträge auf diesem Gerät gemerkt.</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setHistory([])
                try {
                  localStorage.removeItem('sondra:download_history')
                } catch {
                  /* ignore */
                }
              }}
            >
              Verlauf leeren
            </Button>
          </div>
          <div className="mt-[12px] flex flex-col divide-y divide-line/60">
            {history.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-[8px] py-[8px]">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-small font-semibold text-ink" title={item.title}>
                    {item.title}
                  </p>
                  <p className="value text-micro text-muted">
                    {[
                      item.author,
                      item.format.toUpperCase(),
                      item.bytes ? formatBytes(item.bytes) : null,
                      new Date(item.timestamp).toLocaleDateString(undefined, {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-[6px]">
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      setUrl(item.url)
                      void look(item.url)
                    }}
                    title="URL erneut abrufen"
                  >
                    Erneut abrufen
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(item.url)
                    }}
                    title="URL in Zwischenablage kopieren"
                  >
                    Kopieren
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* The complete panel — instances, keys, cookies, playlists, full
          resolution — exactly as it was, just no longer the front door. */}
      <Reveal label="Optionen: eigener Dienst, Stream-Wege, yt-dlp auf dem eigenen Gerät">
        <AdvancedDownloader url={url} />
      </Reveal>
    </div>
  )
}
