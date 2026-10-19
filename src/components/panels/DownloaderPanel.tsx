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
import { extractAddresses, isAniworldUrl, isHlsPlaylistText, isPortalUrl, isSupportedUrl, saveBytes } from '../../lib/download'
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
import { openGetAppDialog } from '../GetApp'
import { createZip, uniqueEntryNames } from '../../lib/zip'
import { ZipSave } from '../ZipSave'

export type AudioOutputFormat = 'original' | 'mp3' | 'wav' | 'm4a' | 'flac' | 'opus'

export type VideoFilePref = 'untouched' | 'best' | '1080p' | '720p' | '480p' | '360p'
export type VideoAdaptMode = 'stream_only' | 'reencode_lower'
export type AudioFilePref = 'untouched' | 'high' | 'medium' | 'low' | 'lossless'
export type DirectFilePref = 'untouched' | 'apply_media_prefs'
export type DownloadDeliveryMode = 'session_only' | 'session_and_save' | 'save_only'
export type AniworldLanguagePref = 'auto' | 'ger_sub' | 'ger_dub' | 'eng_sub'

export interface DownloadFilePreferences {
  videoPref: VideoFilePref
  videoAdaptMode: VideoAdaptMode
  audioPref: AudioFilePref
  directPref: DirectFilePref
  deliveryMode: DownloadDeliveryMode
  aniworldLanguage: AniworldLanguagePref
}

const DEFAULT_DOWNLOAD_PREFS: DownloadFilePreferences = {
  videoPref: 'untouched',
  videoAdaptMode: 'stream_only',
  audioPref: 'high',
  directPref: 'untouched',
  deliveryMode: 'session_only',
  aniworldLanguage: 'auto',
}

const DOWNLOAD_PREFS_KEY = 'sondra:download_prefs'

function loadDownloadPrefs(): DownloadFilePreferences {
  try {
    const raw = localStorage.getItem(DOWNLOAD_PREFS_KEY)
    if (!raw) return DEFAULT_DOWNLOAD_PREFS
    const parsed = JSON.parse(raw) as Partial<DownloadFilePreferences>
    return { ...DEFAULT_DOWNLOAD_PREFS, ...parsed }
  } catch {
    return DEFAULT_DOWNLOAD_PREFS
  }
}

function saveDownloadPrefs(prefs: DownloadFilePreferences): void {
  try {
    localStorage.setItem(DOWNLOAD_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore storage errors */
  }
}

function targetHeightForVideoPref(pref: VideoFilePref): number | null {
  if (pref === '1080p') return 1080
  if (pref === '720p') return 720
  if (pref === '480p') return 480
  if (pref === '360p') return 360
  return null
}

function streamHeight(stream: StudioStream): number | null {
  if (typeof stream.height === 'number' && stream.height > 0) return stream.height
  const match = stream.label.match(/(2160|1440|1080|720|480|360|240|144)p/i)
  return match ? Number(match[1]) : null
}

const AUDIO_FORMAT_CONFIGS: { id: AudioOutputFormat; label: string; desc: string; ext: string; mime: string }[] = [
  { id: 'original', label: 'Original', desc: 'Gar nicht anpassen (Original-Tonspur direkt laden)', ext: 'm4a', mime: 'audio/mp4' },
  { id: 'mp3', label: 'MP3', desc: '320 kbps (Standard)', ext: 'mp3', mime: 'audio/mpeg' },
  { id: 'wav', label: 'WAV', desc: 'Verlustfrei (PCM)', ext: 'wav', mime: 'audio/wav' },
  { id: 'm4a', label: 'M4A', desc: 'AAC 256k (Apple / Mobile)', ext: 'm4a', mime: 'audio/mp4' },
  { id: 'flac', label: 'FLAC', desc: 'Verlustfrei komprimiert', ext: 'flac', mime: 'audio/flac' },
  { id: 'opus', label: 'OPUS', desc: '160k (Kompakt & Klar)', ext: 'opus', mime: 'audio/ogg' },
]

function SettingsGearIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-[15px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="10" cy="10" r="2.4" />
      <path d="M8.03 4.76L8.34 2.58A7.6 7.6 0 0 1 11.66 2.58L11.97 4.76A5.6 5.6 0 0 1 13.55 5.67L15.59 4.86A7.6 7.6 0 0 1 17.25 7.73L15.53 9.09A5.6 5.6 0 0 1 15.53 10.91L17.25 12.27A7.6 7.6 0 0 1 15.59 15.14L13.55 14.33A5.6 5.6 0 0 1 11.97 15.24L11.66 17.42A7.6 7.6 0 0 1 8.34 17.42L8.03 15.24A5.6 5.6 0 0 1 6.45 14.33L4.41 15.14A7.6 7.6 0 0 1 2.75 12.27L4.47 10.91A5.6 5.6 0 0 1 4.47 9.09L2.75 7.73A7.6 7.6 0 0 1 4.41 4.86L6.45 5.67A5.6 5.6 0 0 1 8.03 4.76Z" />
    </svg>
  )
}

interface StreamGroup {
  id: string
  title: string
  badge?: string
  isAudio: boolean
  streams: StudioStream[]
}

