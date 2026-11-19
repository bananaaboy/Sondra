/**
 * What the downloader and the Merkliste tab both draw: the season/episode
 * stepper, the option lists, and how an address is numbered.
 *
 * Its own small module so the downloader does not pull the whole Merkliste
 * tab into its chunk to get a stepper.
 */

import type { SavedLinkStatus } from '../../lib/merkliste'
import type { AniworldLanguagePref, AudioFilePref, VideoFilePref } from './DownloaderPanel'

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A number with a step down and a step up, for season and episode. One
 * control in the form's own hand — the ring of a field, the value in the face
 * of things entered — instead of three loose buttons around an input.
 */
export function Stepper({
  label,
  value,
  min = 1,
  max = 9999,
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (value: number) => void
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next))
  return (
    <span className="inline-flex w-max items-center rounded-nav bg-raised ring-1 ring-inset ring-rule">
      <button
        type="button"
        aria-label={`${label} zurück`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
        className="press flex h-[32px] w-[30px] items-center justify-center rounded-l-nav text-body text-ink hover:bg-panel-soft disabled:opacity-40"
      >
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        aria-label={label}
        value={value}
        onChange={(event) => {
          const next = parseInt(event.target.value, 10)
          if (!Number.isNaN(next)) onChange(clamp(next))
        }}
        className="value h-[32px] w-[42px] border-0 bg-transparent text-center text-small text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        aria-label={`${label} weiter`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
        className="press flex h-[32px] w-[30px] items-center justify-center rounded-r-nav text-body text-ink hover:bg-panel-soft disabled:opacity-40"
      >
        +
      </button>
    </span>
  )
}

export { episodeKindOf, positionLabel } from '../../lib/merkRows'

/** The language versions a multi-language source may offer. */
export const LANGUAGE_OPTIONS: { value: AniworldLanguagePref; label: string; title: string }[] = [
  { value: 'auto', label: 'Automatisch', title: 'Die beste vorhandene Fassung, Deutsch bevorzugt' },
  { value: 'ger_sub', label: 'Deutsch untertitelt', title: 'Originalton mit deutschen Untertiteln (OmU)' },
  { value: 'ger_dub', label: 'Deutsch', title: 'Deutsche Synchronfassung' },
  { value: 'eng_sub', label: 'Englisch untertitelt', title: 'Originalton mit englischen Untertiteln' },
]

export const VIDEO_QUALITY_OPTIONS: { value: VideoFilePref; label: string }[] = [
  { value: 'untouched', label: 'Wie die Quelle' },
  { value: 'best', label: 'Beste (bis 4K)' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
  { value: '360p', label: '360p' },
]

export const AUDIO_QUALITY_OPTIONS: { value: AudioFilePref; label: string }[] = [
  { value: 'untouched', label: 'Wie die Quelle' },
  { value: 'high', label: 'Hoch (320 kbps)' },
  { value: 'medium', label: 'Mittel (192 kbps)' },
  { value: 'low', label: 'Klein (128 kbps)' },
  { value: 'lossless', label: 'Verlustfrei' },
]

export const STATUS_OPTIONS: { value: SavedLinkStatus; label: string; title?: string }[] = [
  { value: 'watching', label: 'Am Schauen' },
  { value: 'later', label: 'Später' },
  { value: 'paused', label: 'Pausiert', title: 'Angefangen, gerade nicht weiter' },
  { value: 'done', label: 'Fertig' },
  { value: 'dropped', label: 'Abgebrochen', title: 'Nicht mehr weiter — bleibt auf der Liste' },
]

/** „heute", „gestern", „vor 3 Tagen", then the date. */
export function whenLabel(timestamp: number | undefined): string | null {
  if (!timestamp) return null
  const startOfDay = (time: number) => {
    const date = new Date(time)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  const days = Math.round((startOfDay(Date.now()) - startOfDay(timestamp)) / 86_400_000)
  if (days <= 0) return 'heute'
  if (days === 1) return 'gestern'
  if (days < 7) return `vor ${days} Tagen`
  return new Date(timestamp).toLocaleDateString('de-CH', { day: 'numeric', month: 'numeric', year: '2-digit' })
}


