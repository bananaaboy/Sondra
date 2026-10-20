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

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { buildUrlWithEpisode, saveBytes, sourceBadgeForUrl } from '../../lib/download'
import {
  advance,
  caughtUp,
  coverFromFile,
  createMerkItem,
  exportMerkliste,
  itemProgress,
  halve,
  markRange,
  mergeMerkliste,
  merkSaveFailed,
  partName,
  partOfEpisode,
  partProgress,
  partsOf,
  pictureSize,
  readMerklisteFile,
  requestLookup,
  seasonName,
  seasonProgress,
  seasonsOf,
  setMerkItems,
  settle,
  splitSeason,
  storedParts,
  toggleWatched,
  updateMerkItem,
  useMerkliste,
  watchedUpTo,
  withParts,
  withSeason,
  type CoverFrame,
  type MerkPart,
  type MerkSeason,
  type Picture,
  type SeasonPart,
  type SavedLinkItem,
  type SavedLinkStatus,
} from '../../lib/merkliste'
import { useSession } from '../../state/store'
import { ChoiceRow } from '../editor/EditorShell'
import { Button, Card, Dialog, Notice, RowMark, Select, Slider, TextInput, Toggle } from '../ui/primitives'
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
 * A cover from an address or from a file, and the part of it a tile shows.
 * A file is made small first (`coverFromFile`) — it lives in the list on
 * this device. Every tile is a 2:3 poster; the preview here is one, and the
 * picture in it can be dragged (or moved with the arrow keys) and zoomed to
 * choose what shows. Without that, the middle.
 */