function groupStreams(streams: StudioStream[], videoPref: VideoFilePref = 'untouched', audioPref: AudioFilePref = 'high'): StreamGroup[] {
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

  // Deduplicate each group:
  // - Video resolution groups: pick ONE best stream per resolution (preferring muxed video+audio and MP4 container, then highest size)
  // - Audio group: deduplicate identical bitrates and keep at most 3 distinct quality tiers (Beste, Mittel, Kompakt)
  for (const group of groups.values()) {
    if (group.isAudio) {
      if (audioPref === 'low') {
        group.streams.sort((a, b) => (a.bytes ?? Number.MAX_SAFE_INTEGER) - (b.bytes ?? Number.MAX_SAFE_INTEGER))
      } else {
        group.streams.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
      }
      const seenBitrate = new Set<string>()
      const uniqueAudio: StudioStream[] = []
      for (const s of group.streams) {
        const br = s.label.match(/(\d+\s*kbit\/s)/i)?.[1]?.replace(/\s+/g, '') ?? `${s.ext}-${s.bytes ?? s.id}`
        if (seenBitrate.has(br)) continue
        seenBitrate.add(br)
        uniqueAudio.push(s)
      }
      if (uniqueAudio.length > 3) {
        const midIdx = Math.floor(uniqueAudio.length / 2)
        group.streams = [uniqueAudio[0], uniqueAudio[midIdx], uniqueAudio[uniqueAudio.length - 1]]
      } else {
        group.streams = uniqueAudio
      }
    } else {
      group.streams.sort((a, b) => {
        const audioDiff = (b.hasAudio ? 1 : 0) - (a.hasAudio ? 1 : 0)
        if (audioDiff !== 0) return audioDiff
        const mp4Diff = (b.ext.toLowerCase() === 'mp4' ? 1 : 0) - (a.ext.toLowerCase() === 'mp4' ? 1 : 0)
        if (mp4Diff !== 0) return mp4Diff
        return (b.bytes ?? 0) - (a.bytes ?? 0)
      })
      if (group.id !== 'video' && group.streams.length > 1) {
        group.streams = [group.streams[0]]
      }
    }
  }

  // Order groups descending by resolution, but place preferred resolution group first if specified
  const resOrder = ['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p', 'video', 'audio']
  const prefTarget = targetHeightForVideoPref(videoPref)
  return Array.from(groups.values()).sort((a, b) => {
    if (prefTarget !== null && !a.isAudio && !b.isAudio) {
      const hA = parseInt(a.id, 10)
      const hB = parseInt(b.id, 10)
      if (!Number.isNaN(hA) && !Number.isNaN(hB)) {
        const aFits = hA <= prefTarget
        const bFits = hB <= prefTarget
        if (aFits !== bFits) return aFits ? -1 : 1
        if (aFits && bFits) return hB - hA
        return hA - hB
      }
    }
    const idxA = resOrder.indexOf(a.id)
    const idxB = resOrder.indexOf(b.id)
    return (idxA === -1 ? 99 : idxA) - (idxB === -1 ? 99 : idxB)
  })
}

async function processDownloadedAudio(
  bytes: Uint8Array,
  inputExt: string,
  targetFormat: AudioOutputFormat,
  audioPref: AudioFilePref,
  hasVideo: boolean,
  meta: { title?: string | null; artist?: string | null; coverUrl?: string | null },
  signal?: AbortSignal,
  onStatus?: (status: string) => void,
): Promise<{ bytes: Uint8Array; ext: string; mime: string }> {
  const cleanInExt = (inputExt || 'mp4').replace(/^\./, '').toLowerCase()
  const mimeMap: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    opus: 'audio/ogg',
    ogg: 'audio/ogg',
    aac: 'audio/aac',
    webm: 'audio/webm',
  }

  // Untouched audio: if already audio-only, return 1:1 without FFmpeg re-encoding or altering bytes
  if (targetFormat === 'original' || audioPref === 'untouched') {
    if (!hasVideo) {
      return { bytes, ext: cleanInExt, mime: mimeMap[cleanInExt] || 'audio/mp4' }
    }
    // Source has video, extract audio stream without re-encoding if container matches, otherwise AAC
    await loadFfmpeg()
    const inName = `dl_in_${Date.now()}.${cleanInExt}`
    const copyExt = cleanInExt === 'webm' ? 'opus' : 'm4a'
    const copyOut = `dl_out_${Date.now()}.${copyExt}`
    onStatus?.('Original-Tonspur wird ohne Umrechnung herausgelöst …')
    try {
      const { files } = await runFfmpeg({
        input: { [inName]: bytes },
        output: [copyOut],
        args: ['-i', inName, '-vn', '-c:a', 'copy', copyOut],
        signal,
      })
      const copied = files[copyOut]
      if (copied && copied.byteLength > 0) {
        return { bytes: copied, ext: copyExt, mime: mimeMap[copyExt] || 'audio/mp4' }
      }
    } catch {
      /* fallback to standard extraction below */
    }
  }

  const effectiveFormat: Exclude<AudioOutputFormat, 'original'> =
    targetFormat === 'original' ? 'm4a' : targetFormat

  if (!hasVideo && cleanInExt === effectiveFormat && audioPref !== 'low' && audioPref !== 'medium') {
    const tagged = await tagAudioFile(bytes, cleanInExt, meta, signal)
    return { bytes: tagged, ext: cleanInExt, mime: mimeMap[cleanInExt] || 'audio/mp4' }
  }

  await loadFfmpeg()
  const inName = `dl_in_${Date.now()}.${cleanInExt}`
  const outExt = effectiveFormat
  const outName = `dl_out_${Date.now()}.${outExt}`

  const mp3Bitrate = audioPref === 'low' ? '128k' : audioPref === 'medium' ? '192k' : '320k'
  const aacBitrate = audioPref === 'low' ? '128k' : audioPref === 'medium' ? '192k' : '256k'
  const opusBitrate = audioPref === 'low' ? '96k' : audioPref === 'medium' ? '128k' : '160k'

  const args: string[] = ['-i', inName, '-vn']
  if (effectiveFormat === 'mp3') {
    args.push('-b:a', mp3Bitrate)
  } else if (effectiveFormat === 'm4a') {
    args.push('-c:a', 'aac', '-b:a', aacBitrate)
  } else if (effectiveFormat === 'flac') {
    args.push('-c:a', 'flac')
  } else if (effectiveFormat === 'opus') {
    args.push(...opusArgs(opusBitrate))
  } else if (effectiveFormat === 'wav') {
    // wav default PCM
  } else {
    args.push('-c:a', 'aac', '-b:a', aacBitrate)
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

  return { bytes: outBytes, ext: outExt, mime: mimeMap[outExt] || 'audio/mp4' }
}

