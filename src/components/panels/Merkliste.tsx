/**
 * The Merkliste: series, seasons and lists someone is following, each with
 * the place they have reached.
 *
 * It grew out of „Gespeicherte Links", which showed every saved address with
 * its whole settings bar open underneath — language, season, episode, mode,
 * quality, transcription — in a framed box per entry with capital-letter
 * labels. Four entries filled a screen and the one thing a person comes back
 * for, „where was I, and the next one please", was a small button among
 * fifteen. Now each entry is one line: what it is, where you are, when you
 * last looked, and „Weiter mit Folge n". Everything else is one click behind
 * „Bearbeiten".
 *
 * Stored only on this device (`sondra:saved_links`), and in a project file.
 */

import { useMemo, useState } from 'react'

import { parseLinkEpisodeInfo, sourceBadgeForUrl } from '../../lib/download'
import { ChoiceRow } from '../editor/EditorShell'
import { Button, Select, TextInput, Toggle } from '../ui/primitives'
import type {
  AniworldLanguagePref,
  AudioFilePref,
  AudioOutputFormat,
  SavedLinkItem,
  SavedLinkStatus,
  VideoFilePref,
} from './DownloaderPanel'

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
    <span className="inline-flex items-center rounded-nav bg-raised ring-1 ring-inset ring-rule">
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

/**
 * What kind of numbering an address carries: seasons and episodes
 * (`series`), a place in a playlist (`list`), or none — a single video, where
 * season and episode controls would do nothing.
 */
export function episodeKindOf(url: string): 'series' | 'list' | null {
  if (!url.trim()) return null
  if (!parseLinkEpisodeInfo(url).isEpisodicUrl) return null
  const seasonal = /staffel|season|filme?(?:\/|-|$)|\/s\d{1,2}e\d{1,3}/i.test(url)
  return /[?&](?:list|index)=/i.test(url) && !seasonal ? 'list' : 'series'
}

/** Where an entry stands, in words: „Staffel 2, Folge 8", „Film 3", „Staffel 1, alle Folgen". */
export function positionLabel(season: number, episode: number | null, kind: 'series' | 'list' = 'series'): string {
  if (kind === 'list') return episode ? `Nr. ${episode}` : 'ganze Liste'
  if (season === 0) return episode ? `Film ${episode}` : 'Alle Filme'
  return episode ? `Staffel ${season}, Folge ${episode}` : `Staffel ${season}, alle Folgen`
}

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

const STATUS_OPTIONS: { value: SavedLinkStatus; label: string }[] = [
  { value: 'watching', label: 'Am Schauen' },
  { value: 'later', label: 'Später' },
  { value: 'done', label: 'Fertig' },
]

