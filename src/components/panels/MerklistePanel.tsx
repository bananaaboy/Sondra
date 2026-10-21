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

import {
  ANYTYPE_PROBLEM,
  anytype,
  anytypeAvailable,
  inStepWithAnytype,
  syncMerkliste,
  type AnytypeError,
  type AnytypeStatus,
  type FoundNote,
} from '../../lib/anytype'
import { buildUrlWithEpisode, deriveLinkTitle, parseLinkEpisodeInfo, saveBytes, sourceBadgeForUrl } from '../../lib/download'
import {
  advance,
  calculateBingePlan,
  calculateMerklisteStats,
  caughtUp,
  coverFromFile,
  createMerkItem,
  durationOfEpisode,
  exportMerkliste,
  itemRemainingMinutes,
  itemProgress,
  halve,
  markRange,
  mergeMerkliste,
  merkSaveFailed,
  noteRemoved,
  noteRestored,
  partName,
  partOfEpisode,
  partProgress,
  partsOf,
  pictureSize,
  pickRandomCandidate,
  readMerklisteFile,
  requestLookup,
  seasonName,
  seasonProgress,
  seasonsOf,
  setMerkItems,
  settle,
  sortMerkItems,
  SORT_OPTIONS,
  splitSeason,
  storedParts,
  toggleWatched,
  updateMerkItem,
  useMerkliste,
  watchedUpTo,
  withParts,
  withSeason,
  type CoverFrame,
  type MerklisteSortOption,
  type MerkPart,
  type MerkSeason,
  type Picture,
  type SeasonPart,
  type TileFormat,
  type SavedLinkItem,
  type SavedLinkStatus,
} from '../../lib/merkliste'
import { useSession } from '../../state/store'
import { ChoiceRow } from '../editor/EditorShell'
import { Button, Card, Dialog, Notice, Reveal, RowMark, Select, Slider, Stat, TextInput, Toggle } from '../ui/primitives'
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

function StarIcon({ filled, className = 'size-[18px]' }: { filled: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
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
 * The two shapes an entry's tiles take, chosen per entry: a film poster —
 * 2:3, as on ThePosterDB — or a manga volume, 5:7 like the B6 paperback.
 */
const TILE_FORMATS: Record<TileFormat, { label: string; ratio: string }> = {
  poster: { label: 'Filmposter (2:3)', ratio: '2 / 3' },
  manga: { label: 'Manga (5:7)', ratio: '5 / 7' },
}
const ratioOf = (format: TileFormat | undefined) => TILE_FORMATS[format ?? 'poster'].ratio

/** The switch between the two, above the cover it shapes. */
function FormatChoice({ value, onChange }: { value: TileFormat | undefined; onChange: (format: TileFormat) => void }) {
  return (
    <ChoiceRow
      value={value ?? 'poster'}
      options={(Object.keys(TILE_FORMATS) as TileFormat[]).map((format) => ({ value: format, label: TILE_FORMATS[format].label }))}
      onChange={onChange}
    />
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
  format,
  onChange,
  label = 'Cover',
}: {
  value: string | undefined
  frame?: CoverFrame
  /** The entry's tile shape; the preview is one of its tiles. */
  format?: TileFormat
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
      {label ? <span className="text-small text-prose">{label}</span> : null}
      <div className="flex flex-col gap-[14px] sm:flex-row">
        {value ? (
          <FrameEditor
            src={value}
            frame={live}
            format={format}
            onFrame={setFrame}
            onError={() => setProblem('Unter dieser Adresse liess sich kein Bild laden.')}
            onLoad={() => setProblem(null)}
          />
        ) : (
          <span
            className="relative w-[120px] shrink-0 overflow-hidden rounded-card bg-panel-mid ring-1 ring-inset ring-line"
            style={{ aspectRatio: ratioOf(format) }}
          >
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
  format,
  onFrame,
  onError,
  onLoad,
}: {
  src: string
  frame: CoverFrame | undefined
  format?: TileFormat
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
      className="relative w-[140px] shrink-0 cursor-grab touch-none overflow-hidden rounded-card bg-stage outline-none ring-1 ring-line focus-visible:ring-2 focus-visible:ring-ink active:cursor-grabbing"
      style={{ aspectRatio: ratioOf(format) }}
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
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [season, setSeason] = useState<{ id: string; number: number; part: number } | null>(null)
  const [removed, setRemoved] = useState<{ item: SavedLinkItem; index: number } | null>(null)
  const [anytypeOpen, setAnytypeOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [shuffleOpen, setShuffleOpen] = useState(false)
  const [sortBy, setSortBy] = useState<MerklisteSortOption>('recent')
  const anytypeLink = useAnytype(items)

  // The series that is open, if one is. It has a history entry of its own,
  // so back — the browser's, the mouse's, a swipe on a phone — returns to
  // the overview instead of leaving the tab; and coming back to the tab
  // through history opens it again.
  const [openId, setOpenId] = useState<string | null>(() => openFromHistory(window.history.state))
  const scrollBack = useRef(0)
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const id = openFromHistory(event.state)
      setOpenId(id)
      if (!id) requestAnimationFrame(() => window.scrollTo({ top: scrollBack.current }))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const openSeries = (id: string) => {
    scrollBack.current = window.scrollY
    const state: unknown = window.history.state
    window.history.pushState({ ...(state && typeof state === 'object' ? state : {}), merkliste: id }, '')
    setOpenId(id)
    window.scrollTo({ top: 0 })
  }
  const closeSeries = () => {
    if (openFromHistory(window.history.state)) window.history.back()
    else setOpenId(null)
  }

  const stats = useMemo(() => calculateMerklisteStats(items), [items])

  // Grouped by where each entry stands, sorted according to sortBy within each.
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const found = items.filter(
      (item) => !needle || item.title.toLowerCase().includes(needle) || (item.notes ?? '').toLowerCase().includes(needle),
    )
    return STATUS_OPTIONS.map((option) => {
      const entries = found.filter((item) => statusOf(item) === option.value)
      return {
        ...option,
        entries: sortMerkItems(entries, sortBy),
      }
    }).filter((group) => group.entries.length > 0)
  }, [items, query, sortBy])

  const openItem = openId ? (items.find((item) => item.id === openId) ?? null) : null
  const editingItem = items.find((item) => item.id === editing) ?? null
  const seasonItem = season ? (items.find((item) => item.id === season.id) ?? null) : null

  const remove = (item: SavedLinkItem) => {
    setRemoved({ item, index: items.findIndex((entry) => entry.id === item.id) })
    // Remembered, so the copy in Anytype does not bring it back.
    noteRemoved(item.id)
    setEditing(null)
    setSeason(null)
    setMerkItems((current) => current.filter((entry) => entry.id !== item.id))
    if (openId === item.id) closeSeries()
  }

  const dialogs = (
    <>
      <AddDialog open={adding} onClose={() => setAdding(false)} />
      {statsOpen ? <StatsDialog items={items} onClose={() => setStatsOpen(false)} /> : null}
      {shuffleOpen ? (
        <ShuffleDialog
          items={items}
          open={shuffleOpen}
          onClose={() => setShuffleOpen(false)}
          onOpenSeries={(id) => {
            setShuffleOpen(false)
            openSeries(id)
          }}
        />
      ) : null}
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
      {anytypeOpen ? <AnytypeDialog link={anytypeLink} onClose={() => setAnytypeOpen(false)} /> : null}
    </>
  )

  if (openItem) {
    return (
      <>
        <SeriesPage
          item={openItem}
          onBack={closeSeries}
          onEdit={() => setEditing(openItem.id)}
          onSeason={(number, part) => setSeason({ id: openItem.id, number, part })}
        />
        {dialogs}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-[32px]">
      <Card tone="cream">
        <div className="mt-[8px] flex flex-wrap items-end justify-between gap-x-[16px] gap-y-[12px]">
          <div className="min-w-0">
            <h2 className="display-md">Merkliste</h2>
            {items.length === 0 ? (
              <p className="mt-[4px] text-body text-prose">
                Serien, Staffeln und Listen, die Sie schauen — mit dem, was Sie schon gesehen haben.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setStatsOpen(true)}
                className="press group mt-[4px] -ml-[6px] inline-flex flex-wrap items-center gap-x-[8px] gap-y-[4px] rounded-nav px-[6px] py-[3px] text-left text-body text-prose hover:bg-panel-soft hover:text-ink transition-colors cursor-pointer"
                title="Alle Statistiken zur Merkliste anzeigen"
                aria-label="Statistiken zur Merkliste öffnen"
              >
                <span className="font-semibold text-ink">{stats.watchingCount} am Schauen</span>
                {stats.laterCount > 0 ? <span className="text-muted">· {stats.laterCount} später</span> : null}
                {stats.doneCount > 0 ? <span className="text-muted">· {stats.doneCount} fertig</span> : null}
                <span>· {stats.seenTotal} {stats.seenTotal === 1 ? 'Folge' : 'Folgen'} gesehen</span>
                <span className="text-muted">· ca. {stats.watchTime.short}</span>
                <span className="inline-flex items-center gap-[3px] font-sans text-small font-medium text-ink/80 underline decoration-dotted underline-offset-2 group-hover:text-ink">
                  Statistiken
                  <span aria-hidden className="transition-transform group-hover:translate-x-[2px]">›</span>
                </span>
              </button>
            )}
          </div>
          <div className="flex w-full flex-wrap items-center gap-[8px] sm:w-auto">
            {items.length > 0 ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="quiet"
                  onClick={() => setShuffleOpen(true)}
                  title="Zufällige Serie aus der Merkliste vorschlagen"
                >
                  🎲 Würfeln
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="quiet"
                  onClick={() => setStatsOpen(true)}
                  title="Statistiken zur Merkliste öffnen"
                >
                  Statistiken
                </Button>
              </>
            ) : null}
            {items.length > 1 ? (
              <Select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as MerklisteSortOption)}
                aria-label="Merkliste sortieren"
                className="w-auto! text-small font-sans"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ) : null}
            {items.length > 5 ? (
              <TextInput
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Suchen"
                aria-label="In der Merkliste suchen"
                className="min-w-0 flex-1 font-sans sm:w-[220px] sm:flex-none"
              />
            ) : null}
            <Button type="button" size="sm" onClick={() => setAdding(true)}>
              Serie hinzufügen
            </Button>
          </div>
        </div>

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
                noteRestored(removed.item.id)
                setRemoved(null)
              }}
              className={`${linkClass} font-semibold`}
            >
              Rückgängig
            </button>
          </p>
        ) : null}
      </Card>

      {items.length === 0 ? (
        <EmptyState onAdd={() => setAdding(true)} onDownload={() => setPanel('downloader')} />
      ) : groups.length === 0 ? (
        <p className="text-small text-prose">Nichts gefunden für „{query.trim()}“.</p>
      ) : (
        groups.map((group) => (
          <section key={group.value} aria-label={group.label} className="flex flex-col gap-[14px]">
            <h3 className="flex items-baseline gap-[10px] border-b border-line pb-[10px] text-subheading text-ink">
              {group.label}
              <span className="value text-small text-muted">{group.entries.length}</span>
            </h3>
            {/* Posters stand on one line at their foot, like books on a shelf,
                whatever their shape. */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] items-end gap-x-[14px] gap-y-[24px] sm:grid-cols-[repeat(auto-fill,minmax(156px,1fr))] sm:gap-x-[18px]">
              {group.entries.map((item) => (
                <SeriesTile key={item.id} item={item} onOpen={() => openSeries(item.id)} />
              ))}
            </div>
          </section>
        ))
      )}

      <Transfer items={items} link={anytypeLink} onAnytype={() => setAnytypeOpen(true)} />
      {dialogs}
    </div>
  )
}