async function reencodeVideoToTargetHeight(
  bytes: Uint8Array,
  inputExt: string,
  targetHeight: number,
  signal?: AbortSignal,
  onStatus?: (status: string) => void,
): Promise<{ bytes: Uint8Array; ext: string; mime: string }> {
  const cleanInExt = (inputExt || 'mp4').replace(/^\./, '').toLowerCase()
  await loadFfmpeg()
  const inName = `dl_vin_${Date.now()}.${cleanInExt}`
  const outName = `dl_vout_${Date.now()}.mp4`
  onStatus?.(`Video wird auf ${targetHeight}p angepasst …`)
  const { files } = await runFfmpeg({
    input: { [inName]: bytes },
    output: [outName],
    args: [
      '-i',
      inName,
      '-vf',
      `scale=-2:'min(${targetHeight},ih)'`,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      targetHeight <= 360 ? '26' : '24',
      '-c:a',
      'aac',
      '-b:a',
      targetHeight <= 360 ? '96k' : '128k',
      '-movflags',
      '+faststart',
      outName,
    ],
    signal,
  })
  const outBytes = files[outName]
  if (!outBytes || outBytes.byteLength === 0) {
    return { bytes, ext: cleanInExt, mime: 'video/mp4' }
  }
  return { bytes: outBytes, ext: 'mp4', mime: 'video/mp4' }
}

