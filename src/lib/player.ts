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
  /** Direct URL if available (e.g. streaming) */
  directUrl?: string
  /** In Google Drive: streamed from there, `source` stays empty. */
  remote?: RemoteMedia
  /** Pre-extracted resolution streams (e.g. from service/downloader) */
  streamVariants?: { height: number; url: string; label?: string }[]
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
    .replace(/(?:(\d{1,2}):(\d{2}):(\d{2})),(\d{3})/g, (_m, h, m, s, ms) => `${String(h).padStart(2, '0')}:${m}:${s}.${ms}`)
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

/**
 * Files for the player from elsewhere — the folder page's „Abspielen“ and
 * „Weiterschauen“. `replace` makes them the whole list (an episode and the
 * ones after it), else they join it. Kept until the player takes them, in
 * case its chunk is still on the way.
 */
/** A file in Google Drive, played from there without being copied here first. */
export interface RemoteMedia {
  kind: 'drive'
  id: string
  name: string
  size: number
  /** Its media type, as Drive names it. */
  type: string
}

export const isRemote = (entry: File | RemoteMedia): entry is RemoteMedia => !(entry instanceof Blob)

type PlayerDelivery = { files: (File | RemoteMedia)[]; replace: boolean }
let delivery: PlayerDelivery | null = null
let deliver: ((delivery: PlayerDelivery) => void) | null = null

export function sendToPlayer(files: (File | RemoteMedia)[], replace = false): void {
  if (deliver) deliver({ files, replace })
  else delivery = { files, replace }
}

/** The player's side: takes what waits, and what comes later. */
export function receivePlayerFiles(handler: ((delivery: PlayerDelivery) => void) | null): void {
  deliver = handler
  if (handler && delivery) {
    const waiting = delivery
    delivery = null
    handler(waiting)
  }
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

export type VisualizerMode = 'bars' | 'wave' | 'radial'

export interface EqPreset {
  id: string
  name: string
  bassBoost: number
  eqLow: number
  eqMid: number
  eqHigh: number
}

export const EQ_PRESETS: EqPreset[] = [
  { id: 'flat', name: 'Linear', bassBoost: 0, eqLow: 0, eqMid: 0, eqHigh: 0 },
  { id: 'bass', name: 'Bass-Boost', bassBoost: 6, eqLow: 5, eqMid: 0, eqHigh: 1 },
  { id: 'vocal', name: 'Vocal / Podcast', bassBoost: 0, eqLow: -2, eqMid: 4, eqHigh: 2 },
  { id: 'electronic', name: 'Club / Dance', bassBoost: 4, eqLow: 4, eqMid: -2, eqHigh: 4 },
  { id: 'rock', name: 'Rock / Metal', bassBoost: 2, eqLow: 4, eqMid: 2, eqHigh: 3 },
  { id: 'acoustic', name: 'Akustik / Jazz', bassBoost: 0, eqLow: 2, eqMid: 1, eqHigh: 3 },
]

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
  bassBoost: number
  eqLow: number
  eqMid: number
  eqHigh: number
  eqBand1: number
  eqBand2: number
  eqBand3: number
  eqBand4: number
  eqBand5: number
  eqEnabled: boolean
  eqPreset: string
  karaoke: boolean
  visualizer: boolean
  visualizerMode: VisualizerMode
  autoNext: boolean
  repeat: Repeat
  skip: number
  /** A file named like an episode on the Merkliste is ticked off at 90 %. */
  merkliste: boolean
  /** „Vorspann überspringen“ and „Nächste Folge“ offered over an episode. */
  skipOpening: boolean
  /** How far „Vorspann überspringen“ jumps, for files no series on the Merkliste names. */
  opening: number
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
  bassBoost: 0,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  eqBand1: 0,
  eqBand2: 0,
  eqBand3: 0,
  eqBand4: 0,
  eqBand5: 0,
  eqEnabled: true,
  eqPreset: 'Flat',
  karaoke: false,
  visualizer: true,
  visualizerMode: 'bars',
  autoNext: true,
  repeat: 'aus',
  skip: 10,
  merkliste: true,
  skipOpening: true,
  opening: 90,
}

export const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3]
export const SKIPS = [5, 10, 15, 30]
export const BOOSTS = [1, 1.5, 2, 3]
/** Opening lengths to choose from, in seconds: most anime openings run 1:25 to 1:30. */
export const OPENINGS = [60, 80, 85, 90, 100, 120, 150]
/** Sleep timer lengths, in minutes. */
export const SLEEPS = [15, 30, 60]

/** Shorter than this is a clip, not an episode: no opening, no next episode offered. */
const EPISODE_MIN = 240
/** An opening comes within the first minutes, after a cold open at most. */
const OPENING_WINDOW = 360

/**
 * Whether „Vorspann überspringen“ is on offer: in the first six minutes of
 * an episode (a third of a short one), while the jump still lands before
 * the last minute.
 */
export function openingOffered(time: number, duration: number, opening: number): boolean {
  if (!(duration >= EPISODE_MIN) || !(time >= 0)) return false
  return time < Math.min(OPENING_WINDOW, duration / 3) && time + opening < duration - 60
}

/** Whether „Nächste Folge“ is on offer: in the credits — the last 2:30, an eighth of a short episode. */
export function nextOffered(time: number, duration: number): boolean {
  if (!(duration >= EPISODE_MIN)) return false
  const left = duration - time
  return left > 0.5 && left <= Math.min(150, duration / 8)
}

