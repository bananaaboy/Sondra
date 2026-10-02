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

export type CaptionSize = 'klein' | 'mittel' | 'gross'
export type Fit = 'contain' | 'cover' | 'fill'
export type Repeat = 'aus' | 'titel' | 'liste'

/** Everything the settings menu holds. Kept on this device, never needed. */
export interface PlayerSettings {
  volume: number
  muted: boolean
  rate: number
  captionSize: CaptionSize
  captionBackground: boolean
  fit: Fit
  brightness: number
  contrast: number
  saturation: number
  mirror: boolean
  /** Gain above the element's own 100 %, through Web Audio. */
  boost: number
  /** Quiet passages up, loud ones down — for watching at night. */
  night: boolean
  autoNext: boolean
  repeat: Repeat
  skip: number
}

export const DEFAULT_SETTINGS: PlayerSettings = {
  volume: 1,
  muted: false,
  rate: 1,
  captionSize: 'mittel',
  captionBackground: true,
  fit: 'contain',
  brightness: 1,
  contrast: 1,
  saturation: 1,
  mirror: false,
  boost: 1,
  night: false,
  autoNext: true,
  repeat: 'aus',
  skip: 10,
}

export const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3]
export const SKIPS = [5, 10, 15, 30]
export const BOOSTS = [1, 1.5, 2, 3]

const oneOf = <T,>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback)
const within = (value: unknown, low: number, high: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback

export function rememberedSettings(): PlayerSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object') return DEFAULT_SETTINGS
    const d = DEFAULT_SETTINGS
    return {
      volume: within(saved.volume, 0, 1, d.volume),
      muted: saved.muted === true,
      rate: oneOf(saved.rate, RATES, d.rate),
      captionSize: oneOf(saved.captionSize, ['klein', 'mittel', 'gross'] as const, d.captionSize),
      captionBackground: saved.captionBackground !== false,
      fit: oneOf(saved.fit, ['contain', 'cover', 'fill'] as const, d.fit),
      brightness: within(saved.brightness, 0.5, 1.5, d.brightness),
      contrast: within(saved.contrast, 0.5, 1.5, d.contrast),
      saturation: within(saved.saturation, 0, 2, d.saturation),
      mirror: saved.mirror === true,
      boost: oneOf(saved.boost, BOOSTS, d.boost),
      night: saved.night === true,
      autoNext: saved.autoNext !== false,
      repeat: oneOf(saved.repeat, ['aus', 'titel', 'liste'] as const, d.repeat),
      skip: oneOf(saved.skip, SKIPS, d.skip),
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function rememberSettings(settings: PlayerSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* only a preference */
  }
}

/** Heights a film can be watched at below its own. */
export const QUALITY_STEPS = [2160, 1440, 1080, 720, 480, 360]

export const rateLabel = (rate: number) => (rate === 1 ? 'Normal' : `${String(rate).replace('.', ',')}×`)

/** h:mm:ss or m:ss — a film's clock, not the editor's centiseconds. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}