function NotLocalNotice() {
  const [open, setOpen] = useState(false)
  return (
    <div role="note" className="rounded-nav bg-panel-cool px-[12px] py-[8px] ring-1 ring-inset ring-rule">
      <div className="flex flex-wrap items-center justify-between gap-x-[12px] gap-y-[4px] text-small">
        <span className="flex items-center gap-[8px] text-ink">
          <svg viewBox="0 0 16 16" className="size-[15px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 1.6l6.2 10.8H1.8zM8 6.2v3.1M8 11.2h.01" />
          </svg>
          <span className="font-semibold">Herunterladen läuft über einen Dienst</span>
          <span className="text-muted">· Bitte nur laden, was erlaubt ist.</span>
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
        >
          {open ? 'Weniger' : 'Hinweis'}
        </button>
      </div>
      {open ? (
        <ul className="mt-[8px] grid gap-x-[20px] gap-y-[6px] border-t border-line pt-[8px] text-small leading-[1.45] text-prose sm:grid-cols-3 [&_li]:max-w-none">
          <li>
            Die Adresse geht an einen Dienst dieser Seite. Ihre lokalen Dateien sieht er nie.
          </li>
          <li>
            Gespeichert wird dort nichts; alles Weitere passiert wieder lokal im Tab.
          </li>
          <li className="font-semibold text-ink">
            Ich hafte dafür absolut nicht. Laden Sie nur herunter, was Sie herunterladen dürfen. Kopierschutz wird nicht umgangen.
          </li>
        </ul>
      ) : null}
    </div>
  )
}

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
  const [open, setOpen] = useState(false)
  return (
    <div role="note" className="rounded-nav bg-panel-soft px-[12px] py-[8px] ring-1 ring-inset ring-rule">
      <div className="flex flex-wrap items-center justify-between gap-x-[12px] gap-y-[4px] text-small">
        <span className="text-prose">
          <strong className="font-semibold text-ink">Direkt über diesen Rechner (yt-dlp)</strong> · Bitte nur laden, was Sie herunterladen dürfen.
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
        >
          {open ? 'Weniger' : 'Hinweis'}
        </button>
      </div>
      {open ? (
        <p className="mt-[6px] border-t border-line pt-[6px] text-small leading-[1.45] text-prose">
          Sondra fragt die Seite direkt auf diesem Rechner an, ohne fremden Server dazwischen. Ich hafte dafür absolut nicht; Kopierschutz wird nicht umgangen.
        </p>
      ) : null}
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

  const [filePrefs, setFilePrefs] = useState<DownloadFilePreferences>(loadDownloadPrefs)
  const filePrefsRef = useRef<DownloadFilePreferences>(filePrefs)
  filePrefsRef.current = filePrefs

  const updateFilePrefs = useCallback((patch: Partial<DownloadFilePreferences>) => {
    setFilePrefs((prev) => {
      const next = { ...prev, ...patch }
      filePrefsRef.current = next
      saveDownloadPrefs(next)
      return next
    })
  }, [])

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

  /** The stream an entry starts with: respects the per-file-type quality and adaptation preferences. */
  const defaultStream = (res: StudioResult) => {
    const prefs = filePrefsRef.current
    const audioStreams = res.streams.filter((s) => !s.hasVideo && s.hasAudio)
    const videoWithAudio = res.streams.filter((s) => s.hasVideo && s.hasAudio)
    const lowestVideoWithAudio = [...videoWithAudio].sort((a, b) => (streamHeight(a) ?? 9999) - (streamHeight(b) ?? 9999))[0]

    if (filterAudioOnlyRef.current) {
      if (prefs.audioPref === 'low') {
        const smallestAudio = [...audioStreams].sort((a, b) => (a.bytes ?? 999999999) - (b.bytes ?? 999999999))[0]
        return smallestAudio || lowestVideoWithAudio || res.streams[0]
      }
      const bestAudio = [...audioStreams].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))[0]
      return bestAudio || lowestVideoWithAudio || res.streams[0]
    }

    const targetHeight = targetHeightForVideoPref(prefs.videoPref)
    if (!targetHeight) {
      return videoWithAudio[0] || res.streams[0]
    }

    const candidates = videoWithAudio.length > 0 ? videoWithAudio : res.streams.filter((s) => s.hasVideo)
    const matchingOrBelow = [...candidates]
      .filter((s) => (streamHeight(s) ?? 0) > 0 && (streamHeight(s) ?? 0) <= targetHeight)
      .sort((a, b) => (streamHeight(b) ?? 0) - (streamHeight(a) ?? 0))
    if (matchingOrBelow.length > 0) return matchingOrBelow[0]
    const lowest = [...candidates].sort((a, b) => (streamHeight(a) ?? 9999) - (streamHeight(b) ?? 9999))[0]
    return lowest || videoWithAudio[0] || res.streams[0]
  }

  useEffect(() => {
    updateBatch((list) =>
      list.map((entry) => {
        if (entry.status !== 'ready' || !entry.result) return entry
        const best = defaultStream(entry.result)
        return best ? { ...entry, selectedStreamId: best.id } : entry
      }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterAudioOnly, filePrefs.videoPref, filePrefs.audioPref])

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
        const found = await resolveViaService(targets[0], controller.signal, {
          language: filePrefsRef.current.aniworldLanguage,
        })
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
        const res = await resolveViaService(entry.url, signal, {
          language: filePrefsRef.current.aniworldLanguage,
        })
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
    const prefs = filePrefsRef.current
    const assembled = isHlsStream(stream)
    const meta = { title: res.title, artist: res.author, coverUrl: res.thumbnail }
    let finalBytes = bytes
    let finalExt = assembled ? 'mp4' : stream.ext
    let finalMime = assembled ? 'video/mp4' : stream.mime
    let finalKind = assembled ? ('video' as const) : kindFromMime(stream.mime, stream.label)

    // When a direct file link is set to "Gar nicht anpassen" (untouched) and not forced into audio extraction, keep 1:1.
    const isDirectUntouched = res.source === 'direct' && prefs.directPref === 'untouched' && !filterAudioOnlyRef.current

    if (!isDirectUntouched) {
      if (filterAudioOnlyRef.current) {
        if (prefs.audioPref === 'untouched' && !assembled && !stream.hasVideo) {
          finalKind = 'audio'
        } else {
          const targetLabel =
            targetAudioFormatRef.current === 'original'
              ? 'Original-Tonspur'
              : targetAudioFormatRef.current.toUpperCase()
          onStatus?.(`Wandle in ${targetLabel} um …`)
          const audioRes = await processDownloadedAudio(
            bytes,
            finalExt,
            targetAudioFormatRef.current,
            prefs.audioPref,
            assembled || stream.hasVideo,
            meta,
            signal,
            onStatus,
          )
          finalBytes = audioRes.bytes
          finalExt = audioRes.ext
          finalMime = audioRes.mime
          finalKind = 'audio'
        }
      } else if (!stream.hasVideo && stream.hasAudio && !assembled) {
        if (prefs.audioPref !== 'untouched') {
          if (prefs.audioPref === 'low' || prefs.audioPref === 'medium') {
            const audioRes = await processDownloadedAudio(
              bytes,
              finalExt,
              targetAudioFormatRef.current === 'original' ? 'mp3' : targetAudioFormatRef.current,
              prefs.audioPref,
              false,
              meta,
              signal,
              onStatus,
            )
            finalBytes = audioRes.bytes
            finalExt = audioRes.ext
            finalMime = audioRes.mime
            finalKind = 'audio'
          } else {
            finalBytes = await tagAudioFile(bytes, stream.ext, meta, signal)
          }
        }
      } else if ((stream.hasVideo || assembled) && prefs.videoPref !== 'untouched' && prefs.videoPref !== 'best') {
        const targetHeight = targetHeightForVideoPref(prefs.videoPref) ?? 0
        const currentHeight = streamHeight(stream) ?? 0
        if (
          prefs.videoAdaptMode === 'reencode_lower' &&
          targetHeight > 0 &&
          (currentHeight === 0 || currentHeight > targetHeight)
        ) {
          const videoRes = await reencodeVideoToTargetHeight(finalBytes, finalExt, targetHeight, signal, onStatus)
          finalBytes = videoRes.bytes
          finalExt = videoRes.ext
          finalMime = videoRes.mime
          finalKind = 'video'
        }
      }
    }

    let name = filenameFor(res, assembled ? { ...stream, ext: finalExt } : { ...stream, ext: finalExt }, {
      mode: stealthModeRef.current,
    })
    if (filterAudioOnlyRef.current || finalExt !== stream.ext) {
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
      const delivery = filePrefsRef.current.deliveryMode

      if (delivery !== 'save_only') {
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
      }
      if (delivery === 'session_and_save' || delivery === 'save_only') {
        saveBytes(done.bytes, done.name, done.mime)
      }
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
      const delivery = filePrefsRef.current.deliveryMode

      if (delivery !== 'save_only') {
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
      }
      if (delivery === 'session_and_save' || delivery === 'save_only') {
        saveBytes(done.bytes, done.name, done.mime)
      }
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

  const videoPrefLabel =
    filePrefs.videoPref === 'untouched'
      ? 'Video unverändert'
      : filePrefs.videoPref === 'best'
        ? 'Video beste Quali'
        : `Video ${filePrefs.videoPref}`

  const audioPrefLabel =
    filePrefs.audioPref === 'untouched'
      ? 'Ton unverändert'
      : filePrefs.audioPref === 'low'
        ? 'Ton tiefere Quali'
        : filePrefs.audioPref === 'medium'
          ? 'Ton Standard'
          : filePrefs.audioPref === 'lossless'
            ? 'Ton verlustfrei'
            : 'Ton hohe Quali'

  const isAniworldTarget =
    isAniworldUrl(url) ||
    result?.source === 'aniworld' ||
    Boolean(batchEntries?.some((e) => isAniworldUrl(e.url)))

  const aniworldLangSummary =
    filePrefs.aniworldLanguage === 'ger_sub'
      ? 'AniWorld: Ger-Sub (OmU)'
      : filePrefs.aniworldLanguage === 'ger_dub'
        ? 'AniWorld: Ger-Dub'
        : filePrefs.aniworldLanguage === 'eng_sub'
          ? 'AniWorld: Eng-Sub'
          : 'AniWorld: Sprache Auto'

  // The folded settings, said: what is in force without opening them.
  const settingsSummary = [
    videoPrefLabel,
    audioPrefLabel,
    filePrefs.directPref === 'untouched' ? 'Direktdateien 1:1' : 'Direktdateien anpassen',
    ...(isAniworldTarget ? [aniworldLangSummary] : []),
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
        <div className="mt-[8px] mb-[12px] flex flex-wrap items-center justify-between gap-[12px]">
          <h2 className="display-md">Ein Video oder Lied von einer Adresse</h2>
          <Button
            type="button"
            size="sm"
            variant={settingsOpen ? 'primary' : 'quiet'}
            aria-expanded={settingsOpen}
            aria-controls="download-settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <SettingsGearIcon />
            Einstellungen
          </Button>
        </div>

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
                hidden
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
                title={settingsSummary}
                className="press flex items-center gap-[6px] rounded-nav text-left text-small text-muted hover:text-ink sm:ml-auto"
              >
                <span>{filterAudioOnly ? audioPrefLabel : videoPrefLabel}</span>
                <span className="text-ink underline decoration-rule underline-offset-[3px]">
                  {settingsOpen ? 'Schliessen' : 'Anpassen'}
                </span>
              </button>
            </div>
            {filterAudioOnly ? (
              <span className="text-small leading-[1.45] text-muted">
                {AUDIO_FORMAT_CONFIGS.find((format) => format.id === targetAudioFormat)?.desc}.{' '}
                {filePrefs.audioPref === 'untouched' || targetAudioFormat === 'original'
                  ? 'Die Datei wird nach Möglichkeit direkt und unverändert übernommen.'
                  : 'Die Tonspur wird herausgelöst und in der gewählten Qualitätsstufe gespeichert.'}
              </span>
            ) : null}

            {isAniworldTarget ? (
              <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px] rounded-nav bg-panel-soft px-[12px] py-[8px] ring-1 ring-inset ring-rule">
                <span className="flex items-center gap-[6px] text-small font-semibold text-ink">
                  <span aria-hidden className="size-[7px] shrink-0 rounded-pill bg-ink" />
                  AniWorld Sprache
                </span>
                <ChoiceRow
                  value={filePrefs.aniworldLanguage}
                  options={[
                    { value: 'auto', label: 'Auto (Standard)', title: 'Automatisch beste verfügbare Fassung (Deutsch bevorzugt)' },
                    { value: 'ger_sub', label: 'Ger-Sub (OmU)', title: 'Japanischer Originalton mit deutschem Untertitel' },
                    { value: 'ger_dub', label: 'Ger-Dub', title: 'Deutsche Synchronisation' },
                    { value: 'eng_sub', label: 'Eng-Sub', title: 'Japanischer Originalton mit englischem Untertitel' },
                  ]}
                  onChange={(val) => {
                    const nextLang = val as AniworldLanguagePref
                    updateFilePrefs({ aniworldLanguage: nextLang })
                    if (result || batchEntries) void look()
                  }}
                />
              </div>
            ) : null}

            <div
              id="download-settings"
              hidden={!settingsOpen}
              className="mt-[4px] grid gap-x-[24px] gap-y-[14px] rounded-card border border-line bg-raised p-[16px] sm:grid-cols-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-[8px] border-b border-line pb-[10px] sm:col-span-2">
                <div>
                  <h3 className="text-subheading text-ink">Download-Einstellungen für Dateitypen</h3>
                  <p className="text-small text-muted">
                    Legen Sie für verschiedene Dateien fest, ob sie in tieferer Qualität geladen oder gar nicht angepasst und direkt heruntergeladen werden sollen.
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-[8px]">
                <label htmlFor="video-pref-select" className="text-small font-medium text-ink">
                  Video-Dateien (MP4, WebM, Streams)
                </label>
                <Select
                  id="video-pref-select"
                  value={filePrefs.videoPref}
                  onChange={(e) => updateFilePrefs({ videoPref: e.target.value as VideoFilePref })}
                >
                  <option value="untouched">Gar nicht anpassen — einfach direkt herunterladen (Original)</option>
                  <option value="best">Beste verfügbare Qualität (bis 4K / 1080p)</option>
                  <option value="1080p">Standard Full-HD (1080p bevorzugt)</option>
                  <option value="720p">Mittlere Qualität (720p HD — spart Speicher)</option>
                  <option value="480p">Tiefere Qualität (480p Kompakt — schnelle Downloads)</option>
                  <option value="360p">Minimale Qualität (360p — kleinste Datei)</option>
                </Select>
                {filePrefs.videoPref !== 'untouched' && filePrefs.videoPref !== 'best' ? (
                  <div className="flex flex-col gap-[4px] pt-[2px]">
                    <span className="text-small text-muted">Wenn die Quelle nur in höherer Auflösung vorliegt:</span>
                    <ChoiceRow
                      value={filePrefs.videoAdaptMode}
                      options={[
                        { value: 'stream_only', label: 'Nur passende Spur wählen (ohne Neucodierung)' },
                        { value: 'reencode_lower', label: `Aktiv auf ${filePrefs.videoPref} verkleinern` },
                      ]}
                      onChange={(mode) => updateFilePrefs({ videoAdaptMode: mode as VideoAdaptMode })}
                    />
                  </div>
                ) : (
                  <span className="text-small leading-[1.45] text-muted">
                    {filePrefs.videoPref === 'untouched'
                      ? 'Videos werden ohne Qualitätsänderung oder Konvertierung genau so geladen, wie die Quelle sie liefert.'
                      : 'Wählt automatisch die höchste verfügbare Video-Auflösung.'}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-[8px]">
                <label htmlFor="audio-pref-select" className="text-small font-medium text-ink">
                  Ton- & Musik-Dateien (MP3, M4A, Opus, WAV)
                </label>
                <Select
                  id="audio-pref-select"
                  value={filePrefs.audioPref}
                  onChange={(e) => {
                    const nextPref = e.target.value as AudioFilePref
                    updateFilePrefs({ audioPref: nextPref })
                    if (nextPref === 'untouched') {
                      setTargetAudioFormat('original')
                    } else if (nextPref === 'lossless' && targetAudioFormat !== 'wav' && targetAudioFormat !== 'flac') {
                      setTargetAudioFormat('flac')
                    }
                  }}
                >
                  <option value="untouched">Gar nicht anpassen — Original-Audiodatei direkt laden</option>
                  <option value="high">Hohe Qualität (320 kbps / beste Tonspur)</option>
                  <option value="medium">Mittlere Qualität (192 kbps — ausgewogen)</option>
                  <option value="low">Tiefere Qualität (128 kbps — kleine Datei, ideal für Sprache)</option>
                  <option value="lossless">Verlustfrei (WAV / FLAC ohne Qualitätsverlust)</option>
                </Select>
                <span className="text-small leading-[1.45] text-muted">
                  {filePrefs.audioPref === 'untouched'
                    ? 'Audiodateien werden gar nicht umgewandelt oder neu getaggt, sondern 1:1 heruntergeladen.'
                    : filePrefs.audioPref === 'low'
                      ? 'Bevorzugt kleinere Tonspuren und komprimiert auf 128 kbit/s für geringen Speicherplatz.'
                      : filePrefs.audioPref === 'medium'
                        ? 'Konvertiert auf 192 kbit/s für gute Qualität bei moderater Dateigröße.'
                        : filePrefs.audioPref === 'lossless'
                          ? 'Speichert unkomprimiert bzw. verlustfrei als FLAC oder WAV.'
                          : 'Nutzt 320 kbit/s bzw. die höchste verfügbare Bitrate inklusive Cover & Metadaten.'}
                </span>
              </div>

              <div className="flex flex-col gap-[8px] border-t border-line pt-[10px]">
                <label htmlFor="direct-pref-select" className="text-small font-medium text-ink">
                  Direkte Datei-Links & andere Dateien
                </label>
                <Select
                  id="direct-pref-select"
                  value={filePrefs.directPref}
                  onChange={(e) => updateFilePrefs({ directPref: e.target.value as DirectFilePref })}
                >
                  <option value="untouched">Gar nicht anpassen — immer 1:1 direkt herunterladen</option>
                  <option value="apply_media_prefs">Obige Qualitäts- und Formatregeln auch auf Direktlinks anwenden</option>
                </Select>
                <span className="text-small leading-[1.45] text-muted">
                  {filePrefs.directPref === 'untouched'
                    ? 'Direkte Links auf .mp3-, .mp4-, .wav- oder andere Dateien werden ohne jede Anpassung heruntergeladen.'
                    : 'Auch direkte Datei-Links werden gemäss Ihren Video- und Ton-Vorgaben angepasst.'}
                </span>
              </div>

              <div className="flex flex-col gap-[8px] border-t border-line pt-[10px]">
                <label htmlFor="delivery-mode-select" className="text-small font-medium text-ink">
                  Verhalten beim Herunterladen
                </label>
                <Select
                  id="delivery-mode-select"
                  value={filePrefs.deliveryMode}
                  onChange={(e) => updateFilePrefs({ deliveryMode: e.target.value as DownloadDeliveryMode })}
                >
                  <option value="session_only">In die Sondra-Sitzung legen (zum Weiterbearbeiten oder Speichern)</option>
                  <option value="session_and_save">Sofort als Datei speichern & zusätzlich in die Sitzung legen</option>
                  <option value="save_only">Einfach direkt als Datei herunterladen (ohne Sitzung)</option>
                </Select>
                <span className="text-small leading-[1.45] text-muted">
                  {filePrefs.deliveryMode === 'save_only'
                    ? 'Speichert die Datei sofort im Download-Ordner, ohne sie in die Sitzung zu laden.'
                    : filePrefs.deliveryMode === 'session_and_save'
                      ? 'Lädt die Datei gleichzeitig in Ihren Download-Ordner und in die aktuelle Sitzung.'
                      : 'Legt die geladene Datei bereit für alle Werkzeuge in Sondra.'}
                </span>
              </div>

              <div className="flex flex-col gap-[8px] border-t border-line pt-[10px]">
                <label htmlFor="stealth-mode-select" className="text-small font-medium text-ink">
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

              <div className="flex flex-col justify-center border-t border-line pt-[10px]">
                <Toggle
                  label="Untertitel dazu erstellen"
                  hint="Nach dem Laden schreibt Whisper auf diesem Gerät mit, als .srt neben der Datei."
                  checked={autoTranscribe}
                  onChange={setAutoTranscribe}
                />
              </div>

              {isAniworldTarget ? (
                <div className="flex flex-col gap-[8px] border-t border-line pt-[10px] sm:col-span-2">
                  <label htmlFor="aniworld-language-select" className="flex items-center gap-[6px] text-small font-semibold text-ink">
                    <span aria-hidden className="size-[7px] shrink-0 rounded-pill bg-ink" />
                    AniWorld &amp; SerienStream Sprachfassung
                  </label>
                  <Select
                    id="aniworld-language-select"
                    value={filePrefs.aniworldLanguage}
                    onChange={(e) => {
                      const nextLang = e.target.value as AniworldLanguagePref
                      updateFilePrefs({ aniworldLanguage: nextLang })
                      if (result || batchEntries) void look()
                    }}
                  >
                    <option value="auto">Automatisch — Bevorzugt deutsche Synchronisation (Ger-Dub) oder Untertitel (Ger-Sub)</option>
                    <option value="ger_sub">Deutsch Sub (Ger-Sub / OmU — Japanischer Originalton mit deutschem Untertitel)</option>
                    <option value="ger_dub">Deutsch Dub (Ger-Dub — Deutsche Synchronfassung)</option>
                    <option value="eng_sub">Englisch Sub (Eng-Sub — Japanischer Originalton mit englischem Untertitel)</option>
                  </Select>
                  <span className="text-small leading-[1.45] text-muted">
                    Bestimmt die bevorzugte Sprachfassung für diesen Anime. Falls die gewünschte Fassung nicht existiert, wird automatisch die nächstbeste Fassung gewählt.
                  </span>
                </div>
              ) : null}

              {IN_DESKTOP_APP ? (
                <div className="flex flex-col gap-[8px] border-t border-line pt-[10px] sm:col-span-2">
                  <label htmlFor="adapter-select" className="text-small font-medium text-ink">
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
            <p className="leading-[1.5]">{error.message}</p>
            <div className="mt-[10px]">
              <p className="text-small font-semibold text-ink">Warum klappt der direkte Download hier nicht?</p>
              <p className="mt-[2px] text-small leading-[1.5] text-prose">
                YouTube verlangt eine Anmeldung und lässt Abrufe von Webseiten und externen Servern nicht durch.
                Damit YouTube-Downloads funktionieren, wählen Sie einen der folgenden Wege:
              </p>
              <div className="mt-[10px] flex flex-wrap gap-[8px]">
                <button
                  type="button"
                  onClick={openGetAppDialog}
                  className="press inline-flex items-center gap-[6px] rounded-nav bg-ink px-[12px] py-[6px] text-small font-medium text-on-ink hover:opacity-90"
                >
                  Sondra Windows-App herunterladen (Empfohlen)
                  <ArrowRight />
                </button>
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
              <p className="mt-[6px] text-small text-muted">
                {result.source === 'service'
                  ? serviceConnection().info?.version.includes('in Sondra')
                    ? 'Über yt-dlp auf diesem Rechner'
                    : 'Über den Dienst, den Sie verbunden haben'
                  : result.source === 'provider'
                    ? 'Über den hinterlegten Anbieter'
                    : result.source === 'youtube'
                    ? 'YouTube direkt'
                    : result.source === 'aniworld'
                    ? 'AniWorld / SerienStream direkt'
                    : 'Direkte Datei-Adresse'}
              </p>
            </div>
          </div>

          <div className="mt-[14px] flex flex-col">
            {(() => {
              const hasPureAudio = result.streams.some((s) => !s.hasVideo && s.hasAudio)
              const hasVideoStreams = result.streams.some((s) => s.hasVideo)
              const displayedStreams = filterAudioOnly
                ? hasPureAudio
                  ? result.streams.filter((s) => !s.hasVideo && s.hasAudio)
                  : result.streams
                : hasVideoStreams
                  ? result.streams.filter((s) => s.hasVideo)
                  : result.streams

              const groups = groupStreams(displayedStreams, filePrefs.videoPref, filePrefs.audioPref)
              const rows = groups.flatMap((group, groupIndex) =>
                group.streams.map((stream, streamIndex) => {
                  const audioTierLabel =
                    group.isAudio && group.streams.length > 1
                      ? streamIndex === 0
                        ? filePrefs.audioPref === 'low'
                          ? 'Kompakt'
                          : 'Beste Qualität'
                        : streamIndex === group.streams.length - 1
                          ? filePrefs.audioPref === 'low'
                            ? 'Beste Qualität'
                            : 'Kompakt'
                          : 'Mittlere Qualität'
                      : null
                  return {
                    group,
                    stream,
                    best: groupIndex === 0 && streamIndex === 0 && (groups.length > 1 || group.streams.length > 1),
                    audioTierLabel,
                  }
                }),
              )
              const visible = showAllStreams ? rows : rows.slice(0, STREAMS_SHOWN)
              return (
                <>
                  <ul className="flex flex-col divide-y divide-line border-y border-line">
                    {visible.map(({ group, stream, best, audioTierLabel }) => {
                      const bitrate = stream.label.match(/(\d+\s*kbit\/s)/i)?.[1] ?? null
                      const detail = [
                        filterAudioOnly
                          ? targetAudioFormat === 'original' || filePrefs.audioPref === 'untouched'
                            ? stream.ext.toUpperCase()
                            : targetAudioFormat.toUpperCase()
                          : stream.ext.toUpperCase(),
                        bitrate,
                        stream.bytes ? formatBytes(stream.bytes) : null,
                        filterAudioOnly && !group.isAudio ? 'Ton aus dem Video' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                      return (
                        <li key={stream.id} className="flex max-w-none items-center justify-between gap-[12px] py-[10px]">
                          <div className="min-w-0">
                            <p className="truncate text-body text-ink">
                              {group.isAudio ? (audioTierLabel ? `Ton · ${audioTierLabel}` : 'Ton') : group.title}
                              {best && !group.isAudio ? (
                                <span className="text-small text-muted">{' · empfohlen'}</span>
                              ) : null}
                            </p>
                            <p className="value truncate text-small text-muted">{detail}</p>
                          </div>
                          <Button size="sm" disabled={busy !== null} onClick={() => void take(stream)} className="shrink-0">
                            {busy === stream.label
                              ? 'Lädt …'
                              : filterAudioOnly
                                ? targetAudioFormat === 'original' || filePrefs.audioPref === 'untouched'
                                  ? 'Original laden'
                                  : `${targetAudioFormat.toUpperCase()} laden`
                                : 'Laden'}
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
                <span className="value">{taken.name}</span>{' '}
                {filePrefs.deliveryMode === 'save_only'
                  ? 'wurde direkt als Datei heruntergeladen.'
                  : filePrefs.deliveryMode === 'session_and_save'
                    ? 'wurde gespeichert und ist in der Sitzung bereit.'
                    : 'ist in der Sitzung — '}
                {filePrefs.deliveryMode === 'session_only' ? (
                  <span className="text-muted">oben im Dateimenü, bereit für jedes Werkzeug.</span>
                ) : null}
              </p>
              <Button size="sm" variant="quiet" onClick={() => saveBytes(taken.bytes, taken.name, taken.mime)}>
                {filePrefs.deliveryMode === 'session_only' ? 'Auch speichern' : 'Nochmals speichern'}
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
                                        {(() => {
                                          const dedupedBatchStreams = groupStreams(
                                            entry.result.streams,
                                            filePrefs.videoPref,
                                            filePrefs.audioPref,
                                          ).flatMap((g) => g.streams.map((s) => ({ group: g, stream: s })))
                                          if (dedupedBatchStreams.length > 1) {
                                            return (
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
                                                {dedupedBatchStreams.map(({ group: g, stream: s }) => (
                                                  <option key={s.id} value={s.id}>
                                                    {g.isAudio ? s.label : g.title} ({s.ext.toUpperCase()}
                                                    {s.bytes ? ` · ${formatBytes(s.bytes)}` : ''})
                                                  </option>
                                                ))}
                                              </Select>
                                            )
                                          }
                                          return stream ? (
                                            <span className="value text-small text-muted">
                                              {stream.ext.toUpperCase()}
                                              {stream.bytes ? ` · ${formatBytes(stream.bytes)}` : ''}
                                            </span>
                                          ) : null
                                        })()}

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
            {history.slice(0, 5).map((item) => (
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

      <section aria-label="Weitere Wege" className="flex flex-col gap-[12px] border-t border-line pt-[12px]">
        <Reveal label="Weitere Wege (Direktlink, lokale Brücke, eigener Dienst)">
          <div className="flex flex-col gap-[12px]">
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
            <div className="flex flex-col gap-[6px] text-small leading-[1.5] text-muted">
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
                    <button
                      type="button"
                      onClick={openGetAppDialog}
                      className="press font-medium underline hover:text-ink"
                    >
                      Sondra Windows-App
                    </button>{' '}
                    oder der lokalen yt-dlp-Brücke auf Ihrem PC.
                  </p>
                </>
              )}
            </div>
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
