/**
 * Vorlagen fürs Umwandeln: one click instead of five settings.
 *
 * Four come with Sondra — WhatsApp, Instagram Reel, Hörbuch, Klein für
 * E-Mail — each with what it means for a video and, where it makes sense,
 * for a sound file. Own ones are the current settings under a name, kept in
 * this browser (`sondra:umwandeln:vorlagen`); they are a convenience of the
 * device, not part of a project.
 */

import { findFormat, type ConvertSettings } from './convert'

/** The settings a template sets; trimming belongs to the file, not to it. */
export type PresetSettings = Partial<Omit<ConvertSettings, 'trimStartSeconds' | 'trimEndSeconds'>>

export interface ConvertPreset {
  id: string
  label: string
  /** What it does, in a sentence. */
  hint: string
  /** For a video file; also what a sound file gets when `audio` is absent and it is audio itself. */
  video?: PresetSettings
  /** For a sound file — or for taking only the sound from a video. */
  audio?: PresetSettings
  own?: boolean
}

export const BUILT_IN_PRESETS: ConvertPreset[] = [
  {
    id: 'whatsapp',
    label: 'Für WhatsApp',
    hint: 'MP4 in 720p, kompakt — spielt auf jedem Handy. Ton als M4A.',
    video: { formatId: 'mp4', videoFrame: 'source', videoHeight: 720, videoCrf: 28, videoPreset: 'medium', frameRate: 30, audioBitrateKbps: 96, channels: 'source', sampleRate: 'source' },
    audio: { formatId: 'aac', audioBitrateKbps: 128, channels: 'source', sampleRate: 'source' },
  },
  {
    id: 'reel',
    label: 'Instagram Reel',
    hint: 'MP4 im Hochformat 1080 × 1920, 30 Bilder/s — das Bild ganz, mit Rändern.',
    video: { formatId: 'mp4', videoFrame: 'vertical', videoHeight: 'source', videoCrf: 21, videoPreset: 'medium', frameRate: 30, audioBitrateKbps: 128, channels: 'source', sampleRate: 'source' },
  },
  {
    id: 'hoerbuch',
    label: 'Hörbuch',
    hint: 'M4A in Mono mit 64 kbit/s — Sprache klar, die Datei klein. Aus einem Video nur der Ton.',
    audio: { formatId: 'aac', audioBitrateKbps: 64, channels: 1, sampleRate: 44100 },
  },
  {
    id: 'email',
    label: 'Klein für E-Mail',
    hint: 'MP4 in 480p, stark verkleinert; Ton als MP3 in Mono.',
    video: { formatId: 'mp4', videoFrame: 'source', videoHeight: 480, videoCrf: 30, videoPreset: 'medium', frameRate: 24, audioBitrateKbps: 64, channels: 1, sampleRate: 'source' },
    audio: { formatId: 'mp3', useVariableBitrate: false, audioBitrateKbps: 96, channels: 1, sampleRate: 'source' },
  },
]

const KEY = 'sondra:umwandeln:vorlagen'

export function ownPresets(): ConvertPreset[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is ConvertPreset =>
            Boolean(entry) && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.label === 'string',
        ).map((entry) => ({ ...entry, own: true }))
      : []
  } catch {
    return []
  }
}

function storeOwn(list: ConvertPreset[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.map(({ own: _own, ...entry }) => entry)))
    return true
  } catch {
    return false
  }
}

/** The settings that make up a template — everything but the trim. */
function templateOf(settings: ConvertSettings): PresetSettings {
  const { trimStartSeconds: _start, trimEndSeconds: _end, ...rest } = settings
  return { ...rest, videoFrame: rest.videoFrame ?? 'source' }
}

/** The current settings kept under a name. */
export function saveOwnPreset(label: string, settings: ConvertSettings): ConvertPreset | null {
  const kind = findFormat(settings.formatId).kind
  const template = templateOf(settings)
  const preset: ConvertPreset = {
    id: `eigene-${Date.now().toString(36)}`,
    label: label.trim().slice(0, 40),
    hint: 'Eigene Vorlage.',
    ...(kind === 'audio' ? { audio: template } : { video: template }),
    own: true,
  }
  return storeOwn([...ownPresets(), preset]) ? preset : null
}

export function removeOwnPreset(id: string): void {
  storeOwn(ownPresets().filter((entry) => entry.id !== id))
}

/**
 * What a template sets for this file: a video takes the video settings, or
 * the sound ones when the template only has those (Hörbuch); a sound file
 * only ever takes sound settings.
 */
export function presetFor(preset: ConvertPreset, sourceKind: 'audio' | 'video'): PresetSettings | null {
  if (sourceKind === 'audio') return preset.audio ?? null
  return preset.video ?? preset.audio ?? null
}

/** True when the settings are what this template sets. */
export function presetMatches(preset: ConvertPreset, sourceKind: 'audio' | 'video', settings: ConvertSettings): boolean {
  const wanted = presetFor(preset, sourceKind)
  if (!wanted) return false
  const current = { ...settings, videoFrame: settings.videoFrame ?? 'source' } as Record<string, unknown>
  return Object.entries(wanted).every(([key, value]) => current[key] === value)
}
