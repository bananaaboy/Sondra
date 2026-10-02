/**
 * The media player: watching and listening, nothing else.
 *
 * Everything else in Sondra reads a file into memory, because everything else
 * changes it. Playing does not need that. An object URL on the picked File
 * lets the browser read from disk as it plays, the way a desktop player does,
 * so a two-hour film costs no more memory than a song — and a file dropped on
 * the player is not taken into the session for the same reason.
 *
 * What the browser cannot decode is handed to `lib/playable.ts`, the same
 * stand-in the video editor makes, only larger: here the picture is the point.
 */

export type PlayerKind = 'video' | 'audio'

export interface PlayerItem {
  id: string
  name: string
  size: number
  kind: PlayerKind
  /** The picked File, or a session file. Read where it lies. */
  source: Blob
  /** Subtitles for this item, already WebVTT, as object URLs. */
  subtitles: { label: string; url: string }[]
  /** Set when the item came from the session rather than from disk. */
  assetId?: string
}

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ts|mts|m2ts|mpg|mpeg|vob|3gp|ogv|asf)$/i
const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aiff?|ac3|mka|amr|caf)$/i
const SUBTITLE_EXTENSIONS = /\.(srt|vtt)$/i

export function playerKind(file: { name: string; type: string }): PlayerKind | null {
  if (file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name)) return 'video'
  if (file.type.startsWith('audio/') || AUDIO_EXTENSIONS.test(file.name)) return 'audio'
  return null
}

export const isSubtitleFile = (file: { name: string }) => SUBTITLE_EXTENSIONS.test(file.name)

export const PLAYER_ACCEPT =
  'video/*,audio/*,.mkv,.avi,.wmv,.flv,.ts,.mts,.m2ts,.mpg,.mpeg,.vob,.flac,.opus,.m4a,.wma,.ac3,.mka,.srt,.vtt'

/** The name without its extension, lower case — how a film finds its subtitles. */
export const stemOf = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase()

/** SubRip to WebVTT: a header, and dots instead of commas in the times. */
export function srtToVtt(text: string): string {
  const body = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return body.trimStart().startsWith('WEBVTT') ? body : `WEBVTT\n\n${body.trim()}\n`
}

export async function subtitleUrl(file: File): Promise<string> {
  const text = await file.text()
  const vtt = /\.vtt$/i.test(file.name) ? text : srtToVtt(text)
  return URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
}

/* -------------------------------------------------------------------------- */
/* Where a drop goes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * While the player is open, files dropped or pasted anywhere on the window
 * are its, not the session's: taking a film into the session reads it whole
 * into memory, which is exactly what the player exists to avoid.
 */
let inbox: ((files: File[]) => void) | null = null

export function claimDrops(handler: ((files: File[]) => void) | null): void {
  inbox = handler
}

export function playerInbox(): ((files: File[]) => void) | null {
  return inbox
}

/* -------------------------------------------------------------------------- */
/* Remembered on this device — conveniences, never needed                      */
/* -------------------------------------------------------------------------- */

const PLACES_KEY = 'sondra:abspielen:stellen'
const SETTINGS_KEY = 'sondra:abspielen'

const placeKey = (item: { name: string; size: number }) => `${item.name}|${item.size}`

function readPlaces(): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(PLACES_KEY) ?? '{}')
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

/** Where a file was left, when that is worth coming back to. */
export function rememberedPlace(item: { name: string; size: number }): number | null {
  const seconds = readPlaces()[placeKey(item)]
  return typeof seconds === 'number' && seconds > 0 ? seconds : null
}

/** Remembers where a file was left; null forgets it. The newest fifty stay. */
export function rememberPlace(item: { name: string; size: number }, seconds: number | null): void {
  try {
    const places = readPlaces()
    delete places[placeKey(item)]
    if (seconds !== null) places[placeKey(item)] = Math.round(seconds)
    localStorage.setItem(PLACES_KEY, JSON.stringify(Object.fromEntries(Object.entries(places).slice(-50))))
  } catch {
    /* only a convenience */
  }
}

export interface PlayerSettings {
  volume: number
  muted: boolean
  rate: number
}

export function rememberedSettings(): PlayerSettings {
  const fallback = { volume: 1, muted: false, rate: 1 }
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object') return fallback
    return {
      volume: typeof saved.volume === 'number' ? Math.min(1, Math.max(0, saved.volume)) : 1,
      muted: saved.muted === true,
      rate: RATES.includes(saved.rate) ? saved.rate : 1,
    }
  } catch {
    return fallback
  }
}

export function rememberSettings(settings: PlayerSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* only a preference */
  }
}

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

/** h:mm:ss or m:ss — a film's clock, not the editor's centiseconds. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}
