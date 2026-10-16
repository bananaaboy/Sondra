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
import { useIngestFiles } from '../../hooks/useIngest'
import { opusArgs } from '../../lib/convert'
import { extractAddresses, isHlsPlaylistText, isPortalUrl, isSupportedUrl, saveBytes } from '../../lib/download'
import { formatBytes, formatDuration } from '../../lib/format'
import { decodeWithBrowser } from '../../lib/audio'
import { SPEECH_MODELS, toSpeechSamples, transcribe, toSrt } from '../../lib/transcribe'
import { tagAudioFile } from '../../lib/tagger'
import {
  StudioError,
  downloadStream,
  filenameFor,
  isHlsStream,
  resolveViaService,
  type StealthMode,
  type StudioResult,
  type StudioStream,
} from '../../lib/studio'
import { serviceConnection } from '../../lib/serviceState'
import { kindFromMime, useSession } from '../../state/store'
import { ArrowRight, Button, Card, Notice, Progress, Reveal, Select, Toggle } from '../ui/primitives'
import { ChoiceRow } from '../editor/EditorShell'
import { loadFfmpeg, runFfmpeg } from '../../lib/ffmpegClient'
import { AdvancedDownloader } from './DownloaderAdvanced'
import { createZip, uniqueEntryNames } from '../../lib/zip'
import { ZipSave } from '../ZipSave'

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
  // Every word stays — the last sentence is binding. What changed is the
  // shape: three bullets under a heading made a box half a screen tall above
  // the field. Side by side the same three sentences take a few lines.
  return (
    <div role="note" className="rounded-card bg-panel-cool p-[16px] ring-2 ring-inset ring-ink sm:p-[20px]">
      <p className="flex items-start gap-[10px] text-ink">
        <svg viewBox="0 0 16 16" className="mt-[1px] size-[20px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 1.6l6.2 10.8H1.8zM8 6.2v3.1M8 11.2h.01" />
        </svg>
        <span className="flex flex-wrap items-baseline gap-x-[12px] gap-y-[2px]">
          <span className="text-body font-bold leading-[1.3]">Achtung: Herunterladen läuft nicht lokal</span>
          <span className="text-small text-prose">
            Das ist das einzige Werkzeug, das Ihr Gerät verlässt. Alle anderen rechnen nur hier.
          </span>
        </span>
      </p>
      <ul className="mt-[10px] grid gap-x-[24px] gap-y-[6px] text-small leading-[1.5] text-prose sm:grid-cols-3 sm:pl-[30px] [&_li]:max-w-none">
        <li>
          Die Adresse, die Sie einfügen, geht an einen Dienst dieser Seite. Er schlägt dort nach und
          holt die Datei. Ihre eigenen Dateien sieht er nie.
        </li>
        <li>
          Die Datei läuft durch diesen Dienst zu Ihnen. Gespeichert wird sie dort nicht; alles
          Weitere — schneiden, umwandeln, trennen — passiert wieder hier im Tab.
        </li>
        <li className="font-semibold text-ink">
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
    <div role="note" className="rounded-card bg-panel-soft p-[16px] sm:p-[20px]">
      <p className="text-body font-bold leading-[1.3] text-ink">Herunterladen läuft über diesen Rechner</p>
      <ul className="mt-[10px] grid gap-x-[24px] gap-y-[6px] text-small leading-[1.5] text-prose sm:grid-cols-3 [&_li]:max-w-none">
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
  /** Stable for the life of the entry, whatever happens to the rows around it. */
  id: string
  url: string
  titleHint?: string
  status: 'pending' | 'resolving' | 'ready' | 'downloading' | 'done' | 'error'
  result?: StudioResult
  selectedStreamId?: string
  error?: string
  progress?: { loaded: number; total: number | null } | null
  taken?: { name: string; bytes: Uint8Array; mime: string }
  groupId?: string
  groupTitle?: string
  /** The title the list itself gave this entry (a feed's episode title). */
  sourceTitle?: string
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
      className={`press group flex flex-col items-start gap-[4px] rounded-card px-[16px] py-[12px] text-left transition-colors duration-[var(--dur-fast)] ${
        pressed ? 'bg-panel-strong' : 'bg-panel-mid hover:bg-panel-strong'
      }`}
    >
      <span className="text-body font-semibold text-ink">{title}</span>
      <span className="text-small leading-[1.5] text-prose">{hint}</span>
      <span className="mt-auto inline-flex items-center gap-[6px] pt-[4px] text-small font-semibold text-ink">
        {action}
        <ArrowRight className="transition-transform duration-[var(--dur-fast)] group-hover:translate-x-[2px]" />
      </span>
    </button>
  )
}

/** Opens the setup dialog, which lives in the advanced downloader. */
const openSetup = () => window.dispatchEvent(new CustomEvent('sondra:open-setup-dialog'))

