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
import { opusArgs } from '../../lib/convert'
import { isPortalUrl, saveBytes } from '../../lib/download'
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
import { ArrowRight, Button, Card, Notice, Progress, Reveal, Select, TextInput, Toggle } from '../ui/primitives'
import { ChoiceRow } from '../editor/EditorShell'
import { loadFfmpeg, runFfmpeg } from '../../lib/ffmpegClient'
import { AdvancedDownloader } from './DownloaderAdvanced'

export type AudioOutputFormat = 'mp3' | 'wav' | 'm4a' | 'flac' | 'opus'

const AUDIO_FORMAT_CONFIGS: { id: AudioOutputFormat; label: string; desc: string; ext: string; mime: string }[] = [
  { id: 'mp3', label: 'MP3', desc: '320 kbps (Standard)', ext: 'mp3', mime: 'audio/mpeg' },
  { id: 'wav', label: 'WAV', desc: 'Verlustfrei (PCM)', ext: 'wav', mime: 'audio/wav' },
  { id: 'm4a', label: 'M4A', desc: 'AAC 256k (Apple / Mobile)', ext: 'm4a', mime: 'audio/mp4' },
  { id: 'flac', label: 'FLAC', desc: 'Verlustfrei komprimiert', ext: 'flac', mime: 'audio/flac' },
  { id: 'opus', label: 'OPUS', desc: '160k (Kompakt & Klar)', ext: 'opus', mime: 'audio/ogg' },
]

interface StreamGroup {
  id: string
  title: string
  badge?: string
  isAudio: boolean
  streams: StudioStream[]
}