/** A sleep timer: a moment on the clock, or the end of the title that plays. */
export type SleepTimer = { until: number; minutes: number } | { atEnd: true }

/** The volume a running-out sleep timer leaves: all of it, then down over the last ten seconds. */
export function sleepFade(leftMs: number): number {
  return Math.max(0, Math.min(1, leftMs / 10_000))
}

/** „1:30“ for 90 seconds. */
export function minutesSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
}

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
      bassBoost: within(saved.bassBoost, 0, 12, d.bassBoost),
      eqLow: within(saved.eqLow, -12, 12, d.eqLow),
      eqMid: within(saved.eqMid, -12, 12, d.eqMid),
      eqHigh: within(saved.eqHigh, -12, 12, d.eqHigh),
      eqBand1: within(saved.eqBand1 ?? saved.eqLow, -12, 12, d.eqBand1),
      eqBand2: within(saved.eqBand2, -12, 12, d.eqBand2),
      eqBand3: within(saved.eqBand3 ?? saved.eqMid, -12, 12, d.eqBand3),
      eqBand4: within(saved.eqBand4, -12, 12, d.eqBand4),
      eqBand5: within(saved.eqBand5 ?? saved.eqHigh, -12, 12, d.eqBand5),
      eqEnabled: saved.eqEnabled !== false,
      eqPreset: typeof saved.eqPreset === 'string' ? saved.eqPreset : d.eqPreset,
      karaoke: saved.karaoke === true,
      visualizer: saved.visualizer !== false,
      visualizerMode: oneOf(saved.visualizerMode, ['bars', 'wave', 'radial'] as const, d.visualizerMode),
      autoNext: saved.autoNext !== false,
      repeat: oneOf(saved.repeat, ['aus', 'titel', 'liste'] as const, d.repeat),
      skip: oneOf(saved.skip, SKIPS, d.skip),
      merkliste: saved.merkliste !== false,
      skipOpening: saved.skipOpening !== false,
      opening: oneOf(saved.opening, OPENINGS, d.opening),
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

/* -------------------------------------------------------------------------- */
/* Bookmarks                                                                  */
/* -------------------------------------------------------------------------- */

/** A place in a file worth finding again, with a name of one's own. */
export interface PlayerMark {
  id: string
  /** Seconds into the file. */
  at: number
  /** Empty until named; shown as „Lesezeichen n“ until then. */
  label: string
}

const MARKS_KEY = 'sondra:abspielen:marken'
/** Two marks closer than this are one place. */
const MARK_GAP = 1

function readAllMarks(): Record<string, PlayerMark[]> {
  try {
    const saved = JSON.parse(localStorage.getItem(MARKS_KEY) ?? '{}')
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

/** Marks as they are kept: valid ones only, in order of time. */
export function cleanMarks(raw: unknown): PlayerMark[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((mark): mark is PlayerMark => Boolean(mark) && typeof mark.at === 'number' && Number.isFinite(mark.at) && mark.at >= 0)
    .map((mark) => ({ id: String(mark.id || `m${Math.round(mark.at * 1000)}`), at: mark.at, label: typeof mark.label === 'string' ? mark.label.slice(0, 120) : '' }))
    .sort((a, b) => a.at - b.at)
}

/** The bookmarks of a file, by its name and size like „Weiter bei“. */
export function marksFor(item: { name: string; size: number }): PlayerMark[] {
  return cleanMarks(readAllMarks()[placeKey(item)])
}

/** Keeps a file's bookmarks; an empty list forgets the file. The newest hundred files stay. */
export function saveMarks(item: { name: string; size: number }, marks: PlayerMark[]): void {
  try {
    const all = readAllMarks()
    delete all[placeKey(item)]
    if (marks.length > 0) all[placeKey(item)] = cleanMarks(marks)
    localStorage.setItem(MARKS_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-100))))
  } catch {
    /* only a convenience */
  }
}

/** A mark at `at`, unless one is already there; the list stays in order. */
export function withMark(marks: PlayerMark[], at: number): { marks: PlayerMark[]; added: PlayerMark | null } {
  const rounded = Math.max(0, Math.round(at * 10) / 10)
  if (marks.some((mark) => Math.abs(mark.at - rounded) < MARK_GAP)) return { marks, added: null }
  const added: PlayerMark = { id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: rounded, label: '' }
  return { marks: cleanMarks([...marks, added]), added }
}

/** The mark before or after `time` — a step back lands on the previous one, not the one just passed by a second. */
export function neighbourMark(marks: PlayerMark[], time: number, direction: 1 | -1): PlayerMark | null {
  if (direction > 0) return marks.find((mark) => mark.at > time + 0.5) ?? null
  return [...marks].reverse().find((mark) => mark.at < time - 2) ?? null
}

export const markName = (marks: PlayerMark[], mark: PlayerMark) => mark.label.trim() || `Lesezeichen ${marks.indexOf(mark) + 1}`

/**
 * The marks as chapters, the way YouTube reads them from a description:
 * one line each, the first at 0:00 — a beginning is added when no mark is
 * there.
 */
export function chaptersText(marks: PlayerMark[]): string {
  const sorted = cleanMarks(marks)
  const lines = sorted.map((mark, index) => `${clock(mark.at)} ${mark.label.trim() || `Kapitel ${index + 1}`}`)
  if (sorted.length === 0 || sorted[0].at >= 1) lines.unshift('0:00 Anfang')
  else lines[0] = `0:00 ${sorted[0].label.trim() || 'Kapitel 1'}`
  return lines.join('\n')
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
