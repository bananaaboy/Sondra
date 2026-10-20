/**
 * The Merkliste tab: what someone is watching, season by season.
 *
 * Each series is a section — its name, where you are, how much of it is
 * seen, and „Weiter mit Folge n" — and its seasons are tiles: a cover, the
 * season's name, a bar for what is seen. Hovering (or focusing) a tile says
 * the rest — how many seen, how many left, which one is next — and a click
 * opens the season itself: every episode as a number to tick off, how many
 * there are, a name and a cover of its own.
 *
 * Nothing here loads anything. „Weiter" hands the entry to the downloader,
 * which looks the episode up the way its own field would; an entry without an
 * address is followed all the same, only without the loading.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

import { buildUrlWithEpisode, saveBytes, sourceBadgeForUrl } from '../../lib/download'
import {
  advance,
  caughtUp,
  coverFromFile,
  createMerkItem,
  exportMerkliste,
  itemProgress,
  mergeMerkliste,
  merkSaveFailed,
  readMerklisteFile,
  requestLookup,
  seasonName,
  seasonProgress,
  seasonsOf,
  setMerkItems,
  settle,
  toggleWatched,
  updateMerkItem,
  useMerkliste,
  watchedUpTo,
  withSeason,
  type MerkSeason,
  type SavedLinkItem,
  type SavedLinkStatus,
} from '../../lib/merkliste'
import { useSession } from '../../state/store'
import { ChoiceRow } from '../editor/EditorShell'
import { Button, Card, Dialog, Notice, RowMark, Select, TextInput, Toggle } from '../ui/primitives'
import type { AudioFilePref, AudioOutputFormat, VideoFilePref } from './DownloaderPanel'
import {
  AUDIO_QUALITY_OPTIONS,
  LANGUAGE_OPTIONS,
  STATUS_OPTIONS,
  Stepper,
  VIDEO_QUALITY_OPTIONS,
  episodeKindOf,
  positionLabel,
  whenLabel,
} from './merklisteShared'

const AUDIO_FORMATS: { id: AudioOutputFormat; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: 'mp3', label: 'MP3' },
  { id: 'wav', label: 'WAV' },
  { id: 'm4a', label: 'M4A' },
  { id: 'flac', label: 'FLAC' },
  { id: 'opus', label: 'Opus' },
]

const statusOf = (item: SavedLinkItem): SavedLinkStatus => item.status ?? 'watching'

/* -------------------------------------------------------------------------- */
/* Small pieces                                                                */
/* -------------------------------------------------------------------------- */

/** A thin bar for what is seen; striped-free, one colour, the total as its track. */
function ProgressBar({ fraction, label }: { fraction: number | null; label: string }) {
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      className="block h-[4px] w-full overflow-hidden rounded-pill bg-panel-strong"
    >
      <span
        className="block h-full rounded-pill bg-ink transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-settle)]"
        style={{ width: `${Math.round((fraction ?? 0) * 100)}%` }}
      />
    </span>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-[18px]" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
      <path d="M8 1.9l1.85 3.85 4.2.58-3.06 2.95.75 4.18L8 11.45l-3.74 2.01.75-4.18L1.95 6.33l4.2-.58z" />
    </svg>
  )
}