function CoverField({
  value,
  frame,
  onChange,
  label = 'Cover',
}: {
  value: string | undefined
  frame?: CoverFrame
  /** A new picture comes without a frame; a new frame keeps the picture. */
  onChange: (value: string | undefined, frame: CoverFrame | undefined) => void
  label?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(value && !value.startsWith('data:') ? value : '')
  const [problem, setProblem] = useState<string | null>(null)
  const [live, setLive] = useState<CoverFrame | undefined>(frame)

  // Dragging changes the frame many times a second; the list is written once
  // it rests — and still written if the window closes before that.
  const pending = useRef<{ timer: number; frame: CoverFrame | undefined } | null>(null)
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }
  const frameKey = frame ? `${frame.x}/${frame.y}/${frame.zoom}` : ''
  useEffect(() => {
    if (!pending.current) setLive(frame)
    // `frameKey` stands for `frame`, which is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey, value])
  useEffect(
    () => () => {
      const waiting = pending.current
      if (!waiting) return
      clearTimeout(waiting.timer)
      latest.current.onChange(latest.current.value, waiting.frame)
    },
    [],
  )
  const setFrame = (next: CoverFrame | undefined) => {
    setLive(next)
    if (pending.current) clearTimeout(pending.current.timer)
    const timer = window.setTimeout(() => {
      pending.current = null
      latest.current.onChange(latest.current.value, next)
    }, 250)
    pending.current = { timer, frame: next }
  }
  const pick = (picture: string | undefined) => {
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = null
    setLive(undefined)
    onChange(picture, undefined)
  }
  const zoom = live?.zoom ?? 1

  return (
    <div className="flex flex-col gap-[8px]">
      <span className="text-small text-prose">{label}</span>
      <div className="flex flex-col gap-[14px] sm:flex-row">
        {value ? (
          <FrameEditor
            src={value}
            frame={live}
            onFrame={setFrame}
            onError={() => setProblem('Unter dieser Adresse liess sich kein Bild laden.')}
            onLoad={() => setProblem(null)}
          />
        ) : (
          <span className="relative aspect-[2/3] w-[120px] shrink-0 overflow-hidden rounded-card bg-panel-mid ring-1 ring-inset ring-line">
            <span className="absolute inset-0 flex items-center justify-center text-small text-prose">kein Bild</span>
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
              if (next !== (value && !value.startsWith('data:') ? value : '')) pick(next || undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                pick(draft.trim() || undefined)
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
                  pick(undefined)
                }}
                className="press rounded-nav text-prose hover:text-ink"
              >
                Entfernen
              </button>
            ) : null}
          </span>
          {problem ? <span className="text-small text-ink">! {problem}</span> : null}
          {value ? (
            <div className="mt-[4px] flex max-w-[360px] flex-col gap-[8px] border-t border-line pt-[10px]">
              <Slider
                label="Zoom"
                display={`${zoom.toFixed(1).replace('.', ',')} ×`}
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                onChange={(event) => setFrame({ ...(live ?? MIDDLE), zoom: Number(event.target.value) })}
              />
              <span className="flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[4px] text-small">
                <span className="text-prose">Bild ziehen, um den Ausschnitt zu wählen.</span>
                {live ? (
                  <button type="button" onClick={() => setFrame(undefined)} className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink">
                    Zurücksetzen
                  </button>
                ) : null}
              </span>
            </div>
          ) : null}
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
                pick(picture)
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

/**
 * The tile, to choose its part of the cover: drag the picture, or move it
 * with the arrow keys; plus and minus zoom. The picture follows the pointer
 * one to one — a drag across the whole range moves the frame from one edge
 * of the picture to the other.
 */
function FrameEditor({
  src,
  frame,
  onFrame,
  onError,
  onLoad,
}: {
  src: string
  frame: CoverFrame | undefined
  onFrame: (frame: CoverFrame | undefined) => void
  onError: () => void
  onLoad: () => void
}) {
  const boxRef = useRef<HTMLSpanElement>(null)
  const natural = useRef<{ width: number; height: number } | null>(null)
  const drag = useRef<{ x: number; y: number; start: CoverFrame } | null>(null)
  const current = frame ?? MIDDLE
  const clampPercent = (value: number) => Math.min(100, Math.max(0, value))

  // How far, in screen pixels, the picture can travel across the tile on each
  // axis at a zoom: the picture as it covers the tile, scaled, less the tile.
  const travel = (zoom: number) => {
    const box = boxRef.current
    const picture = natural.current
    if (!box || !picture) return { x: 0, y: 0 }
    const fit = Math.max(box.clientWidth / picture.width, box.clientHeight / picture.height)
    return { x: zoom * picture.width * fit - box.clientWidth, y: zoom * picture.height * fit - box.clientHeight }
  }
  const moveBy = (start: CoverFrame, dx: number, dy: number) => {
    const room = travel(start.zoom)
    onFrame({
      ...start,
      x: room.x > 0.5 ? clampPercent(start.x - (dx / room.x) * 100) : start.x,
      y: room.y > 0.5 ? clampPercent(start.y - (dy / room.y) * 100) : start.y,
    })
  }

  return (
    <span
      ref={boxRef}
      tabIndex={0}
      role="group"
      aria-label="Ausschnitt des Covers: ziehen oder Pfeiltasten, Plus und Minus zoomen"
      className="relative aspect-[2/3] w-[140px] shrink-0 cursor-grab touch-none overflow-hidden rounded-card bg-stage outline-none ring-1 ring-line focus-visible:ring-2 focus-visible:ring-ink active:cursor-grabbing"
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, y: event.clientY, start: current }
      }}
      onPointerMove={(event) => {
        const held = drag.current
        if (held) moveBy(held.start, event.clientX - held.x, event.clientY - held.y)
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10
        const zoomTo = (zoom: number) => onFrame({ ...current, zoom: Math.min(3, Math.max(1, Math.round(zoom * 20) / 20)) })
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [step, 0],
          ArrowRight: [-step, 0],
          ArrowUp: [0, step],
          ArrowDown: [0, -step],
        }
        if (moves[event.key]) moveBy(current, ...moves[event.key])
        else if (event.key === '+' || event.key === '=') zoomTo(current.zoom + 0.1)
        else if (event.key === '-') zoomTo(current.zoom - 0.1)
        else return
        event.preventDefault()
      }}
    >
      <CoverImage
        src={src}
        frame={frame}
        onError={onError}
        onLoad={(size) => {
          natural.current = size
          onLoad()
        }}
      />
    </span>
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
  const [season, setSeason] = useState<{ id: string; number: number; part: number } | null>(null)
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
            onSeason={(number, part) => setSeason({ id: item.id, number, part })}
          />
        ))
      )}

      <Transfer items={items} />

      <AddDialog open={adding} onClose={() => setAdding(false)} />
      {editingItem ? (
        <SeriesDialog item={editingItem} onClose={() => setEditing(null)} onRemove={() => remove(editingItem)} />
      ) : null}
      {seasonItem && season ? (
        <SeasonDialog
          item={seasonItem}
          number={season.number}
          part={season.part}
          onPart={(part) => setSeason({ ...season, part })}
          onClose={() => setSeason(null)}
        />
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
/* Covers in a tile                                                            */
/* -------------------------------------------------------------------------- */

const MIDDLE: CoverFrame = { x: 50, y: 50, zoom: 1 }

/**
 * A loaded cover and the same picture at half, a quarter, an eighth … of its
 * size, made once and shared by every tile that shows it. Each drawing picks
 * the step just larger than it needs and makes only one short last step from
 * there.
 */
interface CoverSource {
  width: number
  height: number
  levels: Picture[]
}

const coverSources = new Map<string, Promise<CoverSource>>()

function loadCover(src: string): Promise<CoverSource> {
  const known = coverSources.get(src)
  if (known) return known
  const loading = new Promise<CoverSource>((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () =>
      image.naturalWidth && image.naturalHeight
        ? resolve({ width: image.naturalWidth, height: image.naturalHeight, levels: [image] })
        : reject(new Error('empty'))
    image.onerror = () => reject(new Error('unreadable'))
    image.src = src
  })
  // A cover that failed may answer later; it is not remembered as broken.
  loading.catch(() => coverSources.delete(src))
  coverSources.set(src, loading)
  return loading
}

function coverLevel(source: CoverSource, step: number): Picture {
  while (source.levels.length <= step) {
    const next = halve(source.levels[source.levels.length - 1])
    if (!next) break
    source.levels.push(next)
  }
  return source.levels[Math.min(step, source.levels.length - 1)]
}

/**
 * Draws the part of a cover a frame chooses onto a canvas of w × h device
 * pixels — the same part `object-fit: cover`, `object-position` and a
 * scale around that point would show, worked out here instead of left to the
 * browser's own downscaling.
 */
function drawCover(canvas: HTMLCanvasElement, source: CoverSource, frame: CoverFrame | undefined, w: number, h: number) {
  const { x, y, zoom } = frame ?? MIDDLE
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const context = canvas.getContext('2d')
  if (!context) return
  const fit = Math.max(w / source.width, h / source.height)
  const left = (w - source.width * fit) * (x / 100)
  const top = (h - source.height * fit) * (y / 100)
  const originX = w * (x / 100)
  const originY = h * (y / 100)
  const sw = w / zoom / fit
  const sh = h / zoom / fit
  const sx = Math.min(source.width - sw, Math.max(0, (originX * (1 - 1 / zoom) - left) / fit))
  const sy = Math.min(source.height - sh, Math.max(0, (originY * (1 - 1 / zoom) - top) / fit))
  // The half-size step whose part is still at least as large as the canvas.
  const step = sw > w ? Math.floor(Math.log2(sw / w)) : 0
  const level = coverLevel(source, step)
  const scale = pictureSize(level).width / source.width
  context.clearRect(0, 0, w, h)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(level, sx * scale, sy * scale, sw * scale, sh * scale, 0, 0, w, h)
}

/**
 * A cover filling its box, showing the part someone chose (`CoverFrame`),
 * drawn at exactly the box's device pixels (`drawCover`). As an `<img>` the
 * browser squeezed a large poster into a tile in one step, and it looked
 * over-sharpened; and a frame chosen in the editor looks the same on every
 * tile.
 */
function CoverImage({
  src,
  frame,
  onError,
  onLoad,
}: {
  src: string
  frame?: CoverFrame
  onError?: () => void
  /** With the picture's own size, once it is there. */
  onLoad?: (size: { width: number; height: number }) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loaded, setLoaded] = useState<{ src: string; source: CoverSource } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const callbacks = useRef({ onError, onLoad })
  callbacks.current = { onError, onLoad }

  useEffect(() => {
    let alive = true
    loadCover(src).then(
      (source) => {
        if (!alive) return
        setLoaded({ src, source })
        callbacks.current.onLoad?.({ width: source.width, height: source.height })
      },
      () => {
        if (alive) callbacks.current.onError?.()
      },
    )
    return () => {
      alive = false
    }
  }, [src])

  // The box in device pixels, so one pixel drawn is one pixel shown — also
  // after the page is zoomed or the window moves to another screen.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(([entry]) => {
      // The exact device box where it is right; where it disagrees with the
      // CSS box times the pixel ratio by more than rounding (an emulated
      // ratio, an older engine), the product.
      const device = entry.devicePixelContentBoxSize?.[0]
      const pick = (exact: number | undefined, css: number) => {
        const scaled = css * devicePixelRatio
        return Math.max(1, Math.round(exact !== undefined && Math.abs(exact - scaled) <= 1 ? exact : scaled))
      }
      const w = pick(device?.inlineSize, entry.contentRect.width)
      const h = pick(device?.blockSize, entry.contentRect.height)
      setSize((old) => (old && old.w === w && old.h === h ? old : { w, h }))
    })
    try {
      observer.observe(canvas, { box: 'device-pixel-content-box' })
    } catch {
      observer.observe(canvas)
    }
    return () => observer.disconnect()
  }, [])

  const source = loaded && loaded.src === src ? loaded.source : null
  const { x, y, zoom } = frame ?? MIDDLE
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (canvas && source && size) drawCover(canvas, source, { x, y, zoom }, size.w, size.h)
  }, [source, size, x, y, zoom])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={`absolute inset-0 h-full w-full transition-opacity duration-[var(--dur-base)] ${source && size ? 'opacity-100' : 'opacity-0'}`}
    />
  )
}