/** „heute", „gestern", „vor 3 Tagen", then the date. */
function whenLabel(timestamp: number | undefined): string | null {
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

const statusOf = (item: SavedLinkItem): SavedLinkStatus => item.status ?? 'watching'

/* -------------------------------------------------------------------------- */
/* The list                                                                    */
/* -------------------------------------------------------------------------- */

export function Merkliste({
  items,
  audioFormats,
  currentUrl,
  currentSaved,
  onSaveCurrent,
  onAdd,
  onOpen,
  onNext,
  onUpdate,
  onRemove,
  onRestore,
  onCopy,
}: {
  items: SavedLinkItem[]
  audioFormats: { id: AudioOutputFormat; label: string }[]
  currentUrl: string
  currentSaved: boolean
  onSaveCurrent: () => void
  onAdd: (url: string, title?: string) => void
  /** Looks the entry up where it stands. */
  onOpen: (item: SavedLinkItem) => void
  /** Moves the entry on by one episode and looks that one up. */
  onNext: (item: SavedLinkItem) => void
  onUpdate: (id: string, patch: Partial<SavedLinkItem>) => void
  onRemove: (id: string) => void
  onRestore: (item: SavedLinkItem, index: number) => void
  onCopy: (item: SavedLinkItem) => void
}) {
  const [filter, setFilter] = useState<'all' | SavedLinkStatus>('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newUrl, setNewUrl] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [removed, setRemoved] = useState<{ item: SavedLinkItem; index: number } | null>(null)

  const counts = useMemo(() => {
    const result: Record<SavedLinkStatus, number> = { watching: 0, later: 0, done: 0 }
    for (const item of items) result[statusOf(item)] += 1
    return result
  }, [items])

  // Being watched first, then for later, then finished; within each, the one
  // looked at most recently on top — where a person picks up again.
  const shown = useMemo(() => {
    const order: Record<SavedLinkStatus, number> = { watching: 0, later: 1, done: 2 }
    return items
      .filter((item) => filter === 'all' || statusOf(item) === filter)
      .slice()
      .sort(
        (a, b) =>
          order[statusOf(a)] - order[statusOf(b)] ||
          (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt),
      )
  }, [items, filter])

  const remove = (item: SavedLinkItem) => {
    setRemoved({ item, index: items.findIndex((entry) => entry.id === item.id) })
    if (editing === item.id) setEditing(null)
    onRemove(item.id)
  }

  return (
    <section aria-labelledby="merkliste" className="flex flex-col border-t-2 border-rule pt-[20px] pb-[8px]">
      <div className="flex flex-wrap items-end justify-between gap-x-[16px] gap-y-[8px]">
        <div className="min-w-0">
          <h3 id="merkliste" className="flex items-baseline gap-[10px] text-subheading text-ink">
            Merkliste
            {items.length > 0 ? <span className="value text-small text-muted">{items.length}</span> : null}
          </h3>
          <p className="mt-[2px] text-small text-muted">
            Serien und Listen, die Sie verfolgen, mit der Stelle, an der Sie sind. Nur auf diesem Gerät gespeichert.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-[8px]">
          {currentUrl.trim() && !currentSaved ? (
            <Button type="button" size="sm" variant="quiet" onClick={onSaveCurrent}>
              Adresse oben merken
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-expanded={adding}
            aria-controls="merkliste-neu"
            onClick={() => setAdding((open) => !open)}
          >
            {adding ? 'Abbrechen' : 'Eintrag hinzufügen'}
          </Button>
        </div>
      </div>

      {adding ? (
        <form
          id="merkliste-neu"
          className="mt-[12px] grid grid-cols-[minmax(0,1fr)] gap-x-[16px] gap-y-[10px] border-t border-line pt-[12px] sm:grid-cols-[minmax(0,1fr)_220px_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault()
            if (!newUrl.trim()) return
            onAdd(newUrl, newTitle || undefined)
            setNewUrl('')
            setNewTitle('')
            setAdding(false)
          }}
        >
          <label className="flex min-w-0 flex-col gap-[4px]">
            <span className="text-small text-prose">Adresse</span>
            <TextInput
              autoFocus
              value={newUrl}
              onChange={(event) => setNewUrl(event.target.value)}
              placeholder="https://…"
              inputMode="url"
              spellCheck={false}
            />
          </label>
          <label className="flex flex-col gap-[4px]">
            <span className="text-small text-prose">Name</span>
            <TextInput
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="aus der Adresse"
              className="font-sans"
            />
          </label>
          <Button type="submit" size="sm" disabled={!newUrl.trim()} className="h-[36px]">
            Merken
          </Button>
        </form>
      ) : null}

      {removed ? (
        <p role="status" className="rise mt-[12px] flex flex-wrap items-center gap-x-[12px] text-small text-prose">
          <span>„{removed.item.title}“ ist von der Merkliste.</span>
          <button
            type="button"
            onClick={() => {
              onRestore(removed.item, removed.index)
              setRemoved(null)
            }}
            className="press rounded-nav font-semibold text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
          >
            Rückgängig
          </button>
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="mt-[12px] max-w-[64ch] text-small leading-[1.55] text-muted">
          Noch nichts gemerkt. Eine Adresse oben einfügen und „Merken“ drücken: Sondra hält Staffel und Folge fest und
          bietet beim nächsten Mal „Weiter mit Folge …“ an.
        </p>
      ) : (
        <>
          {items.length > 1 ? (
            <div className="mt-[12px]">
              <ChoiceRow
                value={filter}
                options={[
                  { value: 'all', label: `Alle ${items.length}` },
                  ...STATUS_OPTIONS.filter((option) => counts[option.value] > 0).map((option) => ({
                    value: option.value,
                    label: `${option.label} ${counts[option.value]}`,
                  })),
                ]}
                onChange={(value) => setFilter(value)}
              />
            </div>
          ) : null}

          {shown.length === 0 ? (
            <p className="mt-[12px] text-small text-muted">In dieser Auswahl steht gerade nichts.</p>
          ) : (
            <ul className="mt-[8px] flex flex-col divide-y divide-line">
              {shown.map((item) => (
                <MerkEntry
                  key={item.id}
                  item={item}
                  audioFormats={audioFormats}
                  open={editing === item.id}
                  onToggle={() => setEditing((current) => (current === item.id ? null : item.id))}
                  onOpen={() => onOpen(item)}
                  onNext={() => onNext(item)}
                  onUpdate={(patch) => onUpdate(item.id, patch)}
                  onRemove={() => remove(item)}
                  onCopy={() => onCopy(item)}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* One entry                                                                   */
/* -------------------------------------------------------------------------- */

function MerkEntry({
  item,
  audioFormats,
  open,
  onToggle,
  onOpen,
  onNext,
  onUpdate,
  onRemove,
  onCopy,
}: {
  item: SavedLinkItem
  audioFormats: { id: AudioOutputFormat; label: string }[]
  open: boolean
  onToggle: () => void
  onOpen: () => void
  onNext: () => void
  onUpdate: (patch: Partial<SavedLinkItem>) => void
  onRemove: () => void
  onCopy: () => void
}) {
  const kind = episodeKindOf(item.url)
  const episodic = kind !== null
  const status = statusOf(item)
  const editorId = `merkliste-${item.id}`
  const language = LANGUAGE_OPTIONS.find((option) => option.value === item.language)
  const format = audioFormats.find((entry) => entry.id === item.audioFormat)

  // What it loads as, said once: „Video, wie die Quelle · Untertitel".
  const loadsAs = [
    item.mode === 'audio'
      ? `Nur Ton, ${format?.label ?? item.audioFormat}`
      : `Video, ${VIDEO_QUALITY_OPTIONS.find((option) => option.value === item.videoPref)?.label.toLowerCase() ?? item.videoPref}`,
    item.language !== 'auto' && language ? language.label : null,
    item.autoTranscribe ? 'mit Untertiteln' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const meta = [
    sourceBadgeForUrl(item.url),
    kind ? positionLabel(item.season, item.episode, kind) : null,
    whenLabel(item.lastOpenedAt) ? `zuletzt ${whenLabel(item.lastOpenedAt)}` : null,
  ].filter(Boolean)

  const hasNext = episodic && item.episode !== null
  const nextNumber = (item.episode ?? 0) + 1
  const nextLabel =
    kind === 'list' ? `Weiter mit Nr. ${nextNumber}` : item.season === 0 ? `Weiter mit Film ${nextNumber}` : `Weiter mit Folge ${nextNumber}`
  const currentLabel = kind === 'list' ? `Nr. ${item.episode}` : item.season === 0 ? `Film ${item.episode}` : `Folge ${item.episode}`

  return (
    <li className="flex max-w-none flex-col py-[12px]">
      <div className="flex flex-col gap-[10px] sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className={`truncate text-body font-semibold ${status === 'done' ? 'text-prose' : 'text-ink'}`} title={item.title}>
            {item.title}
          </p>
          <p className="mt-[2px] text-small text-muted">
            {meta.map((part, index) => (
              <span key={index}>
                {index > 0 ? ' · ' : ''}
                {index === 1 && episodic ? <span className="text-prose">{part}</span> : part}
              </span>
            ))}
            {status !== 'watching' ? ` · ${STATUS_OPTIONS.find((option) => option.value === status)?.label}` : ''}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
          {hasNext && status !== 'done' ? (
            <>
              <Button type="button" size="sm" onClick={onNext}>
                {nextLabel}
              </Button>
              <Button type="button" size="sm" variant="quiet" onClick={onOpen} title={`${positionLabel(item.season, item.episode, kind ?? 'series')} noch einmal nachsehen`}>
                {currentLabel}
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" variant={status === 'done' ? 'quiet' : 'primary'} onClick={onOpen}>
              Nachsehen
            </Button>
          )}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={editorId}
            onClick={onToggle}
            className="press rounded-nav px-[4px] py-[6px] text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
          >
            {open ? 'Fertig' : 'Bearbeiten'}
          </button>
        </div>
      </div>

      {open ? (
        <div id={editorId} className="rise mt-[12px] grid grid-cols-[minmax(0,1fr)] gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
          <label className="flex flex-col gap-[6px] border-t border-line pt-[10px]">
            <span className="text-small text-prose">Name</span>
            <TextInput value={item.title} onChange={(event) => onUpdate({ title: event.target.value })} className="font-sans" />
          </label>

          <div className="flex flex-col gap-[6px] border-t border-line pt-[10px]">
            <span className="text-small text-prose">Stand</span>
            <ChoiceRow value={status} options={STATUS_OPTIONS} onChange={(value) => onUpdate({ status: value })} />
          </div>

          {episodic ? (
            <div className="flex flex-col gap-[8px] border-t border-line pt-[10px] sm:col-span-2">
              <span className="text-small text-prose">{kind === 'list' ? 'Stelle in der Liste' : 'Wo Sie sind'}</span>
              <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
                {kind === 'series' ? (
                <ChoiceRow
                  value={item.season === 0 ? 'filme' : 'staffel'}
                  options={[
                    { value: 'staffel', label: 'Staffeln' },
                    { value: 'filme', label: 'Filme' },
                  ]}
                  onChange={(value) => onUpdate({ season: value === 'filme' ? 0 : Math.max(1, item.season) })}
                />
                ) : null}
                {kind === 'series' && item.season > 0 ? (
                  <span className="flex items-center gap-[8px] text-small text-prose">
                    Staffel
                    <Stepper label="Staffel" value={item.season} max={99} onChange={(season) => onUpdate({ season })} />
                  </span>
                ) : null}
                <span className="flex items-center gap-[8px] text-small text-prose">
                  {kind === 'list' ? 'Nr.' : item.season === 0 ? 'Film' : 'Folge'}
                  {item.episode !== null ? (
                    <Stepper
                      label={kind === 'list' ? 'Nummer' : item.season === 0 ? 'Film' : 'Folge'}
                      value={item.episode}
                      onChange={(episode) => onUpdate({ episode })}
                    />
                  ) : null}
                </span>
                <div className="w-max">
                  <Toggle
                    label={kind === 'list' ? 'Ganze Liste' : item.season === 0 ? 'Alle Filme' : 'Ganze Staffel'}
                    checked={item.episode === null}
                    onChange={(whole) => onUpdate({ episode: whole ? null : 1 })}
                  />
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-[6px] border-t border-line pt-[10px]">
            <span className="text-small text-prose">Laden als</span>
            <div className="flex flex-wrap items-center gap-[8px]">
              <ChoiceRow
                value={item.mode}
                options={[
                  { value: 'video', label: 'Video mit Ton' },
                  { value: 'audio', label: 'Nur Ton' },
                ]}
                onChange={(mode) => onUpdate({ mode })}
              />
              {item.mode === 'audio' ? (
                <Select
                  aria-label={`Tonformat für ${item.title}`}
                  value={item.audioFormat}
                  onChange={(event) => onUpdate({ audioFormat: event.target.value as AudioOutputFormat })}
                  className="w-auto! py-[6px]"
                >
                  {audioFormats.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
          </div>

          <label className="flex flex-col gap-[6px] border-t border-line pt-[10px]">
            <span className="text-small text-prose">Qualität</span>
            {item.mode === 'audio' ? (
              <Select value={item.audioPref} onChange={(event) => onUpdate({ audioPref: event.target.value as AudioFilePref })}>
                {AUDIO_QUALITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Select value={item.videoPref} onChange={(event) => onUpdate({ videoPref: event.target.value as VideoFilePref })}>
                {VIDEO_QUALITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </label>

          {kind === 'series' ? (
            <div className="flex flex-col gap-[6px] border-t border-line pt-[10px]">
              <span className="text-small text-prose">Sprachfassung</span>
              <ChoiceRow
                value={item.language}
                options={LANGUAGE_OPTIONS}
                onChange={(value) => onUpdate({ language: value })}
              />
            </div>
          ) : null}

          <div className="border-t border-line pt-[10px]">
            <Toggle
              label="Untertitel dazu erstellen"
              hint="Whisper schreibt nach dem Laden auf diesem Gerät mit."
              checked={item.autoTranscribe}
              onChange={(autoTranscribe) => onUpdate({ autoTranscribe })}
            />
          </div>

          <div className="flex flex-col gap-[8px] border-t border-line pt-[10px] sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="value min-w-0 truncate text-small text-muted" title={item.url}>
              {item.url}
            </span>
            <span className="flex shrink-0 items-center gap-[16px] text-small">
              <span className="text-muted">{loadsAs}</span>
              <button
                type="button"
                onClick={onCopy}
                className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
              >
                Adresse kopieren
              </button>
              <button type="button" onClick={onRemove} className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink">
                Entfernen
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </li>
  )
}