function groupStreams(streams: StudioStream[]): StreamGroup[] {
  const groups = new Map<string, StreamGroup>()

  for (const s of streams) {
    const isAudioOnly = !s.hasVideo && s.hasAudio
    if (isAudioOnly) {
      if (!groups.has('audio')) {
        groups.set('audio', {
          id: 'audio',
          title: 'Nur Ton',
          badge: 'Audio',
          isAudio: true,
          streams: [],
        })
      }
      groups.get('audio')!.streams.push(s)
      continue
    }

    // Video streams
    const resMatch = s.label.match(/(2160p|1440p|1080p|720p|480p|360p|240p|144p)/i)
    const resKey = resMatch ? resMatch[1].toLowerCase() : s.height ? `${s.height}p` : 'video'
    let title = resKey.toUpperCase()
    let badge: string | undefined = undefined

    if (resKey === '2160p') {
      title = '2160p (4K UHD)'
      badge = '4K'
    } else if (resKey === '1440p') {
      title = '1440p (2K QHD)'
      badge = '2K'
    } else if (resKey === '1080p') {
      title = '1080p (Full HD)'
      badge = 'Full HD'
    } else if (resKey === '720p') {
      title = '720p (HD)'
      badge = 'HD'
    } else if (resKey === '480p') {
      title = '480p (Standard)'
      badge = 'SD'
    } else if (resKey === '360p') {
      title = '360p (Kompakt)'
    } else if (resKey === '240p') {
      title = '240p (Niedrig)'
    } else if (resKey === '144p') {
      title = '144p (Minimal)'
    } else if (resKey === 'video') {
      title = s.label || 'Video'
    }

    if (!groups.has(resKey)) {
      groups.set(resKey, {
        id: resKey,
        title,
        badge,
        isAudio: false,
        streams: [],
      })
    }
    groups.get(resKey)!.streams.push(s)
  }

  // Sort streams inside each group: highest size/bitrate first
  for (const group of groups.values()) {
    group.streams.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  }

  // Order groups descending by resolution, audio last
  const resOrder = ['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p', 'video', 'audio']
  return Array.from(groups.values()).sort((a, b) => {
    const idxA = resOrder.indexOf(a.id)
    const idxB = resOrder.indexOf(b.id)
    return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB)
  })
}

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

  if (!hasVideo && cleanInExt === targetFormat) {
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
  const outExt = targetFormat
  const outName = `dl_out_${Date.now()}.${outExt}`

  const args: string[] = ['-i', inName, '-vn']
  if (targetFormat === 'mp3') {
    args.push('-b:a', '320k')
  } else if (targetFormat === 'm4a') {
    args.push('-c:a', 'aac', '-b:a', '256k')
  } else if (targetFormat === 'flac') {
    args.push('-c:a', 'flac')
  } else if (targetFormat === 'opus') {
    args.push(...opusArgs('160k'))
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

/** One way in, as a tile: what it is, when it applies, and the one action. */
function WayTile({
  title,
  hint,
  action,
  onClick,
  pressed,
}: {
  title: string
  hint: string
  action: string
  onClick: () => void
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`press group flex flex-col items-start gap-[6px] rounded-card p-[16px] text-left transition-colors duration-[var(--dur-fast)] ${
        pressed ? 'bg-panel-strong' : 'bg-panel-mid hover:bg-panel-strong'
      }`}
    >
      <span className="text-body font-semibold text-ink">{title}</span>
      <span className="text-small leading-[1.5] text-prose">{hint}</span>
      <span className="mt-auto inline-flex items-center gap-[6px] pt-[6px] text-small font-semibold text-ink">
        {action}
        <ArrowRight className="transition-transform duration-[var(--dur-fast)] group-hover:translate-x-[2px]" />
      </span>
    </button>
  )
}

/** Opens the setup dialog, which lives in the advanced downloader. */
const openSetup = () => window.dispatchEvent(new CustomEvent('sondra:open-setup-dialog'))

export function DownloaderPanel() {
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)
  const [waysOpen, setWaysOpen] = useState(false)

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

          {isPortalUrl(url) && !IN_DESKTOP_APP ? (
            <p className="text-small leading-[1.5] text-prose">
              YouTube lässt sich aus dem Browser allein oft nicht oder nur in kleiner Auflösung laden; voll geht es mit der App
              oder einer Brücke auf diesem Rechner.{' '}
              <button
                type="button"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('sondra:open-setup-dialog'))
                }}
                className="press rounded-nav text-ink underline underline-offset-2"
              >
                So richten Sie es ein
              </button>
            </p>
          ) : null}

          {/* What to fetch and how to name it, asked the way every form on
              the page asks: a line, the question, the choices. It was a
              tinted box with colon labels and the browser's own checkbox
              and list — the one corner of the page in another hand. */}
          <div className="mt-[8px] grid gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
            <div className="flex flex-col gap-[8px] border-t border-line pt-[10px]">
              <span className="text-small text-prose">Was laden</span>
              <ChoiceRow
                value={filterAudioOnly ? 'audio' : 'video'}
                options={[
                  { value: 'video', label: 'Video mit Ton' },
                  { value: 'audio', label: 'Nur Ton' },
                ]}
                onChange={(value) => setFilterAudioOnly(value === 'audio')}
              />
              {filterAudioOnly ? (
                <>
                  <ChoiceRow
                    value={targetAudioFormat}
                    options={AUDIO_FORMAT_CONFIGS.map((format) => ({ value: format.id, label: format.label, title: format.desc }))}
                    onChange={setTargetAudioFormat}
                  />
                  <span className="text-small leading-[1.45] text-muted">
                    {AUDIO_FORMAT_CONFIGS.find((format) => format.id === targetAudioFormat)?.desc}. Die Tonspur wird herausgelöst und
                    so gespeichert.
                  </span>
                </>
              ) : null}
            </div>

            <div className="flex flex-col gap-[8px] border-t border-line pt-[10px]">
              <label htmlFor="stealth-mode-select" className="text-small text-prose">
                Dateiname
              </label>
              <Select id="stealth-mode-select" value={stealthMode} onChange={(e) => setStealthMode(e.target.value as StealthMode)}>
                <option value="off">Originaltitel</option>
                <option value="standard">Neutral (media_…)</option>
                <option value="full_security">Nur Zeichen (Hash)</option>
                <option value="teams_office">Wie eine Office-Datei</option>
              </Select>
              {stealthMode !== 'off' ? (
                <span className="text-small leading-[1.45] text-muted">
                  Zum Beispiel{' '}
                  <span className="value">
                    {stealthMode === 'standard'
                      ? 'media_7a8b9c.mp4'
                      : stealthMode === 'full_security'
                        ? '7a8b9c0d1e2f.mp4'
                        : 'Teams_Meeting_Aufzeichnung_2026-10-12_A8F2.mp4'}
                  </span>
                </span>
              ) : null}
            </div>

            <div className="border-t border-line pt-[10px] sm:col-span-2">
              <Toggle
                label="Untertitel dazu erstellen"
                hint="Nach dem Laden schreibt Whisper auf diesem Gerät mit, als .srt neben der Datei."
                checked={autoTranscribe}
                onChange={setAutoTranscribe}
              />
            </div>

            {IN_DESKTOP_APP ? (
              <div className="flex flex-col gap-[8px] border-t border-line pt-[10px] sm:col-span-2">
                <label htmlFor="adapter-select" className="text-small text-prose">
                  Netzwerk
                </label>
                <div className="flex flex-wrap items-center gap-[12px]">
                  <Select
                    id="adapter-select"
                    value={selectedAdapter}
                    disabled={adapterLoading || adapters.length === 0}
                    onChange={(e) => void changeAdapter(e.target.value)}
                    className="w-auto! min-w-[260px]"
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
                  </Select>
                  <button
                    type="button"
                    onClick={() => void fetchAdapters()}
                    disabled={adapterLoading}
                    className="press rounded-nav text-small text-ink underline underline-offset-2 disabled:opacity-40"
                  >
                    {adapterLoading ? 'Sucht …' : 'Neu suchen'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </form>

        {/* Seven lines under the field on every visit, for a question most
            people only have once something did not work. The warning above
            stays in full — that one is binding — and the result names the
            path that answered, so the explanation can wait a click. */}
        <Reveal label="Welche Wege probiert werden" className="mt-[12px]">
          <div className="flex flex-col gap-[8px] text-small leading-[1.5] text-muted">
            {IN_DESKTOP_APP ? (
              <p>
                In der Desktop-App nutzt Sondra direkt yt-dlp auf Ihrem Rechner. Das lädt YouTube und
                Portale in voller Auflösung ohne fremde Server.
              </p>
            ) : (
              <>
                <p>
                  <strong className="text-ink">1. Direkte Mediendateien:</strong> Dateien wie .mp4, .mp3,
                  Podcasts und HLS-Streams (.m3u8) lädt der Webbrowser direkt herunter.
                </p>
                <p>
                  <strong className="text-ink">2. YouTube & geschützte Portale:</strong> Werden von
                  YouTube für Webseiten blockiert. Sie funktionieren erst nach Start der{' '}
                  <a
                    href="https://www.sondra.lizge.ch/download.html"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-medium underline hover:text-ink"
                  >
                    Sondra Windows-App
                  </a>{' '}
                  oder der lokalen yt-dlp-Brücke auf Ihrem PC.
                </p>
              </>
            )}
          </div>
        </Reveal>
      </Card>

      {error ? (
        !IN_DESKTOP_APP &&
        (isPortalUrl(url) ||
          error.code === 'youtube.sabr' ||
          error.code === 'no-extractor' ||
          error.code === 'youtube.signin' ||
          error.message.toLowerCase().includes('youtube') ||
          error.message.toLowerCase().includes('anmeldung')) ? (
          <Notice tone="error" title="YouTube-Download im Webbrowser blockiert">
            <p className="leading-[1.5]">{error.message}</p>
            <div className="mt-[12px] rounded-nav bg-panel-soft p-[14px] text-ink">
              <p className="text-small font-semibold">
                Warum klappt der direkte Download hier nicht?
              </p>
              <p className="mt-[4px] text-small leading-[1.5] text-muted">
                YouTube verlangt eine Anmeldung und lässt Abrufe von Webseiten und externen Servern nicht durch.
                Damit YouTube-Downloads funktionieren, wählen Sie einen der folgenden Wege:
              </p>
              <div className="mt-[10px] flex flex-wrap gap-[8px]">
                <a
                  href="https://www.sondra.lizge.ch/download.html"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-[6px] rounded-nav bg-ink px-[12px] py-[6px] text-small font-medium text-on-ink hover:opacity-90"
                >
                  Sondra Windows-App herunterladen (Empfohlen)
                  <ArrowRight />
                </a>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('sondra:open-setup-dialog'))
                  }}
                >
                  Lokale Brücke einrichten
                </Button>
              </div>
            </div>
          </Notice>
        ) : (
          <Notice tone="error" title="Hat nicht geklappt">
            <p>{error.message}</p>
          </Notice>
        )
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

          <div className="mt-[16px] flex flex-col gap-[12px]">
            {filterAudioOnly ? (
              <div className="rounded-nav bg-panel-soft p-[12px] text-ink">
                <p className="text-small font-semibold">
                  Audiospur wird als <span className="underline font-bold text-ink">{targetAudioFormat.toUpperCase()}</span> gespeichert:
                </p>
                <p className="mt-[2px] text-micro text-muted">
                  Wählen Sie die gewünschte Audioquelle (höhere Bitrate = bessere Tonqualität):
                </p>
              </div>
            ) : null}

            {(() => {
              const displayedStreams =
                filterAudioOnly && result.streams.some((s) => !s.hasVideo && s.hasAudio)
                  ? result.streams.filter((s) => !s.hasVideo && s.hasAudio)
                  : result.streams
              const groups = groupStreams(displayedStreams)

              return groups.map((group) => {
                const isAudioGroup = group.isAudio
                return (
                  <div
                    key={group.id}
                    className="rounded-card border border-line bg-canvas p-[14px] shadow-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-[8px] mb-[10px]">
                      <div className="flex items-center gap-[8px]">
                        <span className="text-subheading font-semibold text-ink">
                          {isAudioGroup && filterAudioOnly ? 'Verfügbare Audio-Quellen' : group.title}
                        </span>
                        {group.badge ? (
                          <span className="rounded-nav bg-panel-soft px-[8px] py-[2px] text-micro font-medium text-ink">
                            {group.badge}
                          </span>
                        ) : null}
                      </div>
                      <span className="text-micro text-muted">
                        {group.streams.length} {group.streams.length === 1 ? 'Variante' : 'Varianten'}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[8px]">
                      {group.streams.map((stream, idx) => {
                        const bitrateMatch = stream.label.match(/(\d+\s*kbit\/s)/i)
                        const bitrateLabel = bitrateMatch ? bitrateMatch[1] : null
                        const isBestInGroup = idx === 0 && stream.bytes && group.streams.length > 1

                        return (
                          <div
                            key={stream.id}
                            className="flex items-center justify-between gap-[10px] rounded-nav bg-panel-soft px-[12px] py-[8px] ring-1 ring-line/70 hover:ring-ink/30 transition-all"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-[6px] flex-wrap">
                                <span className="font-semibold text-small text-ink">
                                  {filterAudioOnly ? targetAudioFormat.toUpperCase() : stream.ext.toUpperCase()}
                                </span>
                                {bitrateLabel ? (
                                  <span className="rounded-nav bg-canvas px-[6px] py-[1px] text-micro font-medium text-ink">
                                    {bitrateLabel}
                                  </span>
                                ) : null}
                                {stream.label.includes('mit Ton') ? (
                                  <span className="rounded-nav bg-canvas px-[6px] py-[1px] text-micro text-muted">
                                    Bild & Ton
                                  </span>
                                ) : null}
                                {isBestInGroup ? (
                                  <span className="rounded-nav bg-keylime/40 text-ink px-[6px] py-[1px] text-micro font-medium">
                                    {isAudioGroup ? 'Beste Qualität' : 'Beste'}
                                  </span>
                                ) : null}
                              </div>
                              <p className="value text-micro text-muted mt-[2px]">
                                {stream.bytes ? formatBytes(stream.bytes) : 'Größe dynamisch'}
                                {filterAudioOnly && !isAudioGroup ? ' · Video-Audiospur' : ''}
                              </p>
                            </div>

                            <Button
                              size="sm"
                              disabled={busy !== null}
                              onClick={() => void take(stream)}
                            >
                              {busy === stream.label
                                ? 'Lädt …'
                                : filterAudioOnly
                                ? `${targetAudioFormat.toUpperCase()} laden`
                                : 'Laden'}
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })
            })()}
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
              <h3 className="text-subheading text-ink">{batchEntries.length} Einträge</h3>
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
                  ? ` · Dateinamen ${
                      stealthMode === 'standard' ? 'neutral' : stealthMode === 'full_security' ? 'nur aus Zeichen' : 'wie Office-Dateien'
                    }`
                  : ''}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-[8px]">
              <Select
                aria-label="Wie viele gleichzeitig laden"
                value={concurrency}
                disabled={batchBusy}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="w-auto! py-[6px]"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} gleichzeitig
                  </option>
                ))}
              </Select>
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

          {/* One row per entry, divided by a line — they were boxes on a
              tint, a card per row. */}
          <ol className="flex flex-col divide-y divide-line">
            {batchEntries.map((entry, index) => {
              const stream =
                entry.result?.streams.find((s) => s.id === entry.selectedStreamId) ||
                entry.result?.streams[0]

              return (
                <li key={`${index}-${entry.url}`} className="flex max-w-none flex-col gap-[8px] py-[12px]">
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
                            <Select
                              aria-label="Fassung"
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
                              className="w-auto! max-w-[280px] py-[6px]"
                            >
                              {entry.result.streams.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.label} ({s.ext.toUpperCase()}{s.bytes ? ` · ${formatBytes(s.bytes)}` : ''})
                                </option>
                              ))}
                            </Select>
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
                    <p className="flex gap-[8px] text-small leading-[1.5] text-prose">
                      <span className="font-semibold text-ink" aria-hidden>
                        !
                      </span>
                      {entry.error}
                    </p>
                  ) : null}

                  {entry.status === 'downloading' && entry.progress ? (
                    <Progress
                      value={entry.progress.total ? entry.progress.loaded / entry.progress.total : null}
                      label={`${formatBytes(entry.progress.loaded)}${
                        entry.progress.total ? ` von ${formatBytes(entry.progress.total)}` : ''
                      }`}
                    />
                  ) : null}
                </li>
              )
            })}
          </ol>
        </Card>
      ) : null}

      {/* Download-Verlauf (Historie) */}
      {history.length > 0 ? (
        <Card tone="keylime">
          <div className="flex flex-wrap items-center justify-between gap-[8px] border-b border-line pb-[10px]">
            <div>
              <h3 className="text-subheading text-ink">Zuletzt geladen</h3>
              <p className="mt-[2px] text-small text-muted">Die letzten {history.length} Adressen, gemerkt nur auf diesem Gerät.</p>
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
          <div className="flex flex-col divide-y divide-line">
            {history.map((item) => (
              <div key={item.id} className="flex flex-col gap-[8px] py-[10px] sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-small text-ink" title={item.title}>
                    {item.title}
                  </p>
                  <p className="value truncate text-small text-muted">
                    {[
                      item.author,
                      item.format.toUpperCase(),
                      item.bytes ? formatBytes(item.bytes) : null,
                      new Date(item.timestamp).toLocaleString('de-CH', {
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
                  >
                    Wieder nachsehen
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(item.url)
                    }}
                  >
                    Adresse kopieren
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* Every way there is, said on the page. The field at the top picks
          one by itself; this is where someone who wants another one finds
          out that it exists. A fold labelled „Mehr Wege" hid three whole
          ways behind one line of grey text, and they went unfound. */}
      <section aria-labelledby="weitere-wege" className="flex flex-col gap-[12px] border-t-2 border-rule pt-[16px]">
        <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[4px]">
          <h3 id="weitere-wege" className="display-sm text-ink">
            Weitere Wege
          </h3>
          <p className="text-small text-prose">Das Feld oben wählt den Weg selbst. Hier stehen alle, die es gibt.</p>
        </div>
        <div className="grid gap-[8px] sm:grid-cols-3">
          <WayTile
            title="Datei oder Stream"
            hint="Eine Adresse, die direkt auf eine Datei oder eine HLS-Playlist (.m3u8) zeigt. Lädt im Browser, ohne Dienst."
            action={waysOpen ? 'Schliessen' : 'Öffnen'}
            pressed={waysOpen}
            onClick={() => setWaysOpen((open) => !open)}
          />
          <WayTile
            title="YouTube in voller Auflösung"
            hint={
              IN_DESKTOP_APP
                ? 'Läuft in dieser App über ihren eigenen Dienst — nichts einzurichten.'
                : 'Mit der Windows-App oder einer lokalen Brücke: yt-dlp oder cobalt, mit oder ohne Node.js.'
            }
            action="Einrichten"
            onClick={openSetup}
          />
          <WayTile
            title="Eigener Dienst"
            hint="Einen Server, einen Docker-Container oder eine Instanz verbinden, deren Adresse Sie haben."
            action="Verbinden"
            onClick={openSetup}
          />
        </div>
        {/* Always mounted: the service connection and the setup dialog live in
            here, and the buttons above and in the error notice reach them. */}
        <div hidden={!waysOpen}>
          <AdvancedDownloader url={url} />
        </div>
      </section>
    </div>
  )
}