/** Five stars; the one already chosen clears it again. */
function Rating({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <span className="flex items-center gap-[2px] text-ink" role="radiogroup" aria-label="Bewertung">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} von 5`}
          onClick={() => onChange(value === n ? 0 : n)}
          className="press rounded-nav p-[3px] hover:bg-panel-soft"
        >
          <StarIcon filled={n <= value} />
        </button>
      ))}
    </span>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

function FilmIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-[44px]" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" aria-hidden>
      <path d="M2.4 3.2h11.2v9.6H2.4zM4.6 3.2v9.6M11.4 3.2v9.6M2.4 6.4h2.2M2.4 9.6h2.2M11.4 6.4h2.2M11.4 9.6h2.2" />
    </svg>
  )
}

/**
 * A cover from an address or from a file. A file is made small first
 * (`coverFromFile`) — it lives in the list on this device.
 */
function CoverField({ value, onChange, label = 'Cover' }: { value: string | undefined; onChange: (value: string | undefined) => void; label?: string }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(value && !value.startsWith('data:') ? value : '')
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-[8px]">
      <span className="text-small text-prose">{label}</span>
      <div className="flex gap-[12px]">
        {value ? (
          <img
            src={value}
            alt=""
            className="block h-auto max-h-[160px] w-[72px] shrink-0 self-start rounded-nav object-cover ring-1 ring-line"
            onError={() => setProblem('Unter dieser Adresse liess sich kein Bild laden.')}
            onLoad={() => setProblem(null)}
          />
        ) : (
          <span className="relative aspect-[2/3] w-[72px] shrink-0 overflow-hidden rounded-nav bg-panel-mid ring-1 ring-inset ring-line">
            <span className="absolute inset-0 flex items-center justify-center text-small text-muted">kein Bild</span>
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-[8px]">
          <TextInput
            value={draft}
            placeholder="https://… Bildadresse"
            inputMode="url"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              const next = draft.trim()
              if (next !== (value && !value.startsWith('data:') ? value : '')) onChange(next || undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onChange(draft.trim() || undefined)
              }
            }}
          />
          <span className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] text-small">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
            >
              Bild vom Gerät
            </button>
            {value ? (
              <button
                type="button"
                onClick={() => {
                  setDraft('')
                  setProblem(null)
                  onChange(undefined)
                }}
                className="press rounded-nav text-muted hover:text-ink"
              >
                Entfernen
              </button>
            ) : null}
          </span>
          {problem ? <span className="text-small text-ink">! {problem}</span> : null}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              try {
                const picture = await coverFromFile(file)
                setDraft('')
                setProblem(null)
                onChange(picture)
                if (merkSaveFailed()) setProblem('Für dieses Bild ist auf dem Gerät kein Platz mehr. Eine Bildadresse braucht keinen.')
              } catch {
                setProblem('Diese Datei liess sich nicht als Bild lesen.')
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}

/** A form line: the rule, the question, the answer. */
function Line({ label, children, wide = false }: { label?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`flex flex-col gap-[8px] border-t border-line pt-[10px] ${wide ? 'sm:col-span-2' : ''}`}>
      {label ? <span className="text-small text-prose">{label}</span> : null}
      {children}
    </div>
  )
}

const textAreaClass =
  'min-h-[84px] w-full rounded-nav border-0 bg-raised px-[12px] py-[8px] text-small leading-[1.5] text-prose outline-none ring-1 ring-inset ring-rule hover:ring-muted focus:ring-2 focus:ring-ink'

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * „Folge 5 gesehen": the episode the entry stands at counts as seen, and the
 * entry moves on to the next one — the one „Hier sind Sie" then names.
 */
function markSeen(item: SavedLinkItem) {
  const next = advance(item)
  const url = item.url.trim() ? buildUrlWithEpisode(item.url, next.season, next.episode) : item.url
  updateMerkItem(item.id, { ...next, url, lastOpenedAt: Date.now() })
}

/** Opens the current episode in the downloader without moving on. */
function useOpenHere() {
  const setPanel = useSession((state) => state.setPanel)
  return (item: SavedLinkItem) => {
    if (!item.url.trim()) return
    updateMerkItem(item.id, { lastOpenedAt: Date.now() })
    requestLookup(item)
    setPanel('downloader')
  }
}

/** „Folge 5", „Film 2", „Nr. 12" — the episode the entry stands at. */
const hereLabel = (item: SavedLinkItem) => {
  const kind = episodeKindOf(item.url) ?? 'series'
  if (kind === 'list') return `Nr. ${item.episode ?? 1}`
  return item.season === 0 ? `Film ${item.episode ?? 1}` : `Folge ${item.episode ?? 1}`
}

/* -------------------------------------------------------------------------- */
/* The tab                                                                     */
/* -------------------------------------------------------------------------- */

export function MerklistePanel() {
  const items = useMerkliste()
  const setPanel = useSession((state) => state.setPanel)
  const [filter, setFilter] = useState<'all' | SavedLinkStatus>('all')
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [season, setSeason] = useState<{ id: string; number: number } | null>(null)
  const [removed, setRemoved] = useState<{ item: SavedLinkItem; index: number } | null>(null)

  const counts = useMemo(() => {
    const result: Record<SavedLinkStatus, number> = { watching: 0, later: 0, done: 0 }
    for (const item of items) result[statusOf(item)] += 1
    return result
  }, [items])
  const seenTotal = useMemo(() => items.reduce((sum, item) => sum + itemProgress(item).watched, 0), [items])

  const shown = useMemo(() => {
    const order: Record<SavedLinkStatus, number> = { watching: 0, later: 1, done: 2 }
    const needle = query.trim().toLowerCase()
    return items
      .filter((item) => filter === 'all' || statusOf(item) === filter)
      .filter((item) => !needle || item.title.toLowerCase().includes(needle) || (item.notes ?? '').toLowerCase().includes(needle))
      .slice()
      .sort(
        (a, b) =>
          order[statusOf(a)] - order[statusOf(b)] ||
          (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt),
      )
  }, [items, filter, query])

  const editingItem = items.find((item) => item.id === editing) ?? null
  const seasonItem = season ? (items.find((item) => item.id === season.id) ?? null) : null

  const remove = (item: SavedLinkItem) => {
    setRemoved({ item, index: items.findIndex((entry) => entry.id === item.id) })
    setEditing(null)
    setSeason(null)
    setMerkItems((current) => current.filter((entry) => entry.id !== item.id))
  }

  return (
    <div className="flex flex-col gap-[16px]">
      <Card tone="cream">
        <div className="mt-[8px] flex flex-wrap items-end justify-between gap-x-[16px] gap-y-[12px]">
          <div className="min-w-0">
            <h2 className="display-md">Merkliste</h2>
            <p className="mt-[4px] text-body text-prose">
              {items.length === 0
                ? 'Serien, Staffeln und Listen, die Sie schauen — mit dem, was Sie schon gesehen haben.'
                : `${counts.watching} am Schauen · ${seenTotal} ${seenTotal === 1 ? 'Folge' : 'Folgen'} gesehen`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-[8px]">
            <Button type="button" variant="quiet" size="sm" onClick={() => setPanel('downloader')}>
              Zum Herunterladen
            </Button>
            <Button type="button" size="sm" onClick={() => setAdding(true)}>
              Serie hinzufügen
            </Button>
          </div>
        </div>

        {items.length > 1 ? (
          <div className="mt-[16px] flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[10px] border-t border-line pt-[12px]">
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
            {items.length > 5 ? (
              <TextInput
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="In der Merkliste suchen"
                aria-label="In der Merkliste suchen"
                className="font-sans sm:max-w-[280px]"
              />
            ) : null}
          </div>
        ) : null}

        {removed ? (
          <p role="status" className="rise mt-[12px] flex flex-wrap items-center gap-x-[12px] text-small text-prose">
            <span>„{removed.item.title}“ ist von der Merkliste.</span>
            <button
              type="button"
              onClick={() => {
                setMerkItems((current) => {
                  if (current.some((entry) => entry.id === removed.item.id)) return current
                  const next = [...current]
                  next.splice(Math.max(0, Math.min(removed.index, next.length)), 0, removed.item)
                  return next
                })
                setRemoved(null)
              }}
              className="press rounded-nav font-semibold text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
            >
              Rückgängig
            </button>
          </p>
        ) : null}
      </Card>

      {items.length === 0 ? (
        <EmptyState onAdd={() => setAdding(true)} onDownload={() => setPanel('downloader')} />
      ) : shown.length === 0 ? (
        <p className="text-small text-muted">In dieser Auswahl steht gerade nichts.</p>
      ) : (
        shown.map((item) => (
          <Series
            key={item.id}
            item={item}
            onEdit={() => setEditing(item.id)}
            onSeason={(number) => setSeason({ id: item.id, number })}
          />
        ))
      )}

      <Transfer items={items} />

      <AddDialog open={adding} onClose={() => setAdding(false)} />
      {editingItem ? (
        <SeriesDialog item={editingItem} onClose={() => setEditing(null)} onRemove={() => remove(editingItem)} />
      ) : null}
      {seasonItem && season ? (
        <SeasonDialog item={seasonItem} number={season.number} onClose={() => setSeason(null)} />
      ) : null}
    </div>
  )
}

/**
 * The list as a file: to keep, or to take to another device. The list lives
 * only on this one, so this is the way it leaves; reading a file in merges
 * it, and one click takes the merge back.
 */
function Transfer({ items }: { items: SavedLinkItem[] }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<{ before: SavedLinkItem[]; message: string } | null>(null)

  const exportFile = () => {
    const day = new Date().toISOString().slice(0, 10)
    saveBytes(new TextEncoder().encode(exportMerkliste(items)), `Sondra-Merkliste-${day}.json`, 'application/json')
  }

  const importFile = async (file: File) => {
    setProblem(null)
    setDone(null)
    try {
      const incoming = readMerklisteFile(await file.text())
      const before = items
      const result = mergeMerkliste(before, incoming)
      if (!setMerkItems(result.items)) {
        setMerkItems(before)
        setProblem('Für die eingelesene Liste reicht der Speicher auf diesem Gerät nicht — meist sind es zu grosse Cover.')
        return
      }
      const parts = [
        result.added ? `${result.added} neu` : null,
        result.updated ? `${result.updated} auf neuerem Stand` : null,
        result.same ? `${result.same} schon gleich` : null,
        result.kept ? `${result.kept} hier neuer, behalten` : null,
      ].filter(Boolean)
      setDone({ before, message: `Eingelesen: ${parts.join(' · ')}.` })
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Die Datei liess sich nicht lesen.')
    }
  }

  return (
    <div className="flex flex-col gap-[12px] border-t border-line pt-[14px]">
      <div className="flex flex-wrap items-center justify-between gap-x-[24px] gap-y-[10px]">
        <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
          Die Merkliste liegt nur auf diesem Gerät. Als Datei lässt sie sich sichern und auf einem anderen einlesen.
        </p>
        <span className="flex flex-wrap gap-[8px]">
          {items.length > 0 ? (
            <Button type="button" variant="quiet" size="sm" onClick={exportFile}>
              Exportieren
            </Button>
          ) : null}
          <Button type="button" variant="quiet" size="sm" onClick={() => fileRef.current?.click()}>
            Aus Datei einlesen
          </Button>
        </span>
      </div>
      {problem ? (
        <Notice tone="error" title="Nicht eingelesen">
          {problem}
        </Notice>
      ) : null}
      {done ? (
        <p role="status" className="rise flex flex-wrap items-center gap-x-[12px] text-small text-prose">
          <span>{done.message}</span>
          <button
            type="button"
            onClick={() => {
              setMerkItems(done.before)
              setDone(null)
            }}
            className="press rounded-nav font-semibold text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
          >
            Rückgängig
          </button>
        </p>
      ) : null}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void importFile(file)
        }}
      />
    </div>
  )
}

function EmptyState({ onAdd, onDownload }: { onAdd: () => void; onDownload: () => void }) {
  return (
    <div className="grid gap-[24px] border-t border-line pt-[20px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-[12px]">
        <p className="text-subheading text-ink">Noch nichts auf der Merkliste</p>
        <p className="text-small leading-[1.55] text-prose">
          Eine Serie hinzufügen, sagen, wie viele Staffeln und Folgen sie hat, und abhaken, was gesehen ist. Jede
          Staffel wird eine Kachel mit Cover und Fortschritt. Steht eine Adresse dabei, lädt „Weiter mit Folge …“ die
          nächste gleich im Herunterladen.
        </p>
        <div className="flex flex-wrap gap-[8px]">
          <Button type="button" onClick={onAdd}>
            Erste Serie hinzufügen
          </Button>
          <Button type="button" variant="quiet" onClick={onDownload}>
            Adresse im Herunterladen merken
          </Button>
        </div>
      </div>
      {/* What it will look like, drawn with the tile itself. */}
      <div aria-hidden className="grid grid-cols-3 gap-[10px] opacity-60">
        {[1, 2, 3].map((n) => (
          <span key={n} className="relative aspect-[2/3] overflow-hidden rounded-card bg-panel-mid">
            <span className="display-md absolute inset-0 flex items-center justify-center text-ink/30">{n}</span>
            <span className="absolute inset-x-[10px] bottom-[10px]">
              <ProgressBar fraction={n === 1 ? 1 : n === 2 ? 0.45 : 0} label="" />
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Cover shapes                                                                */
/* -------------------------------------------------------------------------- */

/** Height over width of each cover once it has loaded; null while it loads or when it does not. */
const coverShapes = new Map<string, number | null>()
const shapeListeners = new Set<() => void>()
let shapeVersion = 0

function measureCover(url: string) {
  if (coverShapes.has(url)) return
  coverShapes.set(url, null)
  const image = new Image()
  image.onload = () => {
    coverShapes.set(url, image.naturalWidth > 0 ? image.naturalHeight / image.naturalWidth : null)
    shapeVersion += 1
    shapeListeners.forEach((listener) => listener())
  }
  image.src = url
}

function subscribeShapes(listener: () => void) {
  shapeListeners.add(listener)
  return () => shapeListeners.delete(listener)
}

/**
 * The shape the tiles of one series take: as high as its tallest cover and as
 * wide as its widest. The tiles share the column's width, so that is the
 * tallest cover's shape — the tallest fills a tile from top to bottom, the
 * widest from side to side, and none is cut. A row of posters is 2:3, a row
 * of stills 16:9. Kept between 16:9 and 9:16; with no cover at all, 2:3.
 */
function useTileShape(covers: (string | undefined)[]): number {
  const urls = Array.from(new Set(covers.filter((cover): cover is string => Boolean(cover))))
  const key = urls.join('\n')
  useSyncExternalStore(subscribeShapes, () => shapeVersion)
  useEffect(() => {
    for (const url of key ? key.split('\n') : []) measureCover(url)
  }, [key])
  const known = urls.map((url) => coverShapes.get(url)).filter((shape): shape is number => typeof shape === 'number')
  if (known.length === 0) return 3 / 2
  return Math.min(16 / 9, Math.max(9 / 16, Math.max(...known)))
}

/* -------------------------------------------------------------------------- */
/* One series                                                                  */
/* -------------------------------------------------------------------------- */

function Series({ item, onEdit, onSeason }: { item: SavedLinkItem; onEdit: () => void; onSeason: (number: number) => void }) {
  const openHere = useOpenHere()
  const seasons = seasonsOf(item)
  const progress = itemProgress(item)
  const status = statusOf(item)
  const kind = episodeKindOf(item.url) ?? 'series'
  const last = whenLabel(item.lastOpenedAt)
  const shape = useTileShape(seasons.map((season) => season.cover ?? item.cover))

  const addSeason = () => {
    const highest = seasons.reduce((max, season) => Math.max(max, season.number), 0)
    const next = [...seasons, { number: highest + 1, episodes: null, watched: [] }]
    // A series seen to the end goes on where the new season starts.
    updateMerkItem(item.id, caughtUp(seasons) ? settle(item, next, highest + 1) : { seasons: next })
  }

  return (
    <section aria-label={item.title} className="flex flex-col gap-[14px] border-t border-line pt-[16px]">
      <div className="flex flex-col gap-[12px] sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-[12px] gap-y-[2px]">
            <h3 className="min-w-0 truncate text-subheading text-ink">{item.title}</h3>
            {item.rating ? (
              <span className="text-small text-muted" aria-label={`${item.rating} von 5`}>
                <span className="inline-flex translate-y-[3px] text-ink">
                  {Array.from({ length: item.rating }, (_, i) => (
                    <StarIcon key={i} filled />
                  ))}
                </span>
              </span>
            ) : null}
          </div>
          <p className="mt-[2px] text-small text-muted">
            {[
              item.url.trim() ? sourceBadgeForUrl(item.url) : 'ohne Adresse',
              status === 'done' ? null : positionLabel(item.season, item.episode, kind),
              last ? `zuletzt ${last}` : null,
              status !== 'watching' ? STATUS_OPTIONS.find((option) => option.value === status)?.label : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <div className="mt-[8px] flex max-w-[460px] items-center gap-[12px]">
            <ProgressBar fraction={progress.fraction} label={`${item.title}: gesehen`} />
            <span className="value shrink-0 text-small text-prose">
              {progress.total ? `${progress.watched}/${progress.total}` : `${progress.watched} gesehen`}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
          {item.url.trim() ? (
            <Button type="button" size="sm" variant={status === 'done' ? 'quiet' : 'primary'} onClick={() => openHere(item)}>
              {item.episode !== null && status !== 'done' ? `${hereLabel(item)} laden` : 'Nachsehen'}
            </Button>
          ) : null}
          {status !== 'done' && item.episode !== null ? (
            <Button type="button" size="sm" variant={item.url.trim() ? 'quiet' : 'primary'} onClick={() => markSeen(item)}>
              {hereLabel(item)} gesehen
            </Button>
          ) : null}
          <button
            type="button"
            onClick={onEdit}
            className="press rounded-nav px-[4px] py-[6px] text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
          >
            Bearbeiten
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-[12px] sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6">
        {seasons.map((season) => (
          <SeasonTile
            key={season.number}
            season={season}
            cover={season.cover ?? item.cover}
            shape={shape}
            current={status !== 'done' && season.number === item.season}
            episode={item.episode}
            onOpen={() => onSeason(season.number)}
          />
        ))}
      </div>

      {/* Adding a season is a line under the tiles, not a tile of its own:
          as a tile it took a whole row of the grid's height for one word. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-[24px] gap-y-[6px]">
        {item.notes ? <p className="max-w-[72ch] text-small leading-[1.55] text-prose">{item.notes}</p> : <span />}
        {kind === 'series' ? (
          <span className="flex gap-[16px] text-small">
            <button
              type="button"
              onClick={addSeason}
              className="press inline-flex items-center gap-[6px] rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
            >
              <PlusIcon />
              Staffel hinzufügen
            </button>
            {!seasons.some((season) => season.number === 0) ? (
              <button
                type="button"
                onClick={() => updateMerkItem(item.id, { seasons: [...seasons, { number: 0, episodes: null, watched: [] }] })}
                className="press inline-flex items-center gap-[6px] rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
              >
                <PlusIcon />
                Filme hinzufügen
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    </section>
  )
}

/**
 * One season as a poster: the cover whole, the way it was made, in the
 * series' tile shape (`useTileShape`), with nothing laid over it — and under
 * it the name, the count and a bar for what is seen. A cover of another
 * shape than the tile is not cut to fit: it stands whole, and a blurred copy
 * of itself fills the rest instead of empty bars. The caption used to sit on
 * the picture and hid the bottom third of every poster, a pill sat on its
 * logo. Hover or focus brings up the numbers; a click opens the season.
 */
function SeasonTile({
  season,
  cover,
  shape,
  current,
  episode,
  onOpen,
}: {
  season: MerkSeason
  cover?: string
  /** Height over width, the same for every tile of the series. */
  shape: number
  current: boolean
  /** Where the entry stands, for „Hier sind Sie · Folge 4". */
  episode: number | null
  onOpen: () => void
}) {
  const progress = seasonProgress(season)
  const name = seasonName(season)
  const unit = season.number === 0 ? 'Film' : 'Folge'
  const counted = progress.total ? `${progress.watched} von ${progress.total}` : `${progress.watched} gesehen`
  // An address that does not answer leaves the number, not a broken image.
  const [broken, setBroken] = useState<string | null>(null)
  const poster = cover && cover !== broken ? cover : undefined
  const own = poster ? coverShapes.get(poster) : null
  const fills = typeof own === 'number' && Math.abs(own - shape) < 0.01
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${name}: ${counted}${progress.complete ? ', alles gesehen' : `, weiter mit ${unit} ${progress.next}`}${current ? ', hier sind Sie' : ''}`}
      className="press group flex min-w-0 flex-col gap-[10px] rounded-card text-left"
    >
      <span
        className={`relative block w-full overflow-hidden rounded-card ${poster ? 'bg-stage' : 'bg-panel-mid'} ${
          current ? 'ring-2 ring-ink ring-offset-2 ring-offset-canvas' : ''
        }`}
        style={{ aspectRatio: `1 / ${shape}` }}
      >
        {poster ? (
          <>
            {fills ? null : (
              <img aria-hidden src={poster} alt="" className="absolute inset-0 h-full w-full scale-125 object-cover blur-2xl" />
            )}
            <img
              src={poster}
              alt=""
              loading="lazy"
              onError={() => setBroken(poster)}
              className={`absolute inset-0 h-full w-full ${fills ? 'object-cover' : 'object-contain'} transition-transform duration-[var(--dur-slow)] ease-[var(--ease-settle)] group-hover:scale-[1.04]`}
            />
          </>
        ) : (
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center text-ink/30 transition-opacity duration-[var(--dur-base)] group-hover:opacity-0 group-focus-visible:opacity-0"
          >
            {season.number === 0 ? <FilmIcon /> : <span className="font-display text-[clamp(48px,7vw,84px)] leading-none">{season.number}</span>}
          </span>
        )}

        {/* The numbers, on hover and on keyboard focus: a shade rising from
            the bottom, so the picture stays in view above them. It used to
            cover the whole poster in near-black. */}
        <span
          aria-hidden
          className={`absolute inset-x-0 bottom-0 flex translate-y-[6px] flex-col gap-[6px] px-[14px] pb-[14px] pt-[64px] opacity-0 transition-[opacity,translate] duration-[var(--dur-base)] ease-[var(--ease-settle)] group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 ${
            poster ? 'bg-gradient-to-t from-stage/80 via-stage/45 to-transparent text-stage-ink' : 'text-ink'
          }`}
        >
          <span className="flex items-baseline gap-[8px]">
            <span className="text-heading-sm leading-none">
              {progress.fraction !== null ? `${Math.round(progress.fraction * 100)} %` : progress.watched}
            </span>
            <span className={`text-small ${poster ? 'text-stage-ink/85' : 'text-prose'}`}>
              {progress.fraction !== null ? 'gesehen' : progress.watched === 1 ? `${unit} gesehen` : `${unit === 'Film' ? 'Filme' : 'Folgen'} gesehen`}
            </span>
          </span>
          <span className="text-small font-semibold">
            {progress.complete
              ? 'Alles gesehen'
              : progress.total
                ? `Noch ${progress.total - progress.watched} · weiter mit ${unit} ${progress.next}`
                : `Weiter mit ${unit} ${progress.next}`}
          </span>
        </span>
      </span>

      <span className="flex flex-col gap-[6px] px-[2px]">
        <span className="flex min-w-0 items-baseline justify-between gap-[8px]">
          <span className="min-w-0 truncate text-body font-semibold text-ink">{name}</span>
          <span className="value flex shrink-0 items-center gap-[4px] text-small text-prose">
            {progress.complete ? <RowMark state="done" /> : null}
            {progress.total ? `${progress.watched}/${progress.total}` : `${progress.watched} gesehen`}
          </span>
        </span>
        <ProgressBar fraction={progress.fraction ?? (progress.watched > 0 ? null : 0)} label={`${name}: gesehen`} />
        {current ? (
          <span className="text-small text-ink">
            Hier sind Sie{episode ? ` · ${unit} ${episode}` : ''}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* A season, opened                                                            */
/* -------------------------------------------------------------------------- */

function SeasonDialog({ item, number, onClose }: { item: SavedLinkItem; number: number; onClose: () => void }) {
  const openHere = useOpenHere()
  const season = seasonsOf(item).find((entry) => entry.number === number)
  if (!season) return null
  const progress = seasonProgress(season)
  const name = seasonName(season)
  const unit = number === 0 ? 'Film' : 'Folge'
  const units = number === 0 ? 'Filme' : 'Folgen'
  const highestSeen = season.watched.length ? Math.max(...season.watched) : 0
  const shownCount = season.episodes ?? Math.max(12, highestSeen + 4, item.season === number && item.episode ? item.episode + 4 : 0)
  const isHere = item.season === number

  // Ticking episodes moves „Hier sind Sie" to the first one not seen — from
  // this season on, and to „Fertig" once nothing is left.
  const setSeasons = (seasons: MerkSeason[]) => updateMerkItem(item.id, settle(item, seasons, number))
  const patchSeason = (change: Partial<MerkSeason>) => {
    const seasons = withSeason(item, number, (entry) => ({ ...entry, ...change }))
    const shorter = isHere && item.episode !== null && change.episodes != null && item.episode > change.episodes
    const longer = statusOf(item) === 'done' && caughtUp(seasonsOf(item)) && !caughtUp(seasons)
    // A count that cuts off where the entry stands, or that adds episodes to
    // a series seen to the end, moves the position; a name or a cover does not.
    updateMerkItem(item.id, shorter || longer ? settle(item, seasons, item.season) : { seasons })
  }

  return (
    <Dialog open onClose={onClose} title={`${item.title} · ${name}`}>
      <div className="flex flex-col gap-[20px]">
        <div className="flex flex-col gap-[16px] sm:flex-row sm:items-end">
          {season.cover ?? item.cover ? (
            <img
              src={season.cover ?? item.cover}
              alt=""
              className="block h-auto max-h-[200px] w-[96px] shrink-0 rounded-card bg-panel-mid object-cover"
            />
          ) : (
            <span className="relative aspect-[2/3] w-[96px] shrink-0 overflow-hidden rounded-card bg-panel-mid">
              <span aria-hidden className="absolute inset-0 flex items-center justify-center text-ink/30">
                {number === 0 ? <FilmIcon /> : <span className="display-md">{number}</span>}
              </span>
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-[8px]">
            <p className="text-heading-sm text-ink">
              {progress.total ? `${progress.watched} von ${progress.total} ${units}` : `${progress.watched} ${progress.watched === 1 ? unit : units}`}{' '}
              <span className="text-body text-muted">gesehen</span>
            </p>
            <ProgressBar fraction={progress.fraction} label={`${name}: gesehen`} />
            <p className="text-small text-prose">
              {progress.complete
                ? 'Alles gesehen.'
                : progress.total
                  ? `Noch ${progress.total - progress.watched} — weiter mit ${unit} ${progress.next}.`
                  : `Weiter mit ${unit} ${progress.next}. Wie viele es gibt, steht unten.`}
            </p>
          </div>
          {isHere && item.episode !== null && !progress.complete ? (
            <span className="flex flex-wrap gap-[8px]">
              {item.url.trim() ? (
                <Button
                  type="button"
                  onClick={() => {
                    openHere(item)
                    onClose()
                  }}
                >
                  {hereLabel(item)} laden
                </Button>
              ) : null}
              <Button type="button" variant={item.url.trim() ? 'quiet' : 'primary'} onClick={() => markSeen(item)}>
                {hereLabel(item)} gesehen
              </Button>
            </span>
          ) : !progress.complete ? (
            <Button type="button" variant="quiet" onClick={() => updateMerkItem(item.id, settle(item, seasonsOf(item), number))}>
              Hier weiterschauen
            </Button>
          ) : null}
        </div>

        <div className="flex flex-col gap-[10px] border-t border-line pt-[12px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[4px]">
            <span className="text-small text-prose">
              {units} — antippen zum Abhaken
            </span>
            <span className="flex gap-[16px] text-small">
              <button
                type="button"
                disabled={!season.episodes}
                onClick={() => season.episodes && setSeasons(watchedUpTo(item, number, season.episodes))}
                className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink disabled:opacity-40 disabled:no-underline"
              >
                Alle gesehen
              </button>
              <button
                type="button"
                disabled={season.watched.length === 0}
                onClick={() => setSeasons(withSeason(item, number, (entry) => ({ ...entry, watched: [] })))}
                className="press rounded-nav text-muted hover:text-ink disabled:opacity-40"
              >
                Zurücksetzen
              </button>
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-[6px]">
            {Array.from({ length: shownCount }, (_, i) => i + 1).map((episode) => {
              const seen = season.watched.includes(episode)
              const here = isHere && item.episode === episode
              return (
                <button
                  key={episode}
                  type="button"
                  aria-pressed={seen}
                  aria-label={`${unit} ${episode}${seen ? ', gesehen' : ''}${here ? ', hier sind Sie' : ''}`}
                  title="Klicken: gesehen / nicht gesehen · Umschalt-Klick: alles bis hier"
                  onClick={(event) => {
                    setSeasons(event.shiftKey ? watchedUpTo(item, number, episode) : toggleWatched(item, number, episode))
                  }}
                  className={`press value flex h-[40px] items-center justify-center rounded-nav text-small transition-colors ${
                    seen ? 'bg-ink text-on-ink' : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid'
                  } ${here ? 'ring-2 ring-inset ring-ink' : ''}`}
                >
                  {episode}
                </button>
              )
            })}
          </div>
          {season.episodes === null ? (
            <p className="text-small text-muted">
              Wie viele {units} diese Staffel hat, ist noch nicht gesagt — bis dahin stehen hier so viele, wie gebraucht werden.
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
          <Line label={`Wie viele ${units}`}>
            <div className="flex flex-wrap items-center gap-[12px]">
              {season.episodes !== null ? (
                <Stepper label={`Anzahl ${units}`} value={season.episodes} max={2000} onChange={(episodes) => patchSeason({ episodes })} />
              ) : null}
              <div className="w-max">
                <Toggle
                  label="Noch unbekannt"
                  checked={season.episodes === null}
                  onChange={(unknown) => patchSeason({ episodes: unknown ? null : Math.max(highestSeen, 12) })}
                />
              </div>
            </div>
          </Line>
          <Line label="Name">
            <TextInput
              value={season.title ?? ''}
              placeholder={number === 0 ? 'Filme' : `Staffel ${number}`}
              onChange={(event) => patchSeason({ title: event.target.value || undefined })}
              className="font-sans"
            />
          </Line>
          <Line wide>
            <CoverField
              label="Cover dieser Staffel (sonst das der Serie)"
              value={season.cover}
              onChange={(cover) => patchSeason({ cover })}
            />
          </Line>
          {seasonsOf(item).length > 1 ? (
            <Line wide>
              <button
                type="button"
                onClick={() => {
                  const rest = withSeason(item, number, () => null)
                  const fallback = rest[0]
                  updateMerkItem(item.id, {
                    seasons: rest,
                    ...(item.season === number && fallback ? { season: fallback.number, episode: seasonProgress(fallback).next } : {}),
                  })
                  onClose()
                }}
                className="press self-start rounded-nav text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
              >
                {name} entfernen
              </button>
            </Line>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* A series, edited                                                            */
/* -------------------------------------------------------------------------- */

function SeriesDialog({ item, onClose, onRemove }: { item: SavedLinkItem; onClose: () => void; onRemove: () => void }) {
  const update = (patch: Partial<SavedLinkItem>) => updateMerkItem(item.id, patch)
  const seasons = seasonsOf(item)
  const hasFilms = seasons.some((season) => season.number === 0)
  const kind = episodeKindOf(item.url)
  return (
    <Dialog open onClose={onClose} title={item.title || 'Ohne Namen'}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
        <Line label="Name">
          <TextInput value={item.title} onChange={(event) => update({ title: event.target.value })} className="font-sans" />
        </Line>
        <Line label="Stand">
          <ChoiceRow value={statusOf(item)} options={STATUS_OPTIONS} onChange={(status) => update({ status })} />
        </Line>
        <Line label="Adresse (leer lassen, wenn nichts geladen werden soll)" wide>
          <TextInput
            value={item.url}
            placeholder="https://…"
            inputMode="url"
            spellCheck={false}
            onChange={(event) => update({ url: event.target.value })}
          />
        </Line>
        <Line wide>
          <CoverField value={item.cover} onChange={(cover) => update({ cover })} />
        </Line>
        <Line label="Bewertung">
          <Rating value={item.rating ?? 0} onChange={(rating) => update({ rating })} />
        </Line>
        <Line label="Staffeln und Filme">
          <span className="text-small text-prose">
            {seasons.filter((season) => season.number > 0).length} Staffeln{hasFilms ? ', dazu Filme' : ''}. Einzelne Staffeln
            über ihre Kachel.
          </span>
          {!hasFilms ? (
            <button
              type="button"
              onClick={() => update({ seasons: [...seasons, { number: 0, episodes: null, watched: [] }] })}
              className="press self-start rounded-nav text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
            >
              Filme hinzufügen
            </button>
          ) : null}
        </Line>
        <Line label="Notiz" wide>
          <textarea
            value={item.notes ?? ''}
            onChange={(event) => update({ notes: event.target.value || undefined })}
            placeholder="Wo es spannend wurde, mit wem Sie schauen, was Sie nicht vergessen wollen …"
            className={textAreaClass}
          />
        </Line>
        <Line label="Laden als">
          <div className="flex flex-wrap items-center gap-[8px]">
            <ChoiceRow
              value={item.mode}
              options={[
                { value: 'video', label: 'Video mit Ton' },
                { value: 'audio', label: 'Nur Ton' },
              ]}
              onChange={(mode) => update({ mode })}
            />
            {item.mode === 'audio' ? (
              <Select
                aria-label="Tonformat"
                value={item.audioFormat}
                onChange={(event) => update({ audioFormat: event.target.value as AudioOutputFormat })}
                className="w-auto! py-[6px]"
              >
                {AUDIO_FORMATS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>
        </Line>
        <Line label="Qualität">
          {item.mode === 'audio' ? (
            <Select value={item.audioPref} onChange={(event) => update({ audioPref: event.target.value as AudioFilePref })}>
              {AUDIO_QUALITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (
            <Select value={item.videoPref} onChange={(event) => update({ videoPref: event.target.value as VideoFilePref })}>
              {VIDEO_QUALITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Line>
        {kind !== 'list' ? (
          <Line label="Sprachfassung">
            <Select value={item.language} onChange={(event) => update({ language: event.target.value as SavedLinkItem['language'] })}>
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Line>
        ) : null}
        <Line>
          <Toggle
            label="Untertitel dazu erstellen"
            hint="Whisper schreibt nach dem Laden auf diesem Gerät mit."
            checked={item.autoTranscribe}
            onChange={(autoTranscribe) => update({ autoTranscribe })}
          />
        </Line>
        <Line wide>
          <div className="flex flex-wrap items-center justify-between gap-[12px]">
            <span className="text-small text-muted">Änderungen gelten sofort.</span>
            <span className="flex items-center gap-[16px]">
              <button
                type="button"
                onClick={onRemove}
                className="press rounded-nav text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
              >
                Von der Merkliste nehmen
              </button>
              <Button type="button" size="sm" onClick={onClose}>
                Fertig
              </Button>
            </span>
          </div>
        </Line>
      </div>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* A series, added                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Episodes per season, as typed: a season nobody touched has as many as the
 * one before it, so a series of equal seasons is one number and the one
 * season that differs is one more.
 */
function episodeCounts(typed: (number | undefined)[], seasonCount: number): number[] {
  const counts: number[] = []
  for (let i = 0; i < seasonCount; i += 1) counts.push(typed[i] ?? counts[i - 1] ?? 12)
  return counts
}

function AddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [seasonCount, setSeasonCount] = useState(1)
  const [typedCounts, setTypedCounts] = useState<(number | undefined)[]>([])
  const [countsUnknown, setCountsUnknown] = useState(false)
  const [films, setFilms] = useState(0)
  const [atSeason, setAtSeason] = useState(1)
  const [atEpisode, setAtEpisode] = useState(1)
  const [cover, setCover] = useState<string | undefined>(undefined)

  const counts = episodeCounts(typedCounts, seasonCount)
  const position = Math.min(atSeason, seasonCount)
  const positionCount = countsUnknown ? null : counts[position - 1]
  const setCount = (index: number, value: number) =>
    setTypedCounts((current) => {
      const next = [...current]
      next[index] = value
      return next
    })

  const reset = () => {
    setTitle('')
    setUrl('')
    setSeasonCount(1)
    setTypedCounts([])
    setCountsUnknown(false)
    setFilms(0)
    setAtSeason(1)
    setAtEpisode(1)
    setCover(undefined)
  }

  const save = () => {
    const episode = positionCount === null ? atEpisode : Math.min(atEpisode, positionCount)
    const seasons: MerkSeason[] = Array.from({ length: seasonCount }, (_, i) => {
      const number = i + 1
      const episodes = countsUnknown ? null : counts[i]
      const before = number < position ? (episodes ?? 0) : number === position ? episode - 1 : 0
      return { number, episodes, watched: Array.from({ length: Math.max(0, before) }, (_, n) => n + 1) }
    })
    if (films > 0) seasons.push({ number: 0, episodes: films, watched: [] })
    const address = url.trim() ? (/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`) : ''
    const item = createMerkItem({
      title: title.trim() || undefined,
      url: address ? buildUrlWithEpisode(address, position, episode) : '',
      season: position,
      episode,
      seasons,
      cover,
      status: 'watching',
    })
    setMerkItems((current) => [item, ...current])
    reset()
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Serie hinzufügen">
      <form
        className="grid grid-cols-[minmax(0,1fr)] gap-x-[32px] gap-y-[4px] sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (title.trim() || url.trim()) save()
        }}
      >
        <Line label="Name">
          <TextInput autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Wie die Serie heisst" className="font-sans" />
        </Line>
        <Line label="Adresse (wahlweise)">
          <TextInput value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" inputMode="url" spellCheck={false} />
        </Line>
        <Line label="Staffeln">
          <Stepper label="Anzahl Staffeln" value={seasonCount} max={60} onChange={setSeasonCount} />
        </Line>
        <Line label="Filme dazu">
          <Stepper label="Anzahl Filme" value={films} min={0} max={200} onChange={setFilms} />
        </Line>
        <Line label={seasonCount > 1 ? 'Folgen je Staffel' : 'Folgen'} wide>
          {countsUnknown ? null : seasonCount > 1 ? (
            <>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(184px,1fr))] gap-x-[20px] gap-y-[8px]">
                {counts.map((count, i) => (
                  <span key={i} className="flex items-center justify-between gap-[10px] text-small text-prose">
                    Staffel {i + 1}
                    <Stepper label={`Folgen in Staffel ${i + 1}`} value={count} max={2000} onChange={(value) => setCount(i, value)} />
                  </span>
                ))}
              </div>
              <span className="text-small text-muted">Jede Staffel übernimmt die Zahl der vorigen, bis Sie sie ändern.</span>
            </>
          ) : (
            <Stepper label="Anzahl Folgen" value={counts[0]} max={2000} onChange={(value) => setCount(0, value)} />
          )}
          <div className="w-max">
            <Toggle label="Noch unbekannt" checked={countsUnknown} onChange={setCountsUnknown} />
          </div>
        </Line>
        <Line label="Gerade bei" wide>
          <span className="flex flex-wrap items-center gap-[12px] text-small text-prose">
            <span className="flex items-center gap-[8px]">
              Staffel <Stepper label="Gerade bei Staffel" value={position} max={seasonCount} onChange={setAtSeason} />
            </span>
            <span className="flex items-center gap-[8px]">
              Folge{' '}
              <Stepper
                label="Gerade bei Folge"
                value={positionCount === null ? atEpisode : Math.min(atEpisode, positionCount)}
                max={positionCount ?? 2000}
                onChange={setAtEpisode}
              />
              {positionCount !== null ? <span className="value text-muted">von {positionCount}</span> : null}
            </span>
          </span>
        </Line>
        <Line wide>
          <CoverField value={cover} onChange={setCover} />
        </Line>
        <Line wide>
          <div className="flex flex-wrap items-center justify-between gap-[12px]">
            <span className="text-small text-muted">
              Was vor „Gerade bei“ liegt, gilt als gesehen. Alles lässt sich später ändern.
            </span>
            <span className="flex gap-[8px]">
              <Button type="button" size="sm" variant="quiet" onClick={onClose}>
                Abbrechen
              </Button>
              <Button type="submit" size="sm" disabled={!title.trim() && !url.trim()}>
                Auf die Merkliste
              </Button>
            </span>
          </div>
        </Line>
      </form>
    </Dialog>
  )
}