// What the address field answers to, for the line under it: the first few by
// name, the rest a click away. It was twenty chips under the field on every
// visit.
const SERVICES = [
  'YouTube',
  'Spotify',
  'Apple Podcasts',
  'Mediatheken (ARD, ZDF, Arte, SRF, ORF, 3sat)',
  'TikTok',
  'Instagram',
  'AniWorld / SerienStream',
  'Threads',
  'Twitch',
  'SoundCloud',
  'Bandcamp',
  'Vimeo',
  'Reddit',
  'Snapchat',
  'Patreon',
  'Rumble',
  'Kick',
  'Archive.org',
  'Podcast-RSS',
  'direkte Dateiadressen',
]
const SERVICES_NAMED = 4
/** Versions shown before „weitere Fassungen": the best of each resolution fit. */
const STREAMS_SHOWN = 6

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

  const { ingest: ingestFile } = useIngestFiles()
  const [isDragOver, setIsDragOver] = useState(false)
  const [showServices, setShowServices] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showAllStreams, setShowAllStreams] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (list.length === 0) return
    const textFiles = list.filter((f) => f.type.startsWith('text/') || /\.(txt|m3u|m3u8|csv|json)$/i.test(f.name))
    const mediaFiles = list.filter((f) => !textFiles.includes(f))

    if (textFiles.length > 0) {
      const urls: string[] = []
      for (const tf of textFiles) {
        try {
          const content = await tf.text()
          // The segments of one stream are not a list of things to load.
          if (isHlsPlaylistText(content)) {
            log('holen', `${tf.name} ist eine HLS-Playlist, keine Liste von Links — bitte ihre Adresse einfügen`, 'warn')
            continue
          }
          urls.push(...extractAddresses(content))
        } catch {}
      }
      if (urls.length > 0) {
        const unique = Array.from(new Set(urls))
        // The field is one line; joined with line breaks the addresses ran
        // into one another on screen.
        setUrl(unique.join(', '))
        log('holen', `${unique.length} ${unique.length === 1 ? 'Adresse' : 'Adressen'} aus ${textFiles[0].name} übernommen`)
        void look(unique.join('\n'))
      } else if (!textFiles.every((tf) => /\.m3u8$/i.test(tf.name))) {
        setError({ code: 'url', message: `In ${textFiles[0].name} steht keine Adresse, die mit https:// beginnt.` })
      }
    }

    if (mediaFiles.length > 0) {
      log('holen', `${mediaFiles.length} ${mediaFiles.length === 1 ? 'Datei' : 'Dateien'} per Drag & Drop übernommen`)
      await ingestFile(mediaFiles, 'per Drag & Drop hinzugefügt')
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    // A link dragged from another tab, or several: `text/uri-list` holds one
    // per line, with comment lines in between.
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    const dropped = text ? extractAddresses(text) : []
    if (dropped.length > 0) {
      setUrl(dropped.join(', '))
      void look(dropped.join('\n'))
      return
    }

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files)
    }
  }

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
  /** A playlist's or season's own title, as the archive's suggested name. */
  const [batchTitle, setBatchTitle] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const batchEntriesRef = useRef<BatchItem[] | null>(null)
  batchEntriesRef.current = batchEntries

  const [concurrency, setConcurrency] = useState<number>(3)
  const [batchBusy, setBatchBusy] = useState(false)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null)
  /** What the last „Laden“ put into the session, so it can still be saved. */
  const [taken, setTaken] = useState<{ name: string; bytes: Uint8Array; mime: string } | null>(null)
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null)
  const dismissedClipboardRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const checkClipboard = async () => {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return
      try {
        // One address in what was copied, of a kind this can load — a portal
        // or a media file. Only portals counted before, and only when the
        // clipboard held nothing but the bare address.
        const found = extractAddresses(await navigator.clipboard.readText())
        const text = found.length === 1 ? found[0] : ''
        if (text && isSupportedUrl(text) && !extractAddresses(url).includes(text) && !dismissedClipboardRef.current.has(text)) {
          setClipboardUrl(text)
        }
      } catch {}
    }

    void checkClipboard()
    window.addEventListener('focus', checkClipboard)
    return () => window.removeEventListener('focus', checkClipboard)
  }, [url])
  const abortRef = useRef<AbortController | null>(null)
  const batchAbortRef = useRef<AbortController | null>(null)
  const resolvingMapRef = useRef<Map<string, Promise<StudioResult | null>>>(new Map())
  const itemAbortControllers = useRef<Map<string, AbortController>>(new Map())
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

  // Every entry of a list has an id of its own. Addressed by position, a
  // playlist that unfolded into its titles shifted every row after it: a
  // result landed on whichever row now stood there, and the entries pushed
  // down were never looked up at all.
  const nextBatchId = useRef(0)
  const newBatchItem = (fields: Omit<BatchItem, 'id'>): BatchItem => {
    nextBatchId.current += 1
    return { ...fields, id: `eintrag-${nextBatchId.current}` }
  }

  /**
   * Changes the list at once, not on the next render. Read back right after
   * an await, the list from the last render still said „wird gesucht", and
   * „Laden" on an entry that had not been looked up yet only looked it up.
   */
  const updateBatch = (change: (list: BatchItem[]) => BatchItem[]) => {
    const current = batchEntriesRef.current
    if (!current) return
    const next = change(current)
    batchEntriesRef.current = next
    setBatchEntries(next)
  }
  const replaceBatch = (list: BatchItem[] | null) => {
    batchEntriesRef.current = list
    setBatchEntries(list)
  }
  const patchEntry = (id: string, patch: Partial<BatchItem>) =>
    updateBatch((list) => list.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
  const entryById = (id: string) => batchEntriesRef.current?.find((entry) => entry.id === id)

  /** The stream an entry starts with: sound alone when only sound is wanted. */
  const defaultStream = (res: StudioResult) => {
    const audioStream = res.streams.find((s) => !s.hasVideo && s.hasAudio)
    const lowestVideoWithAudio = res.streams
      .filter((s) => s.hasVideo && s.hasAudio)
      .sort((a, b) => (a.height ?? 9999) - (b.height ?? 9999))[0]
    return filterAudioOnlyRef.current
      ? audioStream || lowestVideoWithAudio || res.streams[0]
      : res.streams.find((s) => s.hasVideo && s.hasAudio) || res.streams[0]
  }

  /** Looks entries up a few at a time, as many at once as „gleichzeitig" says. */
  const resolveAll = (ids: string[], signal?: AbortSignal) => {
    let cursor = 0
    const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
      while (cursor < ids.length && !signal?.aborted) {
        const id = ids[cursor++]
        await resolveBatchItem(id, signal)
      }
    })
    return Promise.all(workers)
  }

  const look = async (overrideUrl?: string) => {
    const targetSource = overrideUrl ?? url
    let targets = extractAddresses(targetSource)
    // „youtube.com/watch?v=…" without its scheme is still meant as an address.
    const bare = targetSource.trim()
    if (targets.length === 0 && /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]\S*)?$/i.test(bare)) {
      targets = [`https://${bare}`]
    }
    if (targets.length === 0) {
      if (bare) {
        setError({ code: 'url', message: 'Im Feld steht keine Adresse. Eine Adresse beginnt mit https://.' })
      }
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLooking(true)
    setError(null)
    setResult(null)
    setShowAllStreams(false)
    replaceBatch(null)
    setBatchTitle(null)
    setTaken(null)

    if (targets.length === 1) {
      try {
        const found = await resolveViaService(targets[0], controller.signal)
        if (found.isPlaylist) {
          log('holen', `Staffel / Playlist erkannt: ${found.title} (${found.items.length} Titel)`)
          if (found.items.length === 0) {
            setError({ code: 'empty', message: `„${found.title || 'Die Liste'}“ enthält keine Titel, die sich laden liessen.` })
            return
          }
          const gId = targets[0]
          const gTitle = found.title || 'Playlist'
          const playlistItems = found.items.map((item) =>
            newBatchItem({
              url: item.url,
              titleHint: item.title,
              sourceTitle: item.title || undefined,
              status: 'pending',
              groupId: gId,
              groupTitle: gTitle,
            }),
          )
          replaceBatch(playlistItems)
          setBatchTitle(found.title || null)
          if (playlistItems.length > 3) {
            setCollapsedGroups({ [gId]: true })
          }
          // Every entry is looked up in the background, a few at a time.
          void resolveAll(
            playlistItems.map((item) => item.id),
            controller.signal,
          )
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

    // Several addresses: one entry each, looked up in the background.
    const initial = targets.map((u, i) => {
      let host = u
      try {
        host = new URL(u).hostname.replace(/^www\./, '')
      } catch {}
      return newBatchItem({
        url: u,
        titleHint: `Link ${i + 1} (${host})`,
        status: 'pending',
        groupId: u,
        groupTitle: `Link ${i + 1} (${host})`,
      })
    })
    replaceBatch(initial)
    setLooking(false)
    void resolveAll(
      initial.map((item) => item.id),
      controller.signal,
    )
  }

  /**
   * Looks one entry up. Resolves to its result, or to null when it failed or
   * unfolded into a list of its own — whose entries then take its place and
   * are looked up in turn.
   */
  const resolveBatchItem = async (id: string, signal?: AbortSignal): Promise<StudioResult | null> => {
    const inFlight = resolvingMapRef.current.get(id)
    if (inFlight) return inFlight

    const entry = entryById(id)
    if (!entry) return null
    if (entry.result && (entry.status === 'ready' || entry.status === 'done')) return entry.result

    const task = (async (): Promise<StudioResult | null> => {
      patchEntry(id, { status: 'resolving', error: undefined })
      try {
        const res = await resolveViaService(entry.url, signal)
        if (res.isPlaylist) {
          const gId = entry.groupId || entry.url
          const gTitle = res.title || entry.groupTitle || 'Playlist'
          if (!res.items?.length) {
            // It used to stay at „wird gesucht" for good.
            patchEntry(id, { status: 'error', error: `„${gTitle}“ enthält keine Titel, die sich laden liessen.` })
            return null
          }
          log('holen', `Playlist / Staffel aufgelöst: ${res.title} (${res.items.length} Titel)`)
          const expanded = res.items.map((item) =>
            newBatchItem({
              url: item.url,
              titleHint: item.title,
              sourceTitle: item.title || undefined,
              status: 'pending',
              groupId: gId,
              groupTitle: gTitle,
            }),
          )
          updateBatch((list) => list.flatMap((item) => (item.id === id ? expanded : [item])))
          if (expanded.length > 3) {
            setCollapsedGroups((prev) => ({ ...prev, [gId]: true }))
          }
          void resolveAll(
            expanded.map((item) => item.id),
            signal,
          )
          return null
        }
        // A feed names its episodes; the file behind each is often called
        // „default.mp3_…". Looked up as a plain file, the name in the list and
        // on disk was that one.
        const named = res.source === 'direct' && entry.sourceTitle ? { ...res, title: entry.sourceTitle } : res
        const bestStream = defaultStream(named)
        patchEntry(id, { status: 'ready', result: named, selectedStreamId: bestStream?.id ?? named.streams[0]?.id })
        log('holen', `${named.title} — bereit`)
        return named
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') {
          // Cancelled, not failed: it can be asked again.
          patchEntry(id, { status: 'pending' })
          return null
        }
        const msg = cause instanceof StudioError ? cause.message : cause instanceof Error ? cause.message : String(cause)
        patchEntry(id, { status: 'error', error: msg })
        return null
      } finally {
        resolvingMapRef.current.delete(id)
      }
    })()

    resolvingMapRef.current.set(id, task)
    return task
  }

  /**
   * What a downloaded stream becomes in the session: converted to the chosen
   * sound format or tagged, named, and — for a stream put together from
   * segments — typed as the MP4 it now is rather than as its playlist.
   */
  const finishDownload = async (
    bytes: Uint8Array,
    stream: StudioStream,
    res: StudioResult,
    signal: AbortSignal,
    onStatus?: (status: string) => void,
  ) => {
    const assembled = isHlsStream(stream)
    const meta = { title: res.title, artist: res.author, coverUrl: res.thumbnail }
    let finalBytes = bytes
    let finalExt = assembled ? 'mp4' : stream.ext
    let finalMime = assembled ? 'video/mp4' : stream.mime
    let finalKind = assembled ? ('video' as const) : kindFromMime(stream.mime, stream.label)

    if (filterAudioOnlyRef.current) {
      onStatus?.(`Wandle in ${targetAudioFormatRef.current.toUpperCase()} um …`)
      const audioRes = await processDownloadedAudio(
        bytes,
        finalExt,
        targetAudioFormatRef.current,
        assembled || stream.hasVideo,
        meta,
        signal,
        onStatus,
      )
      finalBytes = audioRes.bytes
      finalExt = audioRes.ext
      finalMime = audioRes.mime
      finalKind = 'audio'
    } else if (!stream.hasVideo && stream.hasAudio && !assembled) {
      finalBytes = await tagAudioFile(bytes, stream.ext, meta, signal)
    }

    let name = filenameFor(res, assembled ? { ...stream, ext: 'mp4' } : stream, { mode: stealthModeRef.current })
    if (filterAudioOnlyRef.current) {
      name = name.replace(/\.[a-zA-Z0-9]+$/, '') + `.${finalExt}`
    }
    return { bytes: finalBytes, ext: finalExt, mime: finalMime, kind: finalKind, name }
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
      const done = await finishDownload(bytes, stream, result, controller.signal, (status) => setBusy(status))

      addAsset({
        name: done.name,
        bytes: done.bytes,
        mime: done.mime,
        sizeBytes: done.bytes.byteLength,
        kind: done.kind,
        audio: null,
        durationSeconds: result.durationSeconds,
        origin: 'download',
      })
      log('holen', `${done.name} geladen (${formatBytes(done.bytes.byteLength)})`)
      setTaken({ name: done.name, bytes: done.bytes, mime: done.mime })
      recordDownload(url, result.title, result.author ?? '', done.ext, done.bytes.byteLength)
      if (autoTranscribeRef.current) {
        void triggerAutoTranscribe(done.name, done.bytes)
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

  const takeBatchItem = async (id: string, externalSignal?: AbortSignal) => {
    let entry = entryById(id)
    // A second click while it runs must not start it twice.
    if (!entry || entry.status === 'downloading') return

    let res = entry.status === 'ready' ? (entry.result ?? null) : null
    if (!res) {
      res = await resolveBatchItem(id, externalSignal)
      entry = entryById(id)
      if (!res || !entry) return
    }

    const stream = res.streams.find((s) => s.id === entry!.selectedStreamId) || res.streams[0]
    if (!stream) return

    const controller = externalSignal ? null : new AbortController()
    if (controller) {
      itemAbortControllers.current.set(id, controller)
      abortRef.current = controller
    }
    const signal = externalSignal || controller!.signal

    patchEntry(id, { status: 'downloading', error: undefined, progress: { loaded: 0, total: stream.bytes } })

    try {
      const bytes = await downloadStream(stream, {
        signal,
        onProgress: (p) => patchEntry(id, { progress: p }),
      })
      if (filterAudioOnlyRef.current) {
        patchEntry(id, { progress: { loaded: bytes.byteLength, total: bytes.byteLength } })
      }
      const done = await finishDownload(bytes, stream, res, signal)

      addAsset({
        name: done.name,
        bytes: done.bytes,
        mime: done.mime,
        sizeBytes: done.bytes.byteLength,
        kind: done.kind,
        audio: null,
        durationSeconds: res.durationSeconds,
        origin: 'download',
      })
      log('holen', `${done.name} geladen (${formatBytes(done.bytes.byteLength)})`)
      if (autoTranscribeRef.current) {
        void triggerAutoTranscribe(done.name, done.bytes)
      }
      patchEntry(id, { status: 'done', progress: null, taken: { name: done.name, bytes: done.bytes, mime: done.mime } })
      recordDownload(entry.url, res.title, res.author ?? '', done.ext, done.bytes.byteLength)
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        // Cancelled: back to where it was, ready to load again.
        patchEntry(id, { status: 'ready', progress: null })
        return
      }
      const msg = cause instanceof StudioError ? cause.message : cause instanceof Error ? cause.message : String(cause)
      patchEntry(id, { status: 'error', error: msg, progress: null })
      log('holen', `Fehler beim Laden von ${res.title ?? entry.url}: ${msg}`, 'error')
    } finally {
      if (controller) {
        itemAbortControllers.current.delete(id)
      }
    }
  }

  const downloadAllBatch = async () => {
    if (!batchEntriesRef.current) return
    const controller = new AbortController()
    batchAbortRef.current = controller
    setBatchBusy(true)
    try {
      // The queue is read as it goes, not fixed at the start: an entry that
      // turns out to be a playlist hands its titles to the same run instead of
      // leaving them for another click.
      const claimed = new Set<string>()
      const nextEntry = () =>
        batchEntriesRef.current?.find(
          (entry) => !claimed.has(entry.id) && entry.status !== 'done' && entry.status !== 'downloading',
        )
      const maxParallel = Math.max(1, Math.min(5, concurrency))
      const workers = Array.from({ length: maxParallel }, async () => {
        for (;;) {
          if (controller.signal.aborted) break
          const entry = nextEntry()
          if (!entry) break
          claimed.add(entry.id)
          await takeBatchItem(entry.id, controller.signal)
        }
      })
      await Promise.all(workers)
    } finally {
      setBatchBusy(false)
      batchAbortRef.current = null
    }
  }

  // The folded settings, said: what is in force without opening them.
  const settingsSummary = [
    `Dateiname ${
      stealthMode === 'off'
        ? 'wie das Original'
        : stealthMode === 'standard'
          ? 'neutral'
          : stealthMode === 'full_security'
            ? 'nur aus Zeichen'
            : 'wie eine Office-Datei'
    }`,
    autoTranscribe ? 'mit Untertiteln' : 'ohne Untertitel',
    ...(IN_DESKTOP_APP
      ? [selectedAdapter === 'default' ? 'Netzwerk automatisch' : `Netzwerk ${adapters.find((a) => a.id === selectedAdapter)?.name ?? selectedAdapter}`]
      : []),
  ].join(' · ')

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
          {/* The address, as a field that looks like one: its name above,
              a white well with a visible edge, a link sign where the text
              starts, the caret on hover. It was a transparent line inside a
              dashed drop zone with a pill and an emoji in its corner, and
              read as anything but a place to type. A text file of links can
              still be dropped anywhere on it. */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragOver(true)
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            className={`-mx-[8px] flex flex-col gap-[6px] rounded-card px-[8px] pb-[8px] pt-[4px] transition-colors ${
              isDragOver ? 'bg-panel-soft ring-2 ring-inset ring-ink' : ''
            }`}
          >
            <label htmlFor="download-address" className="text-small text-prose">
              {isDragOver ? 'Loslassen, um die Links aus der Datei zu übernehmen' : 'Adresse'}
            </label>
            <div className="flex flex-col gap-[8px] sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <svg
                  aria-hidden
                  viewBox="0 0 24 24"
                  className="pointer-events-none absolute left-[14px] top-1/2 size-[18px] -translate-y-1/2 text-muted"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4l-1.1 1.1" />
                  <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.1-1.1" />
                </svg>
                <input
                  id="download-address"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value)
                    setError(null)
                    setResult(null)
                    replaceBatch(null)
                    setProgress(null)
                  }}
                  placeholder="Link hier einfügen"
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Adresse zum Herunterladen"
                  aria-describedby="download-address-hint"
                  className="value h-[48px] w-full cursor-text rounded-nav border-0 bg-raised pl-[42px] pr-[12px] text-body text-prose outline-none ring-1 ring-inset ring-rule placeholder:font-sans placeholder:text-muted hover:ring-muted focus:ring-2 focus:ring-ink"
                />
              </div>
              <Button type="submit" disabled={looking || url.trim().length === 0} className="h-[48px] shrink-0 py-0 sm:w-auto">
                {looking ? 'Wird gesucht …' : 'Nachsehen'}
              </Button>
            </div>

            {/* A link found in the clipboard, offered as a sentence under the
                field it would fill — not as a second bordered bar above it,
                which looked like another input. */}
            {clipboardUrl && clipboardUrl !== url.trim() ? (
              <div role="status" className="rise flex flex-wrap items-center gap-x-[16px] gap-y-[2px] pt-[2px] text-small">
                <span className="flex min-w-0 max-w-full items-center gap-[8px] text-prose">
                  <span aria-hidden className="size-[7px] shrink-0 rounded-pill bg-ink" />
                  <span className="shrink-0">In der Zwischenablage</span>
                  <span className="value min-w-0 truncate text-ink" title={clipboardUrl}>
                    {clipboardUrl.replace(/^https?:\/\/(www\.)?/, '')}
                  </span>
                </span>
                <span className="flex items-center gap-[16px] pl-[15px] sm:pl-0">
                  <button
                    type="button"
                    onClick={() => {
                      setUrl(clipboardUrl)
                      setClipboardUrl(null)
                      void look(clipboardUrl)
                    }}
                    className="press rounded-nav font-semibold text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                  >
                    Einfügen und nachsehen
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      dismissedClipboardRef.current.add(clipboardUrl)
                      setClipboardUrl(null)
                    }}
                    className="press rounded-nav text-muted hover:text-ink"
                  >
                    Nicht jetzt
                  </button>
                </span>
              </div>
            ) : null}

            <div id="download-address-hint" className="flex flex-col gap-[2px] text-small leading-[1.5] text-muted [&_p]:max-w-none">
              {/* One line, not two: what it takes, then how to give it more
                  than one. */}
              <p>
                YouTube, Spotify, Apple Podcasts, Mediatheken und {SERVICES.length - SERVICES_NAMED} weitere (
                <button
                  type="button"
                  aria-expanded={showServices}
                  onClick={() => setShowServices((open) => !open)}
                  className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                >
                  {showServices ? 'weniger' : 'alle zeigen'}
                </button>
                ). Mehrere Adressen mit Komma trennen, oder eine Textdatei mit Links (.txt, .m3u) aufs Feld ziehen
                bzw.{' '}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                >
                  auswählen
                </button>
                .
              </p>
              {showServices ? <p className="text-prose">{SERVICES.join(' · ')}</p> : null}
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.m3u,.m3u8,.csv,.json"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  if (e.target.files) void handleFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>
          </div>

          {isPortalUrl(url) && !IN_DESKTOP_APP ? (
            <p className="text-small leading-[1.5] text-prose">
              Portalinhalte lassen sich aus dem Browser allein oft nicht oder nur in kleiner Auflösung laden; voll geht es mit der App
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

          {/* What to fetch is asked every time; how to name it, whether to
              transcribe and which network are said as one line and changed a
              click further. Three settings open on every visit were most of
              what stood between the field and the result. */}
          <div className="mt-[4px] flex flex-col gap-[10px] border-t border-line pt-[12px]">
            <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
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
                <ChoiceRow
                  value={targetAudioFormat}
                  options={AUDIO_FORMAT_CONFIGS.map((format) => ({ value: format.id, label: format.label, title: format.desc }))}
                  onChange={setTargetAudioFormat}
                />
              ) : null}
              <button
                type="button"
                aria-expanded={settingsOpen}
                aria-controls="download-settings"
                onClick={() => setSettingsOpen((open) => !open)}
                className="press rounded-nav text-left text-small text-muted hover:text-ink sm:ml-auto"
              >
                {settingsSummary}{' '}
                <span className="text-ink underline decoration-rule underline-offset-[3px]">
                  {settingsOpen ? 'Fertig' : 'Ändern'}
                </span>
              </button>
            </div>
            {filterAudioOnly ? (
              <span className="text-small leading-[1.45] text-muted">
                {AUDIO_FORMAT_CONFIGS.find((format) => format.id === targetAudioFormat)?.desc}. Die Tonspur wird herausgelöst und
                so gespeichert.
              </span>
            ) : null}

            <div id="download-settings" hidden={!settingsOpen} className="grid gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
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
          </div>
        </form>

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
            {/* The reason and the way out as the notice's own text, not a
                tinted box inside the notice. */}
            <p className="leading-[1.5]">{error.message}</p>
            <div className="mt-[10px]">
              <p className="text-small font-semibold text-ink">Warum klappt der direkte Download hier nicht?</p>
              <p className="mt-[2px] text-small leading-[1.5] text-prose">
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

          {/* The versions on offer as a list, one line each: what it is, its
              format and size, and the button. They were a bordered box per
              resolution with a tinted tile per version inside it — three
              levels of frame for one choice. */}
          <div className="mt-[16px] flex flex-col">
            {filterAudioOnly ? (
              <p className="pb-[8px] text-small text-muted">
                Gespeichert wird der Ton als <span className="value text-ink">{targetAudioFormat.toUpperCase()}</span>; eine
                Fassung mit höherer Bitrate klingt besser.
              </p>
            ) : null}
            {(() => {
              const displayedStreams =
                filterAudioOnly && result.streams.some((s) => !s.hasVideo && s.hasAudio)
                  ? result.streams.filter((s) => !s.hasVideo && s.hasAudio)
                  : result.streams
              const rows = groupStreams(displayedStreams).flatMap((group) =>
                group.streams.map((stream, index) => ({ group, stream, best: index === 0 && Boolean(stream.bytes) && group.streams.length > 1 })),
              )
              const visible = showAllStreams ? rows : rows.slice(0, STREAMS_SHOWN)
              return (
                <>
                  <ul className="flex flex-col divide-y divide-line border-y border-line">
                    {visible.map(({ group, stream, best }) => {
                      const bitrate = stream.label.match(/(\d+\s*kbit\/s)/i)?.[1] ?? null
                      const detail = [
                        filterAudioOnly ? targetAudioFormat.toUpperCase() : stream.ext.toUpperCase(),
                        bitrate,
                        stream.bytes ? formatBytes(stream.bytes) : null,
                        stream.label.includes('mit Ton') ? 'Bild und Ton' : null,
                        filterAudioOnly && !group.isAudio ? 'Ton aus dem Video' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                      return (
                        <li key={stream.id} className="flex max-w-none items-center justify-between gap-[12px] py-[10px]">
                          <div className="min-w-0">
                            <p className="truncate text-body text-ink">
                              {group.isAudio && filterAudioOnly ? 'Ton' : group.title}
                              {best ? <span className="text-small text-muted"> · {group.isAudio ? 'beste Qualität' : 'beste'}</span> : null}
                            </p>
                            <p className="value truncate text-small text-muted">{detail}</p>
                          </div>
                          <Button size="sm" disabled={busy !== null} onClick={() => void take(stream)} className="shrink-0">
                            {busy === stream.label ? 'Lädt …' : filterAudioOnly ? `${targetAudioFormat.toUpperCase()} laden` : 'Laden'}
                          </Button>
                        </li>
                      )
                    })}
                  </ul>
                  {rows.length > STREAMS_SHOWN ? (
                    <button
                      type="button"
                      aria-expanded={showAllStreams}
                      onClick={() => setShowAllStreams((open) => !open)}
                      className="press flex items-center gap-[8px] self-start rounded-nav py-[10px] text-small text-ink"
                    >
                      <span aria-hidden className="value">
                        {showAllStreams ? '−' : '+'}
                      </span>
                      {showAllStreams ? 'Weniger Fassungen' : `${rows.length - STREAMS_SHOWN} weitere Fassungen`}
                    </button>
                  ) : null}
                </>
              )
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

          {/* Everything already loaded, as one archive under a name of one's
              own — instead of a save prompt per file. */}
          {batchEntries.filter((entry) => entry.taken).length > 1 ? (
            <div className="border-b border-line py-[12px]">
              <ZipSave
                suggestion={batchTitle ?? `downloads-${new Date().toISOString().slice(0, 10)}`}
                label={`${batchEntries.filter((entry) => entry.taken).length} geladene als ZIP speichern`}
                variant="quiet"
                onSave={({ file }) => {
                  const files = uniqueEntryNames(
                    batchEntries.flatMap((entry) => (entry.taken ? [{ name: entry.taken.name, data: entry.taken.bytes }] : [])),
                  )
                  saveBytes(createZip(files), file, 'application/zip')
                  log('holen', `${files.length} Dateien als ${file} gespeichert`)
                }}
              />
            </div>
          ) : null}

          {(() => {
            const groupMap = new Map<
              string,
              { id: string; title: string; items: { entry: BatchItem }[] }
            >()
            batchEntries.forEach((entry) => {
              const gId = entry.groupId || 'default'
              const gTitle =
                entry.groupTitle ||
                (entry.titleHint && !entry.titleHint.startsWith('http')
                  ? entry.titleHint
                  : batchTitle || 'Downloads')
              if (!groupMap.has(gId)) {
                groupMap.set(gId, { id: gId, title: gTitle, items: [] })
              }
              groupMap.get(gId)!.items.push({ entry })
            })

            const groups = Array.from(groupMap.values())
            // A single address is its own group of one; only a real list (a
            // playlist, a season, a file of links) gets a heading. Folding
            // hides what is past the third entry, so the switch for all
            // lists appears only when more than one list has something to fold.
            const lists = groups.filter((group) => group.items.length > 1)
            const foldable = groups.filter((group) => group.items.length > 3).length > 1
            const setAll = (collapsed: boolean) =>
              setCollapsedGroups(Object.fromEntries(groups.map((group) => [group.id, collapsed])))

            return (
              <>
                {lists.length > 1 ? (
                  <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[4px] py-[10px] text-small">
                    <span className="text-muted">Aus {lists.length} Listen</span>
                    {foldable ? (
                      <span className="flex items-center gap-[16px]">
                        <button
                          type="button"
                          onClick={() => setAll(false)}
                          className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                        >
                          Alle ausklappen
                        </button>
                        <button type="button" onClick={() => setAll(true)} className="press rounded-nav text-muted hover:text-ink">
                          Alle einklappen
                        </button>
                      </span>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex flex-col">
                  {groups.map((group) => {
                    const isCollapsed = collapsedGroups[group.id] ?? group.items.length > 3
                    const doneCount = group.items.filter((i) => i.entry.status === 'done').length
                    const errorCount = group.items.filter((i) => i.entry.status === 'error').length
                    const activeCount = group.items.filter(
                      (i) => i.entry.status === 'downloading' || i.entry.status === 'resolving',
                    ).length
                    const visibleItems = isCollapsed ? group.items.slice(0, 3) : group.items
                    const hidden = group.items.length - visibleItems.length

                    return (
                      <section
                        key={group.id}
                        className={`border-t border-line first:border-t-0 ${group.items.length > 1 ? 'mt-[12px] pt-[12px] first:mt-0' : ''}`}
                      >
                        {/* One list per source: its name, how far it is, and
                            the fold — set like every other heading here. */}
                        {group.items.length > 1 && (groups.length > 1 || group.title !== 'Downloads') ? (
                          <div className="flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[2px]">
                            <h4 className="min-w-0 truncate text-body font-semibold text-ink">{group.title}</h4>
                            {groups.length > 1 ? (
                              <span className="value shrink-0 text-small text-muted">
                                {doneCount} von {group.items.length} geladen
                                {activeCount > 0 ? ` · ${activeCount} laufen` : ''}
                                {errorCount > 0 ? ` · ${errorCount} mit Fehler` : ''}
                              </span>
                            ) : null}
                          </div>
                        ) : null}

                        {/* Items List */}
                        <ol className="flex flex-col divide-y divide-line">
                          {visibleItems.map(({ entry }) => {
                            const stream =
                              entry.result?.streams.find((s) => s.id === entry.selectedStreamId) ||
                              entry.result?.streams[0]

                            return (
                              <li
                                key={entry.id}
                                className="flex max-w-none flex-col gap-[8px] py-[12px]"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-[8px]">
                                  <div className="min-w-0 flex-1">
                                    {entry.result ? (
                                      <p className="truncate text-body font-medium text-ink">
                                        {stealthMode !== 'off'
                                          ? filenameFor(entry.result, stream || entry.result.streams[0], {
                                              mode: stealthMode,
                                            })
                                          : entry.result.title}
                                      </p>
                                    ) : (
                                      <p className="truncate text-body font-medium text-ink">
                                        {entry.titleHint || entry.url}
                                      </p>
                                    )}
                                    {entry.result && stealthMode === 'off' ? (
                                      <p className="value text-small text-muted">
                                        {[
                                          entry.result.author,
                                          entry.result.durationSeconds
                                            ? formatDuration(entry.result.durationSeconds)
                                            : null,
                                        ]
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
                                          onClick={() => void takeBatchItem(entry.id)}
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
                                              patchEntry(entry.id, { selectedStreamId: val })
                                            }}
                                            className="w-auto! max-w-[280px] py-[6px]"
                                          >
                                            {entry.result.streams.map((s) => (
                                              <option key={s.id} value={s.id}>
                                                {s.label} ({s.ext.toUpperCase()}
                                                {s.bytes ? ` · ${formatBytes(s.bytes)}` : ''})
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
                                          onClick={() => void takeBatchItem(entry.id)}
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
                                          onClick={() =>
                                            saveBytes(entry.taken!.bytes, entry.taken!.name, entry.taken!.mime)
                                          }
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
                                        onClick={() => void takeBatchItem(entry.id)}
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
                                    value={
                                      entry.progress.total
                                        ? entry.progress.loaded / entry.progress.total
                                        : null
                                    }
                                    label={`${formatBytes(entry.progress.loaded)}${
                                      entry.progress.total ? ` von ${formatBytes(entry.progress.total)}` : ''
                                    }`}
                                  />
                                ) : null}
                              </li>
                            )
                          })}
                        </ol>

                        {group.items.length > 3 ? (
                          <div className="border-t border-line">
                            <button
                              type="button"
                              aria-expanded={!isCollapsed}
                              onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group.id]: !isCollapsed }))}
                              className="press flex items-center gap-[8px] rounded-nav py-[10px] text-left text-small text-ink"
                            >
                              <span aria-hidden className="value">
                                {isCollapsed ? '+' : '−'}
                              </span>
                              {isCollapsed ? `${hidden} weitere zeigen` : 'Auf drei einklappen'}
                            </button>
                          </div>
                        ) : null}
                      </section>
                    )
                  })}
                </div>
              </>
            )
          })()}
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
        {/* Which way the field takes, folded, with the ways themselves —
            under the field it was one more line about the same thing as
            this section. */}
        <Reveal label="Welche Wege das Feld oben probiert">
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
        {/* Always mounted: the service connection and the setup dialog live in
            here, and the buttons above and in the error notice reach them. */}
        <div hidden={!waysOpen}>
          <AdvancedDownloader url={url} />
        </div>
      </section>
    </div>
  )
}