/* -------------------------------------------------------------------------- */
/* One series                                                                  */
/* -------------------------------------------------------------------------- */

function Series({
  item,
  onEdit,
  onSeason,
}: {
  item: SavedLinkItem
  onEdit: () => void
  onSeason: (number: number, part: number) => void
}) {
  const openHere = useOpenHere()
  const seasons = seasonsOf(item)
  const progress = itemProgress(item)
  const status = statusOf(item)
  const kind = episodeKindOf(item.url) ?? 'series'
  const last = whenLabel(item.lastOpenedAt)
  // A season in parts is a tile per part.
  const tiles = seasons.flatMap((season) => partsOf(season).map((part) => ({ season, part })))
  // The nearest cover with its frame: the part's, the season's, the series'.
  const coverOf = (season: MerkSeason, part: SeasonPart) =>
    part.cover
      ? { src: part.cover, frame: part.coverFrame }
      : season.cover
        ? { src: season.cover, frame: season.coverFrame }
        : item.cover
          ? { src: item.cover, frame: item.coverFrame }
          : null

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
        {tiles.map(({ season, part }) => (
          <SeasonTile
            key={`${season.number}-${part.index}`}
            season={season}
            part={part}
            cover={coverOf(season, part)}
            current={status !== 'done' && season.number === item.season && partOfEpisode(season, item.episode).index === part.index}
            episode={item.episode}
            onOpen={() => onSeason(season.number, part.index)}
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
 * One season as a poster: 2:3 like every other tile, showing the part of the
 * cover someone chose in the cover field (`CoverImage`), with nothing laid
 * over it — and under it the name, the count and a bar for what is seen. The
 * caption used to sit on the picture and hid the bottom third of every
 * poster, a pill sat on its logo. Hover or focus brings up the numbers; a
 * click opens the season.
 */
function SeasonTile({
  season,
  part,
  cover,
  current,
  episode,
  onOpen,
}: {
  season: MerkSeason
  part: SeasonPart
  cover: { src: string; frame?: CoverFrame } | null
  current: boolean
  /** Where the entry stands, for „Hier sind Sie · Folge 4". */
  episode: number | null
  onOpen: () => void
}) {
  const progress = partProgress(season, part)
  const name = partName(season, part)
  const unit = season.number === 0 ? 'Film' : 'Folge'
  const counted = progress.total ? `${progress.watched} von ${progress.total}` : `${progress.watched} gesehen`
  const split = (season.parts?.length ?? 0) > 1
  // An address that does not answer leaves the number, not a broken image.
  const [broken, setBroken] = useState<string | null>(null)
  const poster = cover && cover.src !== broken ? cover : null
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${name}: ${counted}${progress.complete ? ', alles gesehen' : `, weiter mit ${unit} ${progress.next}`}${current ? ', hier sind Sie' : ''}`}
      className="press group flex min-w-0 flex-col gap-[10px] rounded-card text-left"
    >
      <span
        className={`relative block aspect-[2/3] w-full overflow-hidden rounded-card ${poster ? 'bg-stage' : 'bg-panel-mid'} ${
          current ? 'ring-2 ring-ink ring-offset-2 ring-offset-canvas' : ''
        }`}
      >
        {poster ? (
          <CoverImage src={poster.src} frame={poster.frame} onError={() => setBroken(poster.src)} />
        ) : (
          <span
            aria-hidden
            className="absolute inset-0 flex flex-col items-center justify-center gap-[6px] text-ink/30 transition-opacity duration-[var(--dur-base)] group-hover:opacity-0 group-focus-visible:opacity-0"
          >
            {season.number === 0 ? <FilmIcon /> : <span className="font-display text-[clamp(48px,7vw,84px)] leading-none">{season.number}</span>}
            {split ? <span className="text-body font-semibold text-ink/45">Teil {part.index + 1}</span> : null}
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

function SeasonDialog({
  item,
  number,
  part: partIndex,
  onPart,
  onClose,
}: {
  item: SavedLinkItem
  number: number
  /** Which part of the season is open; 0 when it is one piece. */
  part: number
  onPart: (part: number) => void
  onClose: () => void
}) {
  const openHere = useOpenHere()
  const season = seasonsOf(item).find((entry) => entry.number === number)
  if (!season) return null
  const parts = partsOf(season)
  const split = parts.length > 1
  const part = parts[Math.min(partIndex, parts.length - 1)]
  const last = part.index === parts.length - 1
  const progress = partProgress(season, part)
  const name = partName(season, part)
  const unit = number === 0 ? 'Film' : 'Folge'
  const units = number === 0 ? 'Filme' : 'Folgen'
  const cover = part.cover
    ? { src: part.cover, frame: part.coverFrame }
    : season.cover
      ? { src: season.cover, frame: season.coverFrame }
      : item.cover
        ? { src: item.cover, frame: item.coverFrame }
        : null
  const isHere = item.season === number && partOfEpisode(season, item.episode).index === part.index
  const seenHere = season.watched.filter((n) => n >= part.from && (part.to === null || n <= part.to))
  // Seen in this part, counted from its first episode.
  const reachedHere = seenHere.length ? Math.max(...seenHere) - part.from + 1 : 0
  const shownCount =
    part.episodes ?? Math.max(12, reachedHere + 4, isHere && item.episode ? item.episode - part.from + 1 + 4 : 0)

  // Ticking episodes moves „Hier sind Sie" to the first one not seen — from
  // this season on, and to „Fertig" once nothing is left.
  const setSeasons = (seasons: MerkSeason[]) => updateMerkItem(item.id, settle(item, seasons, number))
  const changeSeason = (change: (entry: MerkSeason) => MerkSeason) => {
    const seasons = withSeason(item, number, change)
    const updated = seasons.find((entry) => entry.number === number)
    const shorter = item.season === number && item.episode !== null && updated?.episodes != null && item.episode > updated.episodes
    const longer = statusOf(item) === 'done' && caughtUp(seasonsOf(item)) && !caughtUp(seasons)
    // A count that cuts off where the entry stands, or that adds episodes to
    // a series seen to the end, moves the position; a name or a cover does not.
    updateMerkItem(item.id, shorter || longer ? settle(item, seasons, item.season) : { seasons })
  }
  const patchSeason = (change: Partial<MerkSeason>) => changeSeason((entry) => ({ ...entry, ...change }))
  const patchPart = (change: Partial<MerkPart>) =>
    changeSeason((entry) => withParts(entry, storedParts(entry).map((stored, i) => (i === part.index ? { ...stored, ...change } : stored))))

  const addPart = () => {
    changeSeason((entry) => {
      const stored = storedParts(entry)
      const end = stored.length - 1
      // The part that was open gets a length before another follows it.
      if (stored[end].episodes === null) stored[end] = { ...stored[end], episodes: Math.max(12, reachedHere) }
      return withParts(entry, [...stored, { episodes: null }])
    })
    onPart(parts.length)
  }
  const removePart = () => {
    changeSeason((entry) => {
      const stored = storedParts(entry)
      // Its episodes go to the part before it (to the next one for the first).
      // An open part with nothing seen in it is simply taken away — the part
      // before keeps its length instead of becoming open as well.
      const into = part.index > 0 ? part.index - 1 : 1
      const a = stored[into].episodes
      const b = stored[part.index].episodes
      const episodes = b === null && seenHere.length === 0 ? a : a === null || b === null ? null : a + b
      stored[into] = { ...stored[into], episodes }
      return withParts(entry, stored.filter((_, i) => i !== part.index))
    })
    onPart(Math.max(0, part.index - 1))
  }

  return (
    <Dialog open onClose={onClose} title={`${item.title} · ${name}`}>
      <div className="flex flex-col gap-[20px]">
        {split ? (
          <ChoiceRow
            value={String(part.index)}
            options={parts.map((entry) => ({ value: String(entry.index), label: entry.title || `Teil ${entry.index + 1}` }))}
            onChange={(value) => onPart(Number(value))}
          />
        ) : null}

        <div className="flex flex-col gap-[16px] sm:flex-row sm:items-end">
          {cover ? (
            <span className="relative aspect-[2/3] w-[96px] shrink-0 overflow-hidden rounded-card bg-stage">
              <CoverImage src={cover.src} frame={cover.frame} />
            </span>
          ) : (
            <span className="relative aspect-[2/3] w-[96px] shrink-0 overflow-hidden rounded-card bg-panel-mid">
              <span aria-hidden className="absolute inset-0 flex flex-col items-center justify-center gap-[4px] text-ink/30">
                {number === 0 ? <FilmIcon /> : <span className="display-md">{number}</span>}
                {split ? <span className="text-small font-semibold text-ink/45">Teil {part.index + 1}</span> : null}
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
              {split && part.to !== null ? ` ${units} ${part.from} bis ${part.to} der Staffel.` : null}
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
            <Button
              type="button"
              variant="quiet"
              onClick={() =>
                updateMerkItem(item.id, {
                  season: number,
                  episode: progress.next,
                  status: statusOf(item) === 'done' ? 'watching' : statusOf(item),
                })
              }
            >
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
                disabled={part.to === null}
                onClick={() => part.to !== null && setSeasons(markRange(item, number, part.from, part.to, true))}
                className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink disabled:opacity-40 disabled:no-underline"
              >
                Alle gesehen
              </button>
              <button
                type="button"
                disabled={progress.watched === 0}
                onClick={() => setSeasons(markRange(item, number, part.from, part.to ?? Infinity, false))}
                className="press rounded-nav text-muted hover:text-ink disabled:opacity-40"
              >
                Zurücksetzen
              </button>
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-[6px]">
            {Array.from({ length: shownCount }, (_, i) => part.from + i).map((episode) => {
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
          {part.episodes === null ? (
            <p className="text-small text-muted">
              Wie viele {units} {split ? 'dieser Teil' : 'diese Staffel'} hat, ist noch nicht gesagt — bis dahin stehen hier so
              viele, wie gebraucht werden.
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
          <Line label={split ? `Wie viele ${units} in diesem Teil` : `Wie viele ${units}`}>
            <div className="flex flex-wrap items-center gap-[12px]">
              {part.episodes !== null ? (
                <Stepper
                  label={`Anzahl ${units}`}
                  value={part.episodes}
                  max={2000}
                  onChange={(episodes) => (split ? patchPart({ episodes }) : patchSeason({ episodes }))}
                />
              ) : null}
              {/* Only the last part can still be open; the ones before it
                  have to end somewhere for the next to begin. */}
              {last ? (
                <div className="w-max">
                  <Toggle
                    label="Noch unbekannt"
                    checked={part.episodes === null}
                    onChange={(unknown) => {
                      const episodes = unknown ? null : Math.max(reachedHere, 12)
                      if (split) patchPart({ episodes })
                      else patchSeason({ episodes })
                    }}
                  />
                </div>
              ) : null}
            </div>
          </Line>
          {split ? (
            <Line label="Name dieses Teils">
              <TextInput
                value={part.title ?? ''}
                placeholder={`${seasonName(season)} · Teil ${part.index + 1}`}
                onChange={(event) => patchPart({ title: event.target.value || undefined })}
                className="font-sans"
              />
            </Line>
          ) : null}
          <Line label={split ? 'Name der Staffel' : 'Name'}>
            <TextInput
              value={season.title ?? ''}
              placeholder={number === 0 ? 'Filme' : `Staffel ${number}`}
              onChange={(event) => patchSeason({ title: event.target.value || undefined })}
              className="font-sans"
            />
          </Line>
          <Line wide>
            {split ? (
              <CoverField
                label="Cover dieses Teils (sonst das der Staffel oder Serie)"
                value={part.cover}
                frame={part.coverFrame}
                onChange={(cover, coverFrame) => patchPart({ cover, coverFrame })}
              />
            ) : (
              <CoverField
                label="Cover dieser Staffel (sonst das der Serie)"
                value={season.cover}
                frame={season.coverFrame}
                onChange={(cover, coverFrame) => patchSeason({ cover, coverFrame })}
              />
            )}
          </Line>
          <Line wide>
            <div className="flex flex-wrap items-baseline gap-x-[20px] gap-y-[8px] text-small">
              {split ? (
                <>
                  <button type="button" onClick={addPart} className={linkClass}>
                    <PlusIcon />
                    Teil hinzufügen
                  </button>
                  <button type="button" onClick={removePart} className={linkClass}>
                    Diesen Teil auflösen
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    changeSeason(splitSeason)
                    onPart(0)
                  }}
                  className={linkClass}
                >
                  In Teile teilen
                </button>
              )}
              {seasonsOf(item).length > 1 ? (
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
                  className={linkClass}
                >
                  {seasonName(season)} entfernen
                </button>
              ) : null}
            </div>
            {split ? (
              <p className="text-small text-muted">
                Die {units} zählen durch die ganze Staffel, wie auf den Seiten: Teil 2 beginnt dort, wo Teil 1 endet. Ein aufgelöster
                Teil geht im Teil davor auf; nichts Gesehenes geht verloren.
              </p>
            ) : (
              <p className="text-small text-muted">
                Für Staffeln, die in Teilen erscheinen — jeder Teil wird eine eigene Kachel mit eigenem Cover.
              </p>
            )}
          </Line>
        </div>
      </div>
    </Dialog>
  )
}

const linkClass =
  'press inline-flex items-center gap-[6px] rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink'

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
          <CoverField value={item.cover} frame={item.coverFrame} onChange={(cover, coverFrame) => update({ cover, coverFrame })} />
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
  const [coverFrame, setCoverFrame] = useState<CoverFrame | undefined>(undefined)

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
    setCoverFrame(undefined)
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
      coverFrame,
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
          <CoverField
            value={cover}
            frame={coverFrame}
            onChange={(picture, frame) => {
              setCover(picture)
              setCoverFrame(frame)
            }}
          />
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