/** The series a history entry has open, if any. */
function openFromHistory(state: unknown): string | null {
  const id = state && typeof state === 'object' ? (state as { merkliste?: unknown }).merkliste : null
  return typeof id === 'string' ? id : null
}

/* -------------------------------------------------------------------------- */
/* Anytype                                                                     */
/* -------------------------------------------------------------------------- */

interface AnytypeLink {
  /** In the app; in a browser Anytype cannot be reached at all. */
  available: boolean
  status: AnytypeStatus | null
  connected: boolean
  sync: { running: boolean; at?: number; error?: AnytypeError }
  run: () => Promise<void>
  refresh: () => Promise<AnytypeStatus | null>
}

/**
 * The Merkliste kept in step with Anytype while the tab is open: once on
 * arrival, then a moment after each change. A round is read, merge, write
 * (`syncMerkliste`); a change that only brought the list in step sends
 * nothing.
 */
function useAnytype(items: SavedLinkItem[]): AnytypeLink {
  const [status, setStatus] = useState<AnytypeStatus | null>(null)
  const [sync, setSync] = useState<AnytypeLink['sync']>({ running: false })
  const connected = Boolean(status?.paired && status.space)

  const refresh = async () => {
    const answer = await anytype.status()
    const next = answer.ok ? { reachable: answer.reachable, paired: answer.paired, lasting: answer.lasting, space: answer.space } : null
    setStatus(next)
    return next
  }
  const run = async () => {
    setSync((current) => ({ ...current, running: true }))
    const answer = await syncMerkliste()
    setSync(answer.ok ? { running: false, at: answer.at } : { running: false, error: answer.error })
    if (!answer.ok && answer.error === 'unauthorized') void refresh()
  }
  const latest = useRef({ refresh, run })
  latest.current = { refresh, run }

  useEffect(() => {
    if (!anytypeAvailable) return
    void latest.current.refresh().then((next) => {
      if (next?.paired && next.space) void latest.current.run()
    })
  }, [])

  useEffect(() => {
    if (!connected || inStepWithAnytype(items)) return
    const timer = window.setTimeout(() => void latest.current.run(), 2500)
    return () => window.clearTimeout(timer)
  }, [items, connected])

  return { available: anytypeAvailable, status, connected, sync, run, refresh }
}

const clock = (at: number) => new Date(at).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })

/**
 * Connecting the Merkliste to Anytype, step by step — Anytype open, a code
 * it shows typed in here, a space — and, once connected, the state of it
 * with what can be done.
 */
