/** Presentation helpers. Kept free of DOM access so workers can use them too. */

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : digits)} ${units[unit]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/** Timecode with centiseconds, for sampler slice boundaries. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const cs = Math.floor((seconds % 1) * 100)
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export function formatDb(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '−∞ dB'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)} dB`
}

export function formatLufs(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '−∞ LUFS'
  return `${value.toFixed(digits)} LUFS`
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Replaces the extension of a filename, keeping the stem intact. */
export function withExtension(name: string, extension: string): string {
  const stem = name.replace(/\.[^./\\]+$/, '')
  return `${stem}.${extension.replace(/^\./, '')}`
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180) || 'sondra-output'
}

/** A file name's two halves: what the rename field edits, and the type that stays. */
export function splitName(name: string): { stem: string; extension: string } {
  const match = /^(.+?)(\.[^./\\\s]{1,8})$/.exec(name)
  return match ? { stem: match[1], extension: match[2] } : { stem: name, extension: '' }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * A new name for a file in the session: the stem as typed, the old type
 * kept. Refused rather than quietly changed when Windows would refuse it —
 * the person sees why and what to type instead.
 */
export function renamedFile(stem: string, previous: string): { name: string } | { error: string } {
  const clean = stem.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  if (!clean) return { error: 'Der Name darf nicht leer sein.' }
  const bad = clean.match(/[\\/:*?"<>|\u0000-\u001f]/)
  if (bad) {
    return {
      error: /[\u0000-\u001f]/.test(bad[0])
        ? 'Steuerzeichen gehen nicht in einem Dateinamen.'
        : `„${bad[0]}“ geht nicht — Windows erlaubt \\ / : * ? " < > | nicht in Dateinamen.`,
    }
  }
  if (RESERVED.test(clean)) return { error: `„${clean}“ ist unter Windows ein reservierter Name.` }
  const { extension } = splitName(previous)
  const name = `${clean}${extension}`
  if (name.length > 200) return { error: 'Höchstens 200 Zeichen.' }
  return { name }
}