function AnytypeDialog({ link, onClose }: { link: AnytypeLink; onClose: () => void }) {
  const { status } = link
  const [challenge, setChallenge] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [spaces, setSpaces] = useState<{ id: string; name: string }[] | null>(null)
  const [pick, setPick] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // Step 2: Note selection or creation in selected space
  const [selectedSpace, setSelectedSpace] = useState<{ id: string; name: string } | null>(null)
  const [foundNotes, setFoundNotes] = useState<FoundNote[] | null>(null)
  const [creatingNew, setCreatingNew] = useState(false)
  const [newNoteName, setNewNoteName] = useState('Sondra · Merkliste (Gerät 2)')

  const failed = (error: AnytypeError) => {
    setProblem(ANYTYPE_PROBLEM[error])
    setBusy(false)
  }
  const askCode = async () => {
    setBusy(true)
    setProblem(null)
    setCode('')
    const answer = await anytype.challenge()
    if (!answer.ok) return failed(answer.error)
    setChallenge(answer.challengeId)
    setBusy(false)
  }
  const pair = async () => {
    if (!challenge) return
    setBusy(true)
    setProblem(null)
    const answer = await anytype.pair(challenge, code)
    if (!answer.ok) {
      if (answer.error === 'wrong-code') setChallenge(null)
      return failed(answer.error)
    }
    setChallenge(null)
    await link.refresh()
    await loadSpaces()
  }
  const loadSpaces = async () => {
    setBusy(true)
    setProblem(null)
    setSelectedSpace(null)
    setFoundNotes(null)
    setCreatingNew(false)
    const answer = await anytype.spaces()
    if (!answer.ok) return failed(answer.error)
    setSpaces(answer.spaces)
    if (answer.spaces.length === 1) {
      // If only 1 space was granted or available, auto-select it immediately without asking
      setPick(answer.spaces[0].id)
      setBusy(false)
      await loadNotesForSpace(answer.spaces[0])
      return
    }
    setPick((current) => current || answer.spaces[0]?.id || '')
    setBusy(false)
  }

  const loadNotesForSpace = async (space: { id: string; name: string }) => {
    setBusy(true)
    setProblem(null)
    setSelectedSpace(space)
    setCreatingNew(false)
    const answer = await anytype.listNotes(space.id)
    if (!answer.ok) return failed(answer.error)
    setFoundNotes(answer.notes)
    setBusy(false)
  }

  const connectExisting = async (note: FoundNote) => {
    if (!selectedSpace) return
    setBusy(true)
    setProblem(null)
    const answer = await anytype.useSpace(selectedSpace.id, selectedSpace.name, note.id, note.name)
    if (!answer.ok) return failed(answer.error)
    setChoosing(false)
    setSelectedSpace(null)
    setFoundNotes(null)
    await link.refresh()
    setBusy(false)
    await link.run()
  }

  const startNewNote = async () => {
    if (!selectedSpace) return
    const name = newNoteName.trim() || 'Sondra · Merkliste (Gerät 2)'
    setBusy(true)
    setProblem(null)
    const answer = await anytype.createNote(selectedSpace.id, name)
    if (!answer.ok) return failed(answer.error)
    setChoosing(false)
    setSelectedSpace(null)
    setFoundNotes(null)
    setCreatingNew(false)
    await link.refresh()
    setBusy(false)
    await link.run()
  }

  const createInitial = async () => {
    if (!selectedSpace) return
    setBusy(true)
    setProblem(null)
    const answer = await anytype.createNote(selectedSpace.id, 'Sondra · Merkliste')
    if (!answer.ok) return failed(answer.error)
    setChoosing(false)
    setSelectedSpace(null)
    setFoundNotes(null)
    await link.refresh()
    setBusy(false)
    await link.run()
  }

  const forget = async () => {
    setBusy(true)
    await anytype.forget()
    setChallenge(null)
    setSpaces(null)
    setSelectedSpace(null)
    setFoundNotes(null)
    await link.refresh()
    setBusy(false)
  }

  // Spaces load by themselves once there is a key and none is chosen.
  const needsSpace = Boolean(status?.paired && (!status.space || choosing))
  useEffect(() => {
    if (needsSpace && spaces === null && !busy) void loadSpaces()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsSpace])

  let body: ReactNode
  if (!status) {
    body = <p className="text-small text-prose">Sondra fragt bei Anytype nach …</p>
  } else if (!status.reachable) {
    body = (
      <div className="flex flex-col items-start gap-[12px]">
        <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
          Anytype antwortet auf diesem Rechner nicht. Öffnen Sie die Anytype-App (Version 0.46.7 oder neuer) und melden Sie
          sich an.
        </p>
        <Button type="button" size="sm" variant="quiet" disabled={busy} onClick={() => void link.refresh()}>
          Nochmal prüfen
        </Button>
      </div>
    )
  } else if (!status.paired) {
    body = challenge ? (
      <form
        className="flex flex-col items-start gap-[12px]"
        onSubmit={(event) => {
          event.preventDefault()
          if (code.length === 4) void pair()
        }}
      >
        <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
          Anytype zeigt jetzt einen vierstelligen Code. Tippen Sie ihn hier ein.
        </p>
        <div className="flex flex-wrap items-center gap-[10px]">
          <TextInput
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={4}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="0000"
            aria-label="Code aus Anytype"
            className="w-[120px]! text-center tracking-[0.3em]"
          />
          <Button type="submit" size="sm" disabled={busy || code.length !== 4}>
            Verbinden
          </Button>
          <button type="button" onClick={() => void askCode()} disabled={busy} className={`${linkClass} text-small`}>
            Neuen Code anfordern
          </button>
        </div>
      </form>
    ) : (
      <div className="flex flex-col items-start gap-[12px]">
        <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
          Sondra fragt bei Anytype um Zugang. Anytype zeigt dafür einen vierstelligen Code, den Sie hier eintippen.
        </p>
        <Button type="button" size="sm" disabled={busy} onClick={() => void askCode()}>
          Code anfordern
        </Button>
      </div>
    )
  } else if (needsSpace) {
    if (selectedSpace) {
      if (foundNotes === null) {
        body = <p className="text-small text-prose">Suche nach bestehenden Merklisten in „{selectedSpace.name}“ …</p>
      } else if (foundNotes.length > 0) {
        body = (
          <div className="flex flex-col items-start gap-[14px]">
            <p className="text-small leading-[1.55] text-prose">
              In Space <strong>„{selectedSpace.name}“</strong> wurde eine bestehende Merkliste von einem anderen Gerät gefunden:
            </p>
            <div className="w-full flex flex-col gap-[10px]">
              {foundNotes.map((note) => (
                <div key={note.id} className="p-[14px] rounded-panel bg-raised ring-1 ring-rule flex flex-col gap-[8px]">
                  <div className="flex items-center justify-between gap-[10px]">
                    <span className="font-medium text-body text-ink">{note.name}</span>
                    <span className="text-small text-muted">{note.itemCount} {note.itemCount === 1 ? 'Serie' : 'Serien'} gespeichert</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-[10px] pt-[4px]">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => void connectExisting(note)}
                    >
                      Bestehende Notiz laden & synchronisieren
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="w-full pt-[12px] border-t border-line flex flex-col items-start gap-[10px]">
              <p className="text-small text-prose">
                Oder möchten Sie eine komplett neue, separate Notiz starten (die andere vom anderen Gerät bleibt unverändert)?
              </p>
              {creatingNew ? (
                <div className="w-full flex flex-wrap items-center gap-[10px]">
                  <TextInput
                    autoFocus
                    value={newNoteName}
                    onChange={(e) => setNewNoteName(e.target.value)}
                    placeholder="Sondra · Merkliste (Gerät 2)"
                    aria-label="Name der neuen Notiz"
                    className="flex-1 min-w-[200px]"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !newNoteName.trim()}
                    onClick={() => void startNewNote()}
                  >
                    Neue Notiz erstellen & verbinden
                  </Button>
                  <button
                    type="button"
                    onClick={() => setCreatingNew(false)}
                    className={`${linkClass} text-small`}
                  >
                    Abbrechen
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="quiet"
                  disabled={busy}
                  onClick={() => setCreatingNew(true)}
                >
                  + Neue separate Notiz anlegen
                </Button>
              )}
            </div>

            {spaces && spaces.length > 1 ? (
              <button
                type="button"
                onClick={() => { setSelectedSpace(null); setFoundNotes(null); }}
                className={`${linkClass} text-small pt-[4px]`}
              >
                ← Anderen Space wählen
              </button>
            ) : null}
          </div>
        )
      } else {
        body = (
          <div className="flex flex-col items-start gap-[12px]">
            <p className="text-small text-prose">
              In Space <strong>„{selectedSpace.name}“</strong> gibt es noch keine Merkliste. Sondra wird eine neue Notiz anlegen.
            </p>
            <div className="flex flex-wrap items-center gap-[12px]">
              <Button type="button" size="sm" disabled={busy} onClick={() => void createInitial()}>
                Notiz anlegen & verbinden
              </Button>
              {spaces && spaces.length > 1 ? (
                <button
                  type="button"
                  onClick={() => { setSelectedSpace(null); setFoundNotes(null); }}
                  className={`${linkClass} text-small`}
                >
                  Anderen Space wählen
                </button>
              ) : null}
            </div>
          </div>
        )
      }
    } else {
      body = (
        <div className="flex flex-col items-start gap-[12px]">
          <p className="text-small text-prose">In welchem Space soll die Merkliste liegen?</p>
          {spaces === null ? (
            <p className="text-small text-prose">Die Spaces werden geladen …</p>
          ) : spaces.length === 0 ? (
            <p className="text-small text-prose">In Anytype gibt es noch keinen Space. Legen Sie dort einen an.</p>
          ) : (
            <ChoiceRow value={pick} options={spaces.map((space) => ({ value: space.id, label: space.name || 'Ohne Namen' }))} onChange={setPick} />
          )}
          <div className="flex flex-wrap items-center gap-[12px]">
            <Button
              type="button"
              size="sm"
              disabled={busy || !pick}
              onClick={() => {
                const space = spaces?.find((s) => s.id === pick)
                if (space) void loadNotesForSpace(space)
              }}
            >
              Diesen Space nehmen
            </Button>
            {choosing ? (
              <button type="button" onClick={() => setChoosing(false)} className={`${linkClass} text-small`}>
                Abbrechen
              </button>
            ) : null}
          </div>
        </div>
      )
    }
  } else {
    body = (
      <div className="flex flex-col items-start gap-[14px]">
        <p className="text-body text-prose">
          Verbunden mit dem Space „{status.space?.name || 'Ohne Namen'}“
          {status.note?.name ? ` · Notiz „${status.note.name}“` : ''}.
          <span className="text-muted">
            {' '}
            {link.sync.running ? 'Gleicht gerade ab …' : link.sync.at ? `Zuletzt abgeglichen um ${clock(link.sync.at)}.` : ''}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-[8px]">
          <Button type="button" size="sm" disabled={link.sync.running} onClick={() => void link.run()}>
            Jetzt abgleichen
          </Button>
          <button
            type="button"
            onClick={() => {
              setSpaces(null)
              setSelectedSpace(null)
              setFoundNotes(null)
              setChoosing(true)
            }}
            className={`${linkClass} text-small`}
          >
            Anderen Space oder Notiz wählen
          </button>
          <button type="button" onClick={() => void forget()} disabled={busy} className={`${linkClass} text-small`}>
            Trennen
          </button>
        </div>
        {!status.lasting ? (
          <p className="text-small text-prose">
            Windows kann den Zugang hier nicht verschlüsselt ablegen; nach einem Neustart von Sondra fragt es nach einem neuen
            Code.
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <Dialog open onClose={onClose} title="Merkliste in Anytype" size="md">
      <div className="flex flex-col gap-[18px]">
        <p className="max-w-[62ch] text-small leading-[1.55] text-prose">
          Sondra legt die Merkliste in Anytype als Seite „Sondra · Merkliste“ ab und gleicht sie bei jeder Änderung ab. Anytype
          bringt sie verschlüsselt auf Ihre anderen Geräte, auch aufs Handy; Sondra auf einem anderen Rechner holt sie dort
          wieder ab. Covers aus Dateien bleiben auf diesem Rechner, Covers mit Bildadresse reisen mit.
        </p>
        <div className="border-t border-line pt-[16px]">{body}</div>
        {problem ? (
          <Notice tone="error" title="Hat nicht geklappt">
            {problem}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  )
}

/**
 * The list as a file.
 */
function Transfer({ items, link, onAnytype }: { items: SavedLinkItem[]; link: AnytypeLink; onAnytype: () => void }) {
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
      <div className="flex flex-wrap items-baseline justify-between gap-x-[20px] gap-y-[6px] text-small">
        <span className="text-prose">
          {link.connected
            ? link.sync.running
              ? 'Gleicht mit Anytype ab …'
              : `Mit Anytype abgeglichen · „${link.status?.space?.name || 'Ohne Namen'}“${link.sync.at && !link.sync.error ? ` · ${clock(link.sync.at)}` : ''}`
            : link.available
              ? 'Nur auf diesem Gerät gespeichert.'
              : 'Nur auf diesem Gerät gespeichert. Mit Anytype abgleichen geht in der Sondra-App.'}
        </span>
        <span className="flex flex-wrap gap-x-[18px] gap-y-[4px]">
          {items.length > 0 ? (
            <button type="button" onClick={exportFile} className={linkClass}>
              Exportieren
            </button>
          ) : null}
          <button type="button" onClick={() => fileRef.current?.click()} className={linkClass}>
            Aus Datei einlesen
          </button>
          {link.available ? (
            <button type="button" onClick={onAnytype} className={linkClass}>
              {link.connected ? 'Anytype' : 'Mit Anytype verbinden'}
            </button>
          ) : null}
        </span>
      </div>
      {link.connected && link.sync.error ? (
        <Notice tone="warn" title="Abgleich mit Anytype">
          {ANYTYPE_PROBLEM[link.sync.error]}
        </Notice>
      ) : null}
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
            className={`${linkClass} font-semibold`}
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
        <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
          Eine Serie hinzufügen, Staffeln und Folgen angeben, abhaken, was gesehen ist. Mit einer Adresse holt „Folge …
          laden“ die nächste gleich im Herunterladen.
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
      <div aria-hidden className="grid grid-cols-4 gap-[10px] self-start opacity-60">
        {[1, 2, 3].map((n) => (
          <span key={n} className="relative aspect-[2/3] overflow-hidden rounded-card bg-panel-mid">
            <span className="absolute inset-0 flex items-center justify-center text-[36px] leading-none text-ink/30">{n}</span>
            <span className="absolute inset-x-[8px] bottom-[8px]">
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

/** The nearest cover with its frame: the part's, the season's, the series'. */
function coverOf(item: SavedLinkItem, season: MerkSeason, part: SeasonPart): { src: string; frame?: CoverFrame } | null {
  if (part.cover) return { src: part.cover, frame: part.coverFrame }
  if (season.cover) return { src: season.cover, frame: season.coverFrame }
  if (item.cover) return { src: item.cover, frame: item.coverFrame }
  return null
}

/** A season after the last; a series seen to the end goes on where it starts. */
function addSeasonTo(item: SavedLinkItem) {
  const seasons = seasonsOf(item)
  const highest = seasons.reduce((max, season) => Math.max(max, season.number), 0)
  const next = [...seasons, { number: highest + 1, episodes: null, watched: [] }]
  updateMerkItem(item.id, caughtUp(seasons) ? settle(item, next, highest + 1) : { seasons: next })
}

/** The rating beside a name, small: drawn stars, only the ones given. */
function Stars({ value, size = 'size-[13px]' }: { value?: number; size?: string }) {
  if (!value) return null
  return (
    <span aria-label={`${value} von 5`} className="inline-flex shrink-0 text-ink">
      {Array.from({ length: value }, (_, i) => (
        <StarIcon key={i} filled className={size} />
      ))}
    </span>
  )
}

/** The cover a series is shown with: its own, else that of its first season. */
function seriesCover(item: SavedLinkItem): { src: string; frame?: CoverFrame } | null {
  if (item.cover) return { src: item.cover, frame: item.coverFrame }
  const first = seasonsOf(item)[0]
  return first ? coverOf(item, first, partsOf(first)[0]) : null
}

/** „Staffel 3, Folge 5", „Alles gesehen", „Nicht angefangen" — where a series stands, in a few words. */
function standLabel(item: SavedLinkItem): string {
  const status = statusOf(item)
  const seasons = seasonsOf(item)
  const kind = episodeKindOf(item.url) ?? 'series'
  if (caughtUp(seasons)) return 'Alles gesehen'
  if (status === 'done') return `${itemProgress(item).watched} gesehen`
  if (status === 'later' && itemProgress(item).watched === 0) return 'Nicht angefangen'
  return positionLabel(item.season, item.episode, kind)
}

/** A poster without a cover: the name itself, set on the tint. */
function NamePoster({ title, large = false }: { title: string; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={`absolute inset-0 flex items-center justify-center p-[12%] text-center font-semibold leading-[1.15] text-ink/45 ${
        large ? 'text-heading-sm' : 'text-subheading'
      }`}
    >
      <span className="line-clamp-4 break-words">{title}</span>
    </span>
  )
}

/**
 * One series in the overview: its poster, its name, where it stands, a bar.
 * Everything else — seasons, buttons — is one click further, on the
 * series' own page. Hover or focus brings up how far and how many seasons.
 */
function SeriesTile({ item, onOpen }: { item: SavedLinkItem; onOpen: () => void }) {
  const progress = itemProgress(item)
  const cover = seriesCover(item)
  const [broken, setBroken] = useState<string | null>(null)
  const poster = cover && cover.src !== broken ? cover : null
  const count = seasonsOf(item).filter((season) => season.number > 0).length
  const done = caughtUp(seasonsOf(item))
  const stand = standLabel(item)
  const badge = item.url ? sourceBadgeForUrl(item.url) : null
  const canAdvance = !done && item.episode !== null

  return (
    <div className="group flex min-w-0 flex-col gap-[10px] rounded-card text-left">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${item.title}: ${stand}, ${progress.total ? `${progress.watched} von ${progress.total} gesehen` : `${progress.watched} gesehen`}`}
        className="press relative block w-full overflow-hidden rounded-card text-left cursor-pointer"
        style={{ aspectRatio: ratioOf(item.tileFormat) }}
      >
        {poster ? <CoverImage src={poster.src} frame={poster.frame} onError={() => setBroken(poster.src)} /> : <NamePoster title={item.title} />}
        
        {/* Rating badge top-right */}
        {item.rating ? (
          <span className="absolute top-[8px] right-[8px] z-10 flex items-center gap-[3px] rounded-pill bg-stage/85 px-[6px] py-[2px] text-micro font-semibold text-stage-ink backdrop-blur-xs ring-1 ring-inset ring-white/15">
            <span className="text-amber-400">★</span>
            <span>{item.rating}</span>
          </span>
        ) : null}

        {/* Hover overlay */}
        <span
          aria-hidden
          className={`absolute inset-x-0 bottom-0 flex translate-y-[6px] flex-col gap-[4px] px-[12px] pb-[12px] pt-[52px] opacity-0 transition-[opacity,translate] duration-[var(--dur-base)] ease-[var(--ease-settle)] group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 ${
            poster ? 'bg-gradient-to-t from-stage/85 via-stage/50 to-transparent text-stage-ink' : 'bg-gradient-to-t from-panel-strong via-panel-strong/80 to-transparent text-ink'
          }`}
        >
          <span className="text-subheading leading-none">
            {progress.fraction !== null ? `${Math.round(progress.fraction * 100)} %` : progress.watched}
          </span>
          <span className="text-small font-semibold">
            {count} {count === 1 ? 'Staffel' : 'Staffeln'} · öffnen
          </span>
        </span>
      </button>

      <div className="flex min-w-0 flex-col gap-[4px] px-[1px]">
        <button
          type="button"
          onClick={onOpen}
          className="press truncate text-left text-body font-semibold leading-snug text-ink hover:underline cursor-pointer"
          title={item.title}
        >
          {item.title}
        </button>
        <div className="flex items-center justify-between gap-[6px] text-small text-prose">
          <span className="flex items-center gap-[6px] min-w-0 truncate">
            {done ? <RowMark state="done" /> : null}
            <span className="truncate">{stand}</span>
          </span>
          {canAdvance ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                markSeen(item)
              }}
              title={`${hereLabel(item)} als gesehen markieren`}
              className="press shrink-0 rounded-nav bg-panel-soft px-[6px] py-[1px] text-micro font-medium text-ink ring-1 ring-inset ring-line hover:bg-panel-mid transition-colors cursor-pointer"
            >
              +1
            </button>
          ) : null}
        </div>
        <ProgressBar fraction={progress.fraction ?? (progress.watched > 0 ? null : 0)} label={`${item.title}: gesehen`} />
        {badge ? (
          <span className="text-micro text-muted font-mono truncate">{badge}</span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One series on its own page: the poster large, where it stands, the next
 * step, and its seasons as tiles. Reached from the overview; back returns to
 * it — the link, or the browser's back.
 */
function SeriesPage({
  item,
  onBack,
  onEdit,
  onSeason,
}: {
  item: SavedLinkItem
  onBack: () => void
  onEdit: () => void
  onSeason: (number: number, part: number) => void
}) {
  const openHere = useOpenHere()
  const progress = itemProgress(item)
  const status = statusOf(item)
  const seasons = seasonsOf(item)
  const kind = episodeKindOf(item.url) ?? 'series'
  const cover = seriesCover(item)
  const [broken, setBroken] = useState<string | null>(null)
  const poster = cover && cover.src !== broken ? cover : null
  const last = whenLabel(item.lastOpenedAt)
  const hasUrl = Boolean(item.url.trim())
  const seasonCount = seasons.filter((season) => season.number > 0).length
  const hasFilms = seasons.some((season) => season.number === 0)
  const next = status !== 'done' && item.episode !== null && !caughtUp(seasons)

  return (
    <div className="flex flex-col gap-[32px]">
      <Card tone="cream">
        <button type="button" onClick={onBack} className="press mt-[8px] inline-flex items-center gap-[6px] rounded-nav text-small text-ink hover:underline">
          <svg viewBox="0 0 16 16" aria-hidden className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 3.5L5.5 8l4.5 4.5" />
          </svg>
          Merkliste
        </button>
        <div className="mt-[18px] flex flex-col gap-[20px] sm:flex-row sm:items-end sm:gap-[28px]">
          <span
            className={`relative block w-[132px] shrink-0 overflow-hidden rounded-card sm:w-[168px] ${poster ? 'bg-stage' : 'bg-panel-mid'}`}
            style={{ aspectRatio: ratioOf(item.tileFormat) }}
          >
            {poster ? <CoverImage src={poster.src} frame={poster.frame} onError={() => setBroken(poster.src)} /> : <NamePoster title={item.title} large />}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-[10px]">
            <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[4px]">
              <h2 className="display-md min-w-0 break-words">{item.title}</h2>
              <Stars value={item.rating} size="size-[16px]" />
            </div>
            <div className="flex max-w-[520px] flex-col gap-[6px]">
              <p className="text-body text-prose">
                {standLabel(item)}
                <span className="text-muted">
                  {' · '}
                  {progress.total ? `${progress.watched} von ${progress.total} gesehen` : `${progress.watched} gesehen`}
                </span>
              </p>
              <ProgressBar fraction={progress.fraction} label={`${item.title}: gesehen`} />
              {progress.total && progress.total > progress.watched ? (() => {
                const rem = progress.total - progress.watched
                const remMin = itemRemainingMinutes(item)
                const plan = calculateBingePlan(rem, item.episodeDuration ?? 24, remMin.minutes)
                return (
                  <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[2px] text-micro text-muted">
                    <span className="font-medium text-prose">Noch {rem} {rem === 1 ? 'Folge' : 'Folgen'} ({plan.watchTime.short})</span>
                    <span>·</span>
                    <span>1/Tag: fertig {plan.finishAt1PerDay}</span>
                    <span>·</span>
                    <span>2/Tag: fertig {plan.finishAt2PerDay}</span>
                  </div>
                )
              })() : null}
              <p className="text-small text-muted">
                {[hasUrl ? sourceBadgeForUrl(item.url) : null, last ? `zuletzt ${last}` : null, STATUS_OPTIONS.find((option) => option.value === status)?.label]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            {item.notes ? <p className="max-w-[72ch] text-small leading-[1.55] text-prose">{item.notes}</p> : null}
            <div className="mt-[4px] flex flex-wrap items-center gap-[8px]">
              {hasUrl && next ? (
                <Button type="button" size="sm" onClick={() => openHere(item)}>
                  {hereLabel(item)} laden
                </Button>
              ) : null}
              {next ? (
                <Button type="button" size="sm" variant={hasUrl ? 'quiet' : 'primary'} onClick={() => markSeen(item)}>
                  {hereLabel(item)} gesehen
                </Button>
              ) : null}
              {hasUrl && !next ? (
                <Button type="button" size="sm" variant="quiet" onClick={() => openHere(item)}>
                  Nachsehen
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="quiet" onClick={onEdit}>
                Bearbeiten
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <section aria-label="Staffeln" className="flex flex-col gap-[14px]">
        <div className="flex flex-wrap items-baseline justify-between gap-x-[20px] gap-y-[6px] border-b border-line pb-[10px]">
          <h3 className="flex items-baseline gap-[10px] text-subheading text-ink">
            {kind === 'list' ? 'Liste' : 'Staffeln'}
            <span className="value text-small text-muted">{seasonCount}</span>
          </h3>
          {kind === 'series' ? (
            <span className="flex flex-wrap gap-x-[18px] gap-y-[4px] text-small">
              <button type="button" onClick={() => addSeasonTo(item)} className={linkClass}>
                <PlusIcon />
                Staffel hinzufügen
              </button>
              {!hasFilms ? (
                <button
                  type="button"
                  onClick={() => updateMerkItem(item.id, { seasons: [...seasons, { number: 0, episodes: null, watched: [] }] })}
                  className={linkClass}
                >
                  <PlusIcon />
                  Filme hinzufügen
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
        <SeasonTiles item={item} onSeason={onSeason} large />
      </section>
    </div>
  )
}

/**
 * The seasons of a series as posters — a part of a season is a poster of its
 * own — as many to a row as fit.
 */
function SeasonTiles({
  item,
  onSeason,
  large = false,
}: {
  item: SavedLinkItem
  onSeason: (number: number, part: number) => void
  large?: boolean
}) {
  const status = statusOf(item)
  const tiles = seasonsOf(item).flatMap((season) => partsOf(season).map((part) => ({ season, part })))
  return (
    <div
      className={`grid gap-[10px] sm:gap-[14px] ${
        large
          ? 'grid-cols-[repeat(auto-fill,minmax(100px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]'
          : 'grid-cols-[repeat(auto-fill,minmax(100px,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(124px,1fr))]'
      }`}
    >
      {tiles.map(({ season, part }) => (
        <SeasonTile
          key={`${season.number}-${part.index}`}
          season={season}
          part={part}
          cover={coverOf(item, season, part)}
          format={item.tileFormat}
          current={status !== 'done' && season.number === item.season && partOfEpisode(season, item.episode).index === part.index}
          onOpen={() => onSeason(season.number, part.index)}
        />
      ))}
    </div>
  )
}

/**
 * One season as a poster, showing the part of the cover someone chose
 * (`CoverImage`), with nothing laid over it — under it the name, then a bar
 * and the count. The current one wears a ring; where exactly it stands is
 * said once, above the shelf. Hover or focus brings up the numbers; a click
 * opens the season.
 */
function SeasonTile({
  season,
  part,
  cover,
  format,
  current,
  onOpen,
}: {
  season: MerkSeason
  part: SeasonPart
  cover: { src: string; frame?: CoverFrame } | null
  format?: TileFormat
  current: boolean
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
      className="press group flex min-w-0 flex-col gap-[8px] rounded-card text-left"
    >
      <span
        className={`relative block w-full overflow-hidden rounded-card ${poster ? 'bg-stage' : 'bg-panel-mid'} ${
          current ? 'ring-2 ring-ink ring-offset-2 ring-offset-canvas' : ''
        }`}
        style={{ aspectRatio: ratioOf(format) }}
      >
        {poster ? (
          <CoverImage src={poster.src} frame={poster.frame} onError={() => setBroken(poster.src)} />
        ) : (
          <span
            aria-hidden
            className="absolute inset-0 flex flex-col items-center justify-center gap-[4px] text-ink/30 transition-opacity duration-[var(--dur-base)] group-hover:opacity-0 group-focus-visible:opacity-0"
          >
            {season.number === 0 ? <FilmIcon /> : <span className="text-[44px] leading-none">{season.number}</span>}
            {split ? <span className="text-small font-semibold text-ink/45">Teil {part.index + 1}</span> : null}
          </span>
        )}

        {/* The numbers, on hover and on keyboard focus: a shade rising from
            the bottom, so the picture stays in view above them. */}
        <span
          aria-hidden
          className={`absolute inset-x-0 bottom-0 flex translate-y-[6px] flex-col gap-[4px] px-[10px] pb-[10px] pt-[44px] opacity-0 transition-[opacity,translate] duration-[var(--dur-base)] ease-[var(--ease-settle)] group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 ${
            poster ? 'bg-gradient-to-t from-stage/80 via-stage/45 to-transparent text-stage-ink' : 'text-ink'
          }`}
        >
          <span className="text-subheading leading-none">
            {progress.fraction !== null ? `${Math.round(progress.fraction * 100)} %` : progress.watched}
          </span>
          <span className="text-small font-semibold leading-snug text-balance">
            {progress.complete ? 'Alles gesehen' : `Weiter mit ${unit} ${progress.next}`}
          </span>
        </span>
      </span>

      <span className="flex min-w-0 flex-col gap-[5px] px-[1px]">
        <span className="truncate text-small font-semibold text-ink">{name}</span>
        <span className="flex items-center gap-[8px]">
          <span className="min-w-0 flex-1">
            <ProgressBar fraction={progress.fraction ?? (progress.watched > 0 ? null : 0)} label={`${name}: gesehen`} />
          </span>
          <span className="value flex shrink-0 items-center gap-[2px] text-small text-prose">
            {progress.complete ? <RowMark state="done" /> : null}
            {progress.total ? `${progress.watched}/${progress.total}` : `${progress.watched}/?`}
          </span>
        </span>
      </span>
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* A season, opened                                                            */
/* -------------------------------------------------------------------------- */


function SeasonDurationExceptions({
  item,
  seasonNumber,
  unit,
  update,
}: {
  item: SavedLinkItem
  seasonNumber: number
  unit: string
  update: (patch: Partial<SavedLinkItem>) => void
}) {
  const [episodeInput, setEpisodeInput] = useState('')
  const [minutesInput, setMinutesInput] = useState('')
  const standard = seasonNumber === 0 ? (item.filmDuration ?? 90) : (item.episodeDuration ?? 24)

  const durations = item.durations || {}
  const prefix = `${seasonNumber}:`
  const seasonExceptions = Object.entries(durations)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, min]) => ({
      key,
      episode: Number(key.slice(prefix.length)),
      minutes: min,
    }))
    .sort((a, b) => a.episode - b.episode)

  const addException = () => {
    const ep = parseInt(episodeInput, 10)
    const min = parseInt(minutesInput, 10)
    if (isNaN(ep) || ep <= 0 || isNaN(min) || min <= 0) return
    update({
      durations: {
        ...durations,
        [`${seasonNumber}:${ep}`]: min,
      },
    })
    setEpisodeInput('')
    setMinutesInput('')
  }

  const removeException = (key: string) => {
    const next = { ...durations }
    delete next[key]
    update({
      durations: Object.keys(next).length > 0 ? next : undefined,
    })
  }

  return (
    <div className="flex flex-col gap-[8px]">
      {seasonExceptions.length > 0 ? (
        <div className="flex flex-wrap gap-[6px]">
          {seasonExceptions.map((exc) => (
            <span
              key={exc.key}
              className="inline-flex items-center gap-[6px] rounded-nav bg-panel-soft px-[8px] py-[3px] text-small ring-1 ring-inset ring-rule text-ink"
            >
              <span>{unit} {exc.episode}:</span>
              <span className="value font-semibold">{exc.minutes} Min.</span>
              <button
                type="button"
                onClick={() => removeException(exc.key)}
                aria-label={`Ausnahme für ${unit} ${exc.episode} entfernen`}
                className="press flex h-[16px] w-[16px] items-center justify-center rounded-nav text-muted hover:bg-panel-mid hover:text-ink"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-micro text-muted">
          Alle {seasonNumber === 0 ? 'Filme' : 'Folgen'} dieser Staffel nutzen die Standarddauer ({standard} Min.).
        </p>
      )}

      <div className="flex flex-wrap items-center gap-[8px] pt-[2px]">
        <div className="flex items-center gap-[4px]">
          <span className="text-small text-muted">{unit}:</span>
          <TextInput
            type="number"
            min={1}
            value={episodeInput}
            onChange={(e) => setEpisodeInput(e.target.value)}
            className="w-[60px] font-sans"
            placeholder="Nr."
          />
        </div>
        <div className="flex items-center gap-[4px]">
          <span className="text-small text-muted">Dauer:</span>
          <TextInput
            type="number"
            min={1}
            value={minutesInput}
            onChange={(e) => setMinutesInput(e.target.value)}
            className="w-[70px] font-sans"
            placeholder="Min."
          />
          <span className="text-small text-muted">Min.</span>
        </div>
        <Button type="button" size="sm" variant="quiet" onClick={addException}>
          + Ausnahme
        </Button>
      </div>
    </div>
  )
}

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
    <Dialog open onClose={onClose} title={`${item.title} · ${name}`} size="md">
      <div className="flex flex-col gap-[20px]">
        {split ? (
          <ChoiceRow
            value={String(part.index)}
            options={parts.map((entry) => ({ value: String(entry.index), label: entry.title || `Teil ${entry.index + 1}` }))}
            onChange={(value) => onPart(Number(value))}
          />
        ) : null}

        {/* Where it stands and the next step — what the window is opened for. */}
        <div className="flex flex-wrap items-end justify-between gap-x-[20px] gap-y-[12px]">
          <div className="flex min-w-0 flex-1 basis-[260px] flex-col gap-[8px]">
            <p className="text-subheading text-ink">
              {progress.total ? `${progress.watched} von ${progress.total} ${units}` : `${progress.watched} ${progress.watched === 1 ? unit : units}`}{' '}
              <span className="text-body text-muted">gesehen</span>
            </p>
            <ProgressBar fraction={progress.fraction} label={`${name}: gesehen`} />
            <p className="text-small text-prose">
              {progress.complete ? 'Alles gesehen.' : `Weiter mit ${unit} ${progress.next}.`}
              {split && part.to !== null ? ` ${units} ${part.from}–${part.to} der Staffel.` : null}
            </p>
            {progress.total && !progress.complete && progress.total > progress.watched ? (() => {
              const rem = progress.total - progress.watched
              let seasonRemainingMin = 0
              if (season.episodes !== null) {
                for (let ep = 1; ep <= season.episodes; ep++) {
                  if (!season.watched.includes(ep)) {
                    seasonRemainingMin += durationOfEpisode(item, season.number, ep)
                  }
                }
              }
              const plan = calculateBingePlan(rem, durationOfEpisode(item, season.number, 1), seasonRemainingMin)
              return (
                <p className="text-micro text-muted">
                  Noch {rem} {rem === 1 ? unit : units} ({plan.watchTime.short}) · fertig bei 1/Tag: {plan.finishAt1PerDay}
                </p>
              )
            })() : null}
          </div>
          {isHere && item.episode !== null && !progress.complete ? (
            <span className="flex flex-wrap gap-[8px]">
              {item.url.trim() ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    openHere(item)
                    onClose()
                  }}
                >
                  {hereLabel(item)} laden
                </Button>
              ) : null}
              <Button type="button" size="sm" variant={item.url.trim() ? 'quiet' : 'primary'} onClick={() => markSeen(item)}>
                {hereLabel(item)} gesehen
              </Button>
            </span>
          ) : !progress.complete ? (
            <Button
              type="button"
              size="sm"
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

        <div className="flex flex-col gap-[10px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[4px] text-small">
            <span className="text-prose">Antippen zum Abhaken, mit Umschalt alles bis dort</span>
            <span className="flex gap-[16px]">
              <button
                type="button"
                disabled={part.to === null}
                onClick={() => part.to !== null && setSeasons(markRange(item, number, part.from, part.to, true))}
                className={`${linkClass} disabled:no-underline disabled:opacity-40`}
              >
                Alle gesehen
              </button>
              <button
                type="button"
                disabled={progress.watched === 0}
                onClick={() => setSeasons(markRange(item, number, part.from, part.to ?? Infinity, false))}
                className="press rounded-nav text-prose hover:text-ink disabled:opacity-40"
              >
                Zurücksetzen
              </button>
            </span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-[6px]">
            {Array.from({ length: shownCount }, (_, i) => part.from + i).map((episode) => {
              const seen = season.watched.includes(episode)
              const here = isHere && item.episode === episode
              const epDuration = durationOfEpisode(item, number, episode)
              const hasCustomDuration = Boolean(item.durations && typeof item.durations[`${number}:${episode}`] === 'number')
              return (
                <button
                  key={episode}
                  type="button"
                  aria-pressed={seen}
                  aria-label={`${unit} ${episode}${seen ? ', gesehen' : ''}${here ? ', hier sind Sie' : ''} (${epDuration} Min.)`}
                  title={`${unit} ${episode} · ${epDuration} Min.${hasCustomDuration ? ' (eigene Dauer)' : ''} · Klicken: gesehen / nicht gesehen · Umschalt-Klick: alles bis hier`}
                  onClick={(event) => {
                    setSeasons(event.shiftKey ? watchedUpTo(item, number, episode) : toggleWatched(item, number, episode))
                  }}
                  className={`press value relative flex h-[40px] items-center justify-center rounded-nav text-small transition-colors ${
                    seen ? 'bg-ink text-on-ink' : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid'
                  } ${here ? 'ring-2 ring-inset ring-ink' : ''}`}
                >
                  {episode}
                  {hasCustomDuration ? (
                    <span
                      className={`absolute top-[3px] right-[4px] h-[5px] w-[5px] rounded-full ${seen ? 'bg-raised' : 'bg-ink'}`}
                      title={`${epDuration} Min.`}
                    />
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>

        {/* Everything that changes the season rather than what is seen, folded
            away — open from the start while its length is still unknown. */}
        <Reveal
          label={`${split ? 'Teil' : number === 0 ? 'Filme' : 'Staffel'} bearbeiten: Anzahl, Name, Cover${number === 0 ? '' : ', Teile'}`}
          defaultOpen={part.episodes === null}
        >
          <div className="flex flex-col gap-[18px] pt-[10px]">
            <div className="grid gap-[16px] sm:grid-cols-2">
              <Group label={split ? `${units} in diesem Teil` : `Wie viele ${units}`}>
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
              </Group>
              {split ? (
                <Group label="Name dieses Teils">
                  <TextInput
                    value={part.title ?? ''}
                    placeholder={`${seasonName(season)} · Teil ${part.index + 1}`}
                    onChange={(event) => patchPart({ title: event.target.value || undefined })}
                    className="font-sans"
                  />
                </Group>
              ) : (
                <Group label="Name">
                  <TextInput
                    value={season.title ?? ''}
                    placeholder={number === 0 ? 'Filme' : `Staffel ${number}`}
                    onChange={(event) => patchSeason({ title: event.target.value || undefined })}
                    className="font-sans"
                  />
                </Group>
              )}
            </div>
            {split ? (
              <CoverField
                label="Cover dieses Teils — sonst das der Staffel oder Serie"
                value={part.cover}
                frame={part.coverFrame}
                format={item.tileFormat}
                onChange={(cover, coverFrame) => patchPart({ cover, coverFrame })}
              />
            ) : (
              <CoverField
                label="Cover — sonst das der Serie"
                value={season.cover}
                frame={season.coverFrame}
                format={item.tileFormat}
                onChange={(cover, coverFrame) => patchSeason({ cover, coverFrame })}
              />
            )}
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
              ) : number > 0 ? (
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
              ) : null}
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

            {/* Episode Duration & Exceptions for this season */}
            <div className="flex flex-col gap-[10px] border-t border-line pt-[14px]">
              <div className="flex items-baseline justify-between">
                <span className="text-small font-medium text-ink">
                  Episodendauer ({number === 0 ? 'Filme' : `Staffel ${number}`})
                </span>
                <span className="text-micro text-muted">
                  Standard: {number === 0 ? (item.filmDuration ?? 90) : (item.episodeDuration ?? 24)} Min.
                </span>
              </div>
              <SeasonDurationExceptions
                item={item}
                seasonNumber={number}
                unit={unit}
                update={(patch) => updateMerkItem(item.id, patch)}
              />
            </div>
          </div>
        </Reveal>
      </div>
    </Dialog>
  )
}

/**
 * Detailed statistics for the Merkliste: watch time, status distribution,
 * ratings, and completion metrics.
 */

/**
 * Was soll ich schauen? (Shuffle / Random Pick)
 */
function ShuffleDialog({
  items,
  open,
  onClose,
  onOpenSeries,
}: {
  items: SavedLinkItem[]
  open: boolean
  onClose: () => void
  onOpenSeries: (id: string) => void
}) {
  const [currentId, setCurrentId] = useState<string | null>(null)
  const openHere = useOpenHere()

  useEffect(() => {
    if (open) {
      const initial = pickRandomCandidate(items)
      setCurrentId(initial?.id ?? null)
    }
  }, [open, items])

  const item = items.find((i) => i.id === currentId) ?? items[0] ?? null

  const reroll = () => {
    const next = pickRandomCandidate(items, currentId ?? undefined)
    setCurrentId(next?.id ?? null)
  }

  if (!open || !item) return null

  const progress = itemProgress(item)
  const stand = standLabel(item)
  const cover = seriesCover(item)
  const poster = cover && cover.src ? cover : null
  const hasUrl = Boolean(item.url?.trim())
  const canAdvance = !caughtUp(seasonsOf(item)) && item.episode !== null

  return (
    <Dialog open onClose={onClose} title="Was soll ich schauen?" size="md">
      <div className="flex flex-col gap-[20px]">
        <div className="flex flex-col gap-[16px] sm:flex-row sm:items-center">
          <div
            className={`relative w-[110px] shrink-0 overflow-hidden rounded-card sm:w-[130px] ${poster ? 'bg-stage' : 'bg-panel-mid'}`}
            style={{ aspectRatio: ratioOf(item.tileFormat) }}
          >
            {poster ? <CoverImage src={poster.src} frame={poster.frame} /> : <NamePoster title={item.title} />}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-[8px]">
            <div className="flex flex-wrap items-center justify-between gap-[8px]">
              <span className="text-micro font-mono uppercase tracking-[0.06em] text-muted">Zufallsauswahl</span>
              {item.rating ? (
                <span className="flex items-center gap-[2px] text-small font-semibold text-ink">
                  <span className="text-amber-500">★</span> {item.rating}
                </span>
              ) : null}
            </div>
            <h3 className="display-sm min-w-0 break-words">{item.title}</h3>
            <p className="text-body text-prose">
              {stand}
              <span className="text-muted">
                {' · '}
                {progress.total ? `${progress.watched} von ${progress.total} gesehen` : `${progress.watched} gesehen`}
              </span>
            </p>
            <ProgressBar fraction={progress.fraction} label={`${item.title}: gesehen`} />
            {item.notes ? <p className="text-small text-muted line-clamp-2">{item.notes}</p> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-[10px] border-t border-line pt-[14px]">
          <Button type="button" size="sm" variant="quiet" onClick={reroll}>
            🎲 Anderen Vorschlag würfeln
          </Button>
          <div className="flex flex-wrap items-center gap-[8px]">
            {hasUrl && canAdvance ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  openHere(item)
                  onClose()
                }}
              >
                {hereLabel(item)} laden
              </Button>
            ) : null}
            {canAdvance ? (
              <Button
                type="button"
                size="sm"
                variant={hasUrl ? 'quiet' : 'primary'}
                onClick={() => markSeen(item)}
              >
                {hereLabel(item)} gesehen
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="quiet"
              onClick={() => {
                onClose()
                onOpenSeries(item.id)
              }}
            >
              Serie öffnen
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

function StatsDialog({ items, onClose }: { items: SavedLinkItem[]; onClose: () => void }) {
  const stats = useMemo(() => calculateMerklisteStats(items), [items])
  const [copied, setCopied] = useState(false)

  const exportImage = () => {
    const canvas = document.createElement('canvas')
    canvas.width = 900
    canvas.height = 500
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Background paper
    ctx.fillStyle = '#f8faf8'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Border
    ctx.strokeStyle = '#a7bca9'
    ctx.lineWidth = 2
    ctx.strokeRect(20, 20, canvas.width - 40, canvas.height - 40)

    // Inner rule
    ctx.strokeStyle = '#cbd7cf'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(40, 110)
    ctx.lineTo(canvas.width - 40, 110)
    ctx.stroke()

    // Title
    ctx.fillStyle = '#0b4a22'
    ctx.font = 'bold 30px system-ui, -apple-system, sans-serif'
    ctx.fillText('Sondra · Merkliste Statistik', 40, 70)

    // Subtitle / Date
    ctx.fillStyle = '#4e6355'
    ctx.font = '15px system-ui, -apple-system, sans-serif'
    const today = new Date().toLocaleDateString('de-CH', { day: 'numeric', month: 'long', year: 'numeric' })
    ctx.fillText(`Prüfprotokoll vom ${today}`, 40, 96)

    // 4 Stats Cards
    const cards = [
      { label: 'Gesehene Folgen', val: `${stats.seenTotal}`, sub: stats.seenTotal === 1 ? 'Folge' : 'Folgen' },
      { label: 'Geschätzte Sehzeit', val: `${stats.watchTime.short}`, sub: stats.watchTime.long },
      { label: 'Katalog', val: `${stats.totalSeries}`, sub: `${stats.watchingCount} am Schauen` },
      { label: 'Bewertungsschnitt', val: stats.avgRating ? `★ ${stats.avgRating}` : '—', sub: `${stats.ratedCount} bewertet` },
    ]

    cards.forEach((c, idx) => {
      const x = 40 + idx * 205
      const y = 135
      ctx.fillStyle = '#e0f0e5'
      ctx.fillRect(x, y, 195, 110)
      ctx.strokeStyle = '#a7bca9'
      ctx.strokeRect(x, y, 195, 110)

      ctx.fillStyle = '#4e6355'
      ctx.font = '13px system-ui, sans-serif'
      ctx.fillText(c.label, x + 14, y + 28)

      ctx.fillStyle = '#0b4a22'
      ctx.font = 'bold 26px system-ui, sans-serif'
      ctx.fillText(c.val, x + 14, y + 68)

      ctx.fillStyle = '#111a14'
      ctx.font = '12px system-ui, sans-serif'
      ctx.fillText(c.sub.slice(0, 24), x + 14, y + 94)
    })

    // Status breakdown
    ctx.fillStyle = '#111a14'
    ctx.font = 'bold 15px system-ui, sans-serif'
    ctx.fillText('Status-Aufteilung', 40, 285)

    // Progress bar
    const barX = 40
    const barY = 300
    const barW = canvas.width - 80
    const barH = 14
    ctx.fillStyle = '#cbd7cf'
    ctx.fillRect(barX, barY, barW, barH)

    if (stats.totalSeries > 0) {
      const wW = (stats.watchingCount / stats.totalSeries) * barW
      const lW = (stats.laterCount / stats.totalSeries) * barW
      const dW = (stats.doneCount / stats.totalSeries) * barW

      ctx.fillStyle = '#0b4a22'
      ctx.fillRect(barX, barY, wW, barH)
      ctx.fillStyle = '#d97706'
      ctx.fillRect(barX + wW, barY, lW, barH)
      ctx.fillStyle = '#799081'
      ctx.fillRect(barX + wW + lW, barY, dW, barH)
    }

    // Legend
    ctx.font = '14px system-ui, sans-serif'
    ctx.fillStyle = '#0b4a22'
    ctx.fillText(`● Am Schauen: ${stats.watchingCount} (${stats.watchingPercent}%)`, 40, 345)
    ctx.fillStyle = '#d97706'
    ctx.fillText(`● Später: ${stats.laterCount} (${stats.laterPercent}%)`, 280, 345)
    ctx.fillStyle = '#799081'
    ctx.fillText(`● Fertig: ${stats.doneCount} (${stats.donePercent}%)`, 460, 345)

    // Footer brand
    ctx.fillStyle = '#799081'
    ctx.font = '13px monospace'
    ctx.fillText('Erstellt mit Sondra · https://sondra.lizge.ch', 40, 430)

    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Sondra-Merkliste-Statistik-${new Date().toISOString().slice(0, 10)}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  const copySummary = () => {
    const text = [
      `📊 **Meine Sondra Merkliste**: `,
      `• ${stats.watchingCount} am Schauen · ${stats.laterCount} später · ${stats.doneCount} fertig (${stats.totalSeries} Serien)`,
      `• ${stats.seenTotal} Folgen gesehen (ca. ${stats.watchTime.short} / ${stats.watchTime.long} Sehzeit)`,
      stats.avgRating ? `• ⭐️ Durchschnittsbewertung: ★ ${stats.avgRating}` : null,
      stats.completedSeasons > 0 ? `• 🏆 ${stats.completedSeasons} Staffeln komplett gesehen` : null,
      ``,
      `Erstellt mit Sondra (https://sondra.lizge.ch)`,
    ].filter(Boolean).join('\n')

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <Dialog open onClose={onClose} title="Statistiken zur Merkliste" size="md">
      <div className="flex flex-col gap-[20px]">
        {/* 4 Hero Cards */}
        <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-4">
          <div className="flex flex-col justify-between rounded-nav bg-panel-soft p-[12px] ring-1 ring-inset ring-rule">
            <span className="text-small text-muted">Gesehen</span>
            <div className="mt-[4px] flex items-baseline gap-[4px]">
              <span className="value pop text-subheading font-semibold text-ink">{stats.seenTotal}</span>
              <span className="text-small text-muted">{stats.seenTotal === 1 ? 'Folge' : 'Folgen'}</span>
            </div>
            <span className="mt-[2px] text-micro text-prose">
              {stats.overallProgressPercent !== null ? `${stats.overallProgressPercent} % aller Folgen` : 'über alle Serien'}
            </span>
          </div>

          <div className="flex flex-col justify-between rounded-nav bg-panel-soft p-[12px] ring-1 ring-inset ring-rule">
            <span className="text-small text-muted">Sehzeit (ca.)</span>
            <div className="mt-[4px]">
              <span className="value pop text-subheading font-semibold text-ink">{stats.watchTime.short}</span>
            </div>
            <span className="mt-[2px] text-micro text-prose truncate" title={stats.watchTime.long}>
              {stats.watchTime.long}
            </span>
          </div>

          <div className="flex flex-col justify-between rounded-nav bg-panel-soft p-[12px] ring-1 ring-inset ring-rule">
            <span className="text-small text-muted">Serien</span>
            <div className="mt-[4px] flex items-baseline gap-[4px]">
              <span className="value pop text-subheading font-semibold text-ink">{stats.totalSeries}</span>
              <span className="text-small text-muted">{stats.totalSeries === 1 ? 'Serie' : 'Serien'}</span>
            </div>
            <span className="mt-[2px] text-micro text-prose">
              {stats.watchingCount} am Schauen
            </span>
          </div>

          <div className="flex flex-col justify-between rounded-nav bg-panel-soft p-[12px] ring-1 ring-inset ring-rule">
            <span className="text-small text-muted">Bewertung</span>
            <div className="mt-[4px]">
              <span className="value pop text-subheading font-semibold text-ink">
                {stats.avgRating ? `★ ${stats.avgRating}` : '—'}
              </span>
            </div>
            <span className="mt-[2px] text-micro text-prose">
              {stats.ratedCount > 0 ? `${stats.ratedCount} bewertet` : 'Noch keine'}
            </span>
          </div>
        </div>

        {/* Status distribution */}
        <div className="flex flex-col gap-[8px]">
          <div className="flex items-baseline justify-between text-small">
            <span className="font-medium text-ink">Status-Aufteilung</span>
            <span className="text-muted">{stats.totalSeries} {stats.totalSeries === 1 ? 'Serie' : 'Serien'}</span>
          </div>
          {stats.totalSeries > 0 ? (
            <div className="flex h-[8px] w-full overflow-hidden rounded-full bg-rule">
              {stats.watchingCount > 0 ? (
                <div
                  style={{ width: `${stats.watchingPercent}%` }}
                  className="bg-ink transition-all"
                  title={`${stats.watchingCount} am Schauen (${stats.watchingPercent}%)`}
                />
              ) : null}
              {stats.laterCount > 0 ? (
                <div
                  style={{ width: `${stats.laterPercent}%` }}
                  className="bg-rule transition-all"
                  title={`${stats.laterCount} später (${stats.laterPercent}%)`}
                />
              ) : null}
              {stats.doneCount > 0 ? (
                <div
                  style={{ width: `${stats.donePercent}%` }}
                  className="bg-faint transition-all"
                  title={`${stats.doneCount} fertig (${stats.donePercent}%)`}
                />
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] text-small">
            <span className="flex items-center gap-[6px]">
              <span className="size-[8px] rounded-full bg-ink inline-block" />
              <span className="text-prose">Am Schauen:</span>
              <span className="value pop font-medium text-ink">{stats.watchingCount}</span>
              <span className="text-micro text-muted">({stats.watchingPercent}%)</span>
            </span>
            <span className="flex items-center gap-[6px]">
              <span className="size-[8px] rounded-full bg-rule inline-block" />
              <span className="text-prose">Später:</span>
              <span className="value pop font-medium text-ink">{stats.laterCount}</span>
              <span className="text-micro text-muted">({stats.laterPercent}%)</span>
            </span>
            <span className="flex items-center gap-[6px]">
              <span className="size-[8px] rounded-full bg-faint inline-block" />
              <span className="text-prose">Fertig:</span>
              <span className="value pop font-medium text-ink">{stats.doneCount}</span>
              <span className="text-micro text-muted">({stats.donePercent}%)</span>
            </span>
          </div>
        </div>

        {/* Detailed stats with Stat primitives */}
        <div className="flex flex-col">
          <Stat
            label="Gesehene Folgen"
            value={String(stats.seenTotal)}
            unit={stats.seenTotal === 1 ? 'Folge' : 'Folgen'}
            note={stats.knownTotalEpisodes > 0 ? `von mindestens ${stats.knownTotalEpisodes} erfassten Folgen` : undefined}
            emphasis
          />
          {stats.overallProgressPercent !== null ? (
            <Stat
              label="Gesamtfortschritt"
              value={`${stats.overallProgressPercent} %`}
              note="aller Folgen mit bekannter Episodenanzahl"
            />
          ) : null}
          <Stat
            label="Geschätzte Sehzeit"
            value={stats.watchTime.short}
            note={`Entspricht ca. ${stats.watchTime.long} (geschätzt mit 24 Min. pro Folge)`}
          />
          <Stat
            label="Staffeln abgeschlossen"
            value={`${stats.completedSeasons} von ${stats.totalSeasons}`}
            note={stats.totalSeasons > 0 ? `${Math.round((stats.completedSeasons / stats.totalSeasons) * 100)} % der Staffeln komplett gesehen` : undefined}
          />
          {stats.filmsSeen > 0 || stats.filmCount > 0 ? (
            <Stat
              label="Filme & Specials"
              value={String(stats.filmsSeen)}
              unit="gesehen"
              note={stats.filmCount > 0 ? `von ${stats.filmCount} erfasst` : undefined}
            />
          ) : null}
          {stats.ratedCount > 0 ? (
            <Stat
              label="Durchschnittsbewertung"
              value={`★ ${stats.avgRating}`}
              note={`über ${stats.ratedCount} bewertete ${stats.ratedCount === 1 ? 'Serie' : 'Serien'}`}
            />
          ) : null}
        </div>

        {/* Ratings distribution */}
        {stats.ratedCount > 0 ? (
          <div className="flex flex-col gap-[8px] border-t border-line pt-[12px]">
            <span className="text-small font-medium text-ink">Bewertungs-Verteilung</span>
            <div className="flex flex-col gap-[6px]">
              {stats.ratingDistribution.map(({ stars, count }) => (
                <div key={stars} className="flex items-center gap-[8px] text-small">
                  <span className="w-[42px] text-right text-muted">{stars} ★</span>
                  <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-rule">
                    <div
                      className="h-full bg-ink transition-all"
                      style={{ width: `${stats.ratedCount > 0 ? (count / stats.ratedCount) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="value w-[24px] text-right text-muted">{count}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Recent items */}
        {stats.recentItems.length > 0 ? (
          <div className="flex flex-col gap-[6px] border-t border-line pt-[12px]">
            <span className="text-small font-medium text-ink">Zuletzt geschaut</span>
            <div className="flex flex-col divide-y divide-line/60">
              {stats.recentItems.map((item) => {
                const prog = itemProgress(item)
                return (
                  <div key={item.id} className="flex items-baseline justify-between gap-[12px] py-[6px]">
                    <span className="text-small font-medium text-ink truncate">{item.title}</span>
                    <span className="text-micro text-muted shrink-0">
                      {prog.watched} {prog.total ? `von ${prog.total}` : 'gesehen'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {/* Export & Actions */}
        <div className="flex flex-wrap items-center justify-between gap-[10px] border-t border-line pt-[12px]">
          <div className="flex flex-wrap items-center gap-[8px]">
            <Button type="button" size="sm" variant="quiet" onClick={exportImage} title="Statistiken als PNG-Grafik speichern">
              🖼️ Als Bild speichern
            </Button>
            <Button type="button" size="sm" variant="quiet" onClick={copySummary} title="Zusammenfassung als Text kopieren">
              {copied ? '✓ Kopiert!' : '📋 Text kopieren'}
            </Button>
          </div>
          <Button type="button" size="sm" onClick={onClose}>
            Schließen
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const linkClass =
  'press inline-flex items-center gap-[6px] rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink'

/** A label over its control, without a rule — the dialogs had a line over every field. */
function Group({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-[6px] ${className}`}>
      <span className="text-small text-prose">{label}</span>
      {children}
    </div>
  )
}

/** „Cover" with the tile shape beside it — the two decide one picture. */
function CoverWithFormat({
  value,
  frame,
  format,
  onChange,
  onFormat,
}: {
  value: string | undefined
  frame?: CoverFrame
  format?: TileFormat
  onChange: (value: string | undefined, frame: CoverFrame | undefined) => void
  onFormat: (format: TileFormat) => void
}) {
  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[8px]">
        <span className="text-small text-prose">Cover</span>
        <FormatChoice value={format} onChange={onFormat} />
      </div>
      <CoverField label="" value={value} frame={frame} format={format} onChange={onChange} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* A series, edited                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Three groups instead of twelve ruled lines: what the series is (name,
 * stand, rating, seasons, note), how it looks (cover and tile shape), and —
 * folded away — how it is loaded.
 */

function DurationSettings({
  item,
  update,
}: {
  item: SavedLinkItem
  update: (patch: Partial<SavedLinkItem>) => void
}) {
  const seasons = seasonsOf(item)
  const hasFilms = seasons.some((s) => s.number === 0)
  const standardEp = item.episodeDuration ?? 24
  const standardFilm = item.filmDuration ?? 90

  const [excSeason, setExcSeason] = useState<number>(seasons[0]?.number ?? 1)
  const [excEpisode, setExcEpisode] = useState<string>('1')
  const [excMinutes, setExcMinutes] = useState<string>('48')

  const durations = item.durations || {}
  const exceptionEntries = Object.entries(durations)
    .map(([key, min]) => {
      const [s, e] = key.split(':').map(Number)
      return { key, season: s, episode: e, minutes: min }
    })
    .sort((a, b) => (a.season === b.season ? a.episode - b.episode : a.season - b.season))

  const handleAddException = () => {
    const epNum = parseInt(excEpisode, 10)
    const minNum = parseInt(excMinutes, 10)
    if (isNaN(epNum) || epNum <= 0 || isNaN(minNum) || minNum <= 0) return

    const key = `${excSeason}:${epNum}`
    update({
      durations: {
        ...durations,
        [key]: minNum,
      },
    })
    setExcEpisode(String(epNum + 1))
  }

  const handleRemoveException = (key: string) => {
    const next = { ...durations }
    delete next[key]
    update({
      durations: Object.keys(next).length > 0 ? next : undefined,
    })
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="grid gap-x-[28px] gap-y-[16px] sm:grid-cols-2">
        <Group label="Standard-Episodendauer">
          <div className="flex flex-col gap-[8px]">
            <div className="flex items-center gap-[8px]">
              <TextInput
                type="number"
                min={1}
                max={600}
                value={String(standardEp)}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val) && val > 0) {
                    update({ episodeDuration: val })
                  }
                }}
                className="w-[90px] font-sans"
              />
              <span className="text-small text-muted">Minuten pro Folge</span>
            </div>
            <div className="flex flex-wrap items-center gap-[6px]">
              <span className="text-micro text-muted">Vorschläge:</span>
              {[20, 24, 45, 60].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => update({ episodeDuration: preset })}
                  className={`press rounded-nav px-[8px] py-[2px] text-micro transition-colors ${
                    standardEp === preset
                      ? 'bg-ink text-on-ink font-medium'
                      : 'bg-panel-soft text-prose hover:bg-panel-mid'
                  }`}
                >
                  {preset} Min.
                </button>
              ))}
            </div>
          </div>
        </Group>

        {hasFilms ? (
          <Group label="Standard-Filmdauer">
            <div className="flex flex-col gap-[8px]">
              <div className="flex items-center gap-[8px]">
                <TextInput
                  type="number"
                  min={1}
                  max={600}
                  value={String(standardFilm)}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!isNaN(val) && val > 0) {
                      update({ filmDuration: val })
                    }
                  }}
                  className="w-[90px] font-sans"
                />
                <span className="text-small text-muted">Minuten pro Film</span>
              </div>
              <div className="flex flex-wrap items-center gap-[6px]">
                <span className="text-micro text-muted">Vorschläge:</span>
                {[90, 105, 120].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => update({ filmDuration: preset })}
                    className={`press rounded-nav px-[8px] py-[2px] text-micro transition-colors ${
                      standardFilm === preset
                        ? 'bg-ink text-on-ink font-medium'
                        : 'bg-panel-soft text-prose hover:bg-panel-mid'
                    }`}
                  >
                    {preset} Min.
                  </button>
                ))}
              </div>
            </div>
          </Group>
        ) : null}
      </div>

      <div className="flex flex-col gap-[10px] border-t border-line pt-[14px]">
        <div className="flex items-baseline justify-between">
          <span className="text-small font-medium text-ink">Episodenspezifische Ausnahmen</span>
          <span className="text-micro text-muted">
            {exceptionEntries.length === 0
              ? 'Keine Ausnahmen'
              : `${exceptionEntries.length} ${exceptionEntries.length === 1 ? 'Ausnahme' : 'Ausnahmen'}`}
          </span>
        </div>
        <p className="text-micro text-muted">
          Für Pilotfolgen, Spezialfolgen, Doppelfolgen oder abweichende Episodenlängen.
        </p>

        {exceptionEntries.length > 0 ? (
          <div className="flex flex-wrap gap-[6px]">
            {exceptionEntries.map((exc) => (
              <span
                key={exc.key}
                className="inline-flex items-center gap-[6px] rounded-nav bg-panel-soft px-[10px] py-[4px] text-small ring-1 ring-inset ring-rule text-ink"
              >
                <span className="font-medium">
                  {exc.season === 0 ? `Film ${exc.episode}` : `S${exc.season}E${exc.episode}`}
                </span>
                <span className="text-muted">·</span>
                <span className="value font-semibold">{exc.minutes} Min.</span>
                <button
                  type="button"
                  onClick={() => handleRemoveException(exc.key)}
                  aria-label={`Ausnahme für ${exc.season === 0 ? `Film ${exc.episode}` : `S${exc.season}E${exc.episode}`} entfernen`}
                  className="press ml-[2px] flex h-[18px] w-[18px] items-center justify-center rounded-nav text-muted hover:bg-panel-mid hover:text-ink"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-[8px] pt-[4px]">
          {seasons.length > 1 ? (
            <Select
              aria-label="Staffel auswählen"
              value={String(excSeason)}
              onChange={(e) => setExcSeason(Number(e.target.value))}
              className="w-auto! py-[6px]"
            >
              {seasons.map((s) => (
                <option key={s.number} value={String(s.number)}>
                  {s.number === 0 ? 'Filme' : `Staffel ${s.number}`}
                </option>
              ))}
            </Select>
          ) : (
            <span className="text-small text-prose">
              {seasons[0]?.number === 0 ? 'Film' : 'Staffel 1'}
            </span>
          )}

          <div className="flex items-center gap-[4px]">
            <span className="text-small text-muted">{excSeason === 0 ? 'Nr.:' : 'Folge:'}</span>
            <TextInput
              type="number"
              min={1}
              value={excEpisode}
              onChange={(e) => setExcEpisode(e.target.value)}
              className="w-[65px] font-sans"
              placeholder="1"
            />
          </div>

          <div className="flex items-center gap-[4px]">
            <span className="text-small text-muted">Dauer:</span>
            <TextInput
              type="number"
              min={1}
              value={excMinutes}
              onChange={(e) => setExcMinutes(e.target.value)}
              className="w-[70px] font-sans"
              placeholder="Min."
            />
            <span className="text-small text-muted">Min.</span>
          </div>

          <Button type="button" size="sm" variant="quiet" onClick={handleAddException}>
            + Ausnahme speichern
          </Button>
        </div>
      </div>
    </div>
  )
}

function SeriesDialog({ item, onClose, onRemove }: { item: SavedLinkItem; onClose: () => void; onRemove: () => void }) {
  const update = (patch: Partial<SavedLinkItem>) => updateMerkItem(item.id, patch)
  const seasons = seasonsOf(item)
  const hasFilms = seasons.some((season) => season.number === 0)
  const seasonCount = seasons.filter((season) => season.number > 0).length
  const kind = episodeKindOf(item.url)
  const host = (() => {
    try {
      return item.url.trim() ? new URL(/^https?:\/\//i.test(item.url.trim()) ? item.url.trim() : `https://${item.url.trim()}`).host : ''
    } catch {
      return ''
    }
  })()
  return (
    <Dialog open onClose={onClose} title={item.title || 'Ohne Namen'}>
      <div className="flex flex-col gap-[22px]">
        <div className="grid gap-x-[28px] gap-y-[18px] sm:grid-cols-2">
          <Group label="Name">
            <TextInput value={item.title} onChange={(event) => update({ title: event.target.value })} className="font-sans" />
          </Group>
          <Group label="Stand">
            <ChoiceRow value={statusOf(item)} options={STATUS_OPTIONS} onChange={(status) => update({ status })} />
          </Group>
          <Group label="Bewertung">
            <Rating value={item.rating ?? 0} onChange={(rating) => update({ rating })} />
          </Group>
          <Group label={`${seasonCount} ${seasonCount === 1 ? 'Staffel' : 'Staffeln'}${hasFilms ? ', dazu Filme' : ''}`}>
            <span className="flex flex-wrap gap-x-[18px] gap-y-[4px] text-small">
              <button type="button" onClick={() => addSeasonTo(item)} className={linkClass}>
                <PlusIcon />
                Staffel hinzufügen
              </button>
              {!hasFilms ? (
                <button
                  type="button"
                  onClick={() => update({ seasons: [...seasons, { number: 0, episodes: null, watched: [] }] })}
                  className={linkClass}
                >
                  <PlusIcon />
                  Filme hinzufügen
                </button>
              ) : null}
            </span>
          </Group>
          <Group label="Notiz" className="sm:col-span-2">
            <textarea
              value={item.notes ?? ''}
              onChange={(event) => update({ notes: event.target.value || undefined })}
              placeholder="Wo es spannend wurde, mit wem Sie schauen …"
              className={textAreaClass}
            />
          </Group>
        </div>

        <div className="border-t border-line pt-[16px]">
          <CoverWithFormat
            value={item.cover}
            frame={item.coverFrame}
            format={item.tileFormat}
            onChange={(cover, coverFrame) => update({ cover, coverFrame })}
            onFormat={(format) => update({ tileFormat: format === 'manga' ? 'manga' : undefined })}
          />
        </div>

        <Reveal
          label={`Episodendauer · Standard ${item.episodeDuration ?? 24} Min.${item.durations && Object.keys(item.durations).length > 0 ? ` · ${Object.keys(item.durations).length} ${Object.keys(item.durations).length === 1 ? 'Ausnahme' : 'Ausnahmen'}` : ''}`}
          defaultOpen={Boolean(item.episodeDuration || item.filmDuration || (item.durations && Object.keys(item.durations).length > 0))}
          className="-mb-[8px]"
        >
          <div className="pt-[10px]">
            <DurationSettings item={item} update={update} />
          </div>
        </Reveal>

        <Reveal label={host ? `Herunterladen · ${host}` : 'Herunterladen: Adresse und Einstellungen'} className="-mb-[8px]">
          <div className="grid gap-x-[28px] gap-y-[18px] pt-[10px] sm:grid-cols-2">
            <Group label="Adresse — leer, wenn nichts geladen werden soll" className="sm:col-span-2">
              <TextInput
                value={item.url}
                placeholder="https://…"
                inputMode="url"
                spellCheck={false}
                onChange={(event) => update({ url: event.target.value })}
              />
            </Group>
            <Group label="Laden als">
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
            </Group>
            <Group label="Qualität">
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
            </Group>
            {kind !== 'list' ? (
              <Group label="Sprachfassung">
                <Select value={item.language} onChange={(event) => update({ language: event.target.value as SavedLinkItem['language'] })}>
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Group>
            ) : null}
            <div className="self-end">
              <Toggle
                label="Untertitel dazu erstellen"
                hint="Whisper schreibt nach dem Laden auf diesem Gerät mit."
                checked={item.autoTranscribe}
                onChange={(autoTranscribe) => update({ autoTranscribe })}
              />
            </div>
          </div>
        </Reveal>

        <div className="flex flex-wrap items-center justify-between gap-[12px] border-t border-line pt-[14px]">
          <button type="button" onClick={onRemove} className={`${linkClass} text-small`}>
            Von der Merkliste nehmen
          </button>
          <Button type="button" size="sm" onClick={onClose}>
            Fertig
          </Button>
        </div>
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
  const [format, setFormat] = useState<TileFormat>('poster')

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
    setFormat('poster')
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
      ...(format === 'manga' ? { tileFormat: format } : {}),
      status: 'watching',
    })
    setMerkItems((current) => [item, ...current])
    reset()
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Serie hinzufügen" size="md">
      <form
        className="flex flex-col gap-[20px]"
        onSubmit={(event) => {
          event.preventDefault()
          if (title.trim() || url.trim()) save()
        }}
      >
        <Group label="Name">
          <TextInput autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Wie die Serie heisst" className="font-sans" />
        </Group>

        <div className="flex flex-wrap gap-x-[28px] gap-y-[16px]">
          <Group label="Staffeln">
            <Stepper label="Anzahl Staffeln" value={seasonCount} max={60} onChange={setSeasonCount} />
          </Group>
          {seasonCount === 1 ? (
            <Group label="Folgen">
              <span className="flex flex-wrap items-center gap-[12px]">
                {countsUnknown ? null : (
                  <Stepper label="Anzahl Folgen" value={counts[0]} max={2000} onChange={(value) => setCount(0, value)} />
                )}
                <span className="w-max">
                  <Toggle label="Noch unbekannt" checked={countsUnknown} onChange={setCountsUnknown} />
                </span>
              </span>
            </Group>
          ) : null}
        </div>

        {seasonCount > 1 ? (
          <Group label="Folgen je Staffel — eine Staffel übernimmt die Zahl der vorigen, bis Sie sie ändern">
            {countsUnknown ? null : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-x-[20px] gap-y-[8px]">
                {counts.map((count, i) => (
                  <span key={i} className="flex items-center justify-between gap-[10px] text-small text-prose">
                    Staffel {i + 1}
                    <Stepper label={`Folgen in Staffel ${i + 1}`} value={count} max={2000} onChange={(value) => setCount(i, value)} />
                  </span>
                ))}
              </div>
            )}
            <span className="w-max">
              <Toggle label="Noch unbekannt" checked={countsUnknown} onChange={setCountsUnknown} />
            </span>
          </Group>
        ) : null}

        <Group label="Gerade bei — was davor liegt, gilt als gesehen">
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
        </Group>

        <Reveal label="Adresse, Filme und Cover" className="-mb-[8px]">
          <div className="flex flex-col gap-[18px] pt-[10px]">
            <div className="grid gap-x-[28px] gap-y-[16px] sm:grid-cols-[minmax(0,1fr)_auto]">
              <Group label="Adresse — zum Laden im Herunterladen">
                <TextInput
                  value={url}
                  onChange={(event) => {
                    const next = event.target.value
                    setUrl(next)
                    if (next.trim()) {
                      const info = parseLinkEpisodeInfo(next)
                      const derived = deriveLinkTitle(next)
                      if (derived && (!title.trim() || title === 'Serie' || title === 'Neuer Link')) {
                        setTitle(derived)
                      }
                      if (info.isEpisodicUrl) {
                        if (info.season > 0) {
                          setSeasonCount((curr) => Math.max(curr, info.season))
                          setAtSeason(info.season)
                        }
                        if (info.episode !== null && info.episode > 0) {
                          setAtEpisode(info.episode)
                        }
                      }
                    }
                  }}
                  placeholder="https://…"
                  inputMode="url"
                  spellCheck={false}
                />
                {url.trim() ? (() => {
                  const derived = deriveLinkTitle(url)
                  const info = parseLinkEpisodeInfo(url)
                  const badge = sourceBadgeForUrl(url)
                  if (!derived && !info.isEpisodicUrl) return null
                  return (
                    <span className="text-micro text-muted">
                      Erkannt: {badge ? `[${badge}] ` : ''}{derived ? `„${derived}“ · ` : ''}
                      {info.isEpisodicUrl ? `Staffel ${info.season}, Folge ${info.episode ?? 'alle'}` : ''}
                    </span>
                  )
                })() : null}
              </Group>
              <Group label="Filme dazu">
                <Stepper label="Anzahl Filme" value={films} min={0} max={200} onChange={setFilms} />
              </Group>
            </div>
            <CoverWithFormat
              value={cover}
              frame={coverFrame}
              format={format}
              onChange={(picture, frame) => {
                setCover(picture)
                setCoverFrame(frame)
              }}
              onFormat={setFormat}
            />
          </div>
        </Reveal>

        <div className="flex flex-wrap items-center justify-end gap-[8px] border-t border-line pt-[14px]">
          <Button type="button" size="sm" variant="quiet" onClick={onClose}>
            Abbrechen
          </Button>
          <Button type="submit" size="sm" disabled={!title.trim() && !url.trim()}>
            Auf die Merkliste
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
