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

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  ANYTYPE_PROBLEM,
  anytype,
  anytypeAvailable,
  inStepWithAnytype,
  loadFromAnytype,
  resetAnytypeCache,
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
  allHistory,
  allTags,
  checkOnlineUpdates,
  onlineNews,
  takeOnlineNews,
  type OnlineNews,
  itemProgress,
  halve,
  markRange,
  importMerkliste,
  merkSaveFailed,
  noteRemoved,
  partName,
  partOfEpisode,
  partProgress,
  partsOf,
  pictureSize,
  pickRandomCandidate,
  readMerklisteFile,
  requestBatchLookup,
  requestLookup,
  OPEN_SERIES_EVENT,
  restoreMerkItem,
  revertImport,
  seasonName,
  seasonProgress,
  seasonsOf,
  setMerkItems,
  settle,
  sortMerkItems,
  SORT_OPTIONS,
  takePendingOpen,
  splitSeason,
  storedParts,
  toggleWatched,
  undoWatchHistory,
  updateMerkItem,
  useMerkliste,
  watchedUpTo,
  withParts,
  withSeason,
  type BatchLookupItem,
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
import { APP_BRIDGE, isDiscordRpcEnabled, setDiscordRpcEnabled, updateDiscordPresence } from '../../lib/desktop'
import { newEpisodesAvailable, newEpisodesOn, setNewEpisodesOn } from '../../lib/newEpisodes'
import { isAniworldUrl } from '../../lib/download'
import { useSession } from '../../state/store'
import { ChoiceRow } from '../editor/EditorShell'
import { Button, Card, Dialog, Notice, Reveal, RowMark, Select, Slider, TextInput, Toggle } from '../ui/primitives'
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


function DiceIcon({ className = 'size-[15px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="2.5" />
      <circle cx="5.5" cy="5.5" r="0.75" fill="currentColor" />
      <circle cx="10.5" cy="5.5" r="0.75" fill="currentColor" />
      <circle cx="8" cy="8" r="0.75" fill="currentColor" />
      <circle cx="5.5" cy="10.5" r="0.75" fill="currentColor" />
      <circle cx="10.5" cy="10.5" r="0.75" fill="currentColor" />
    </svg>
  )
}

function ImageIcon({ className = 'size-[15px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <circle cx="5.5" cy="6" r="1.25" fill="currentColor" />
      <path d="M14 10.5l-3.5-3.5-5 5" />
    </svg>
  )
}

function ClipboardIcon({ className = 'size-[15px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="4" width="9" height="10" rx="1.5" />
      <path d="M6 3a1 1 0 011-1h2a1 1 0 011 1v1H6V3z" />
      <path d="M6 8h4M6 10.5h2.5" />
    </svg>
  )
}

function CheckIcon({ className = 'size-[14px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  )
}

function SmallFilmIcon({ className = 'size-[14px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 3v10M11 3v10M2 6.5h3M2 9.5h3M11 6.5h3M11 9.5h3" />
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
  stacked = false,
}: {
  value: string | undefined
  frame?: CoverFrame
  /** The entry's tile shape; the preview is one of its tiles. */
  format?: TileFormat
  /** A new picture comes without a frame; a new frame keeps the picture. */
  onChange: (value: string | undefined, frame: CoverFrame | undefined) => void
  label?: string
  stacked?: boolean
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
    <div className="flex flex-col gap-[8px] w-full">
      {label ? <span className="text-small text-prose">{label}</span> : null}
      <div className={stacked ? "flex flex-col items-center gap-[12px] w-full" : "flex flex-col gap-[14px] sm:flex-row"}>
        {value ? (
          <div className={stacked ? "w-[140px] shrink-0 mx-auto" : ""}>
            <FrameEditor
              src={value}
              frame={live}
              format={format}
              onFrame={setFrame}
              onError={() => setProblem('Unter dieser Adresse liess sich kein Bild laden.')}
              onLoad={() => setProblem(null)}
            />
          </div>
        ) : (
          <span
            className={`relative shrink-0 overflow-hidden rounded-card bg-panel-mid ring-1 ring-inset ring-line ${
              stacked ? 'w-[140px] mx-auto' : 'w-[120px]'
            }`}
            style={{ aspectRatio: ratioOf(format) }}
          >
            <span className="absolute inset-0 flex items-center justify-center text-small text-prose">kein Bild</span>
          </span>
        )}
        <div className="flex min-w-0 flex-1 w-full flex-col gap-[8px]">
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
                <span className="text-prose">Bild ziehen, um den Ausschnitt zu wählen. Passt es genau ins Format, erst zoomen.</span>
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
      // A block of its own: as an inline span inside the wrapper the 1.1.6
      // layout put around it, width and aspect ratio did nothing — the tile
      // measured 0 × 0, and there was no picture to drag.
      className="relative block w-[140px] shrink-0 cursor-grab touch-none overflow-hidden rounded-card bg-stage outline-none ring-1 ring-line focus-visible:ring-2 focus-visible:ring-ink active:cursor-grabbing"
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
  const [historyOpen, setHistoryOpen] = useState(false)
  const [shuffleOpen, setShuffleOpen] = useState(false)
  const [sortBy, setSortBy] = useState<MerklisteSortOption>('recent')
  const [filterStatus, setFilterStatus] = useState<'all' | SavedLinkStatus>('all')
  const [filterTag, setFilterTag] = useState<string | null>(null)
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [discordRpcOn, setDiscordRpcOn] = useState(() => isDiscordRpcEnabled())
  const [newEpisodesWatch, setNewEpisodesWatch] = useState(() => newEpisodesOn())
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
  // A series asked for from elsewhere — the player, a notice of a new episode.
  const openSeriesRef = useRef(openSeries)
  openSeriesRef.current = openSeries
  useEffect(() => {
    const take = () => {
      const id = takePendingOpen()
      if (id) openSeriesRef.current(id)
    }
    take()
    window.addEventListener(OPEN_SERIES_EVENT, take)
    return () => window.removeEventListener(OPEN_SERIES_EVENT, take)
  }, [])

  const stats = useMemo(() => calculateMerklisteStats(items), [items])
  const availableTags = useMemo(() => allTags(items), [items])

  const filteredItems = useMemo(() => {
    let list = items
    const needle = query.trim().toLowerCase()
    if (needle) {
      list = list.filter(
        (item) =>
          item.title.toLowerCase().includes(needle) ||
          (item.notes ?? '').toLowerCase().includes(needle) ||
          (item.tags ?? []).some((t) => t.toLowerCase().includes(needle)),
      )
    }
    if (filterStatus !== 'all') {
      list = list.filter((item) => statusOf(item) === filterStatus)
    }
    if (filterTag) {
      list = list.filter((item) => (item.tags ?? []).includes(filterTag))
    }
    if (onlyOpen) {
      list = list.filter((item) => !caughtUp(seasonsOf(item)))
    }
    return list
  }, [items, query, filterStatus, filterTag, onlyOpen])

  // Grouped by where each entry stands, sorted according to sortBy within each.
  const groups = useMemo(() => {
    return STATUS_OPTIONS.map((option) => {
      const entries = filteredItems.filter((item) => statusOf(item) === option.value)
      return {
        ...option,
        entries: sortMerkItems(entries, sortBy),
      }
    }).filter((group) => group.entries.length > 0)
  }, [filteredItems, sortBy])

  const allVisibleItems = useMemo(() => groups.flatMap((g) => g.entries), [groups])

  // Global keyboard shortcuts in overview
  useEffect(() => {
    if (openId || adding || editing || season || statsOpen || shuffleOpen || historyOpen || anytypeOpen) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return
      }

      if (e.key === 'ArrowRight' || e.key === 'j') {
        e.preventDefault()
        setFocusedId((current) => {
          if (!current) return allVisibleItems[0]?.id ?? null
          const idx = allVisibleItems.findIndex((i) => i.id === current)
          const next = allVisibleItems[Math.min(allVisibleItems.length - 1, idx + 1)]
          return next?.id ?? current
        })
      } else if (e.key === 'ArrowLeft' || e.key === 'k') {
        e.preventDefault()
        setFocusedId((current) => {
          if (!current) return allVisibleItems[0]?.id ?? null
          const idx = allVisibleItems.findIndex((i) => i.id === current)
          const prev = allVisibleItems[Math.max(0, idx - 1)]
          return prev?.id ?? current
        })
      } else if (e.key === 'Enter') {
        if (focusedId) {
          const focused = allVisibleItems.find((i) => i.id === focusedId)
          if (focused) {
            e.preventDefault()
            openSeries(focused.id)
          }
        }
      } else if (e.key === '+' || e.key === ' ') {
        if (focusedId) {
          const focused = allVisibleItems.find((i) => i.id === focusedId)
          if (focused && focused.episode !== null && !caughtUp(seasonsOf(focused))) {
            e.preventDefault()
            markSeen(focused)
          }
        }
      } else if (e.key === 'Escape') {
        setFocusedId(null)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [allVisibleItems, focusedId, openId, adding, editing, season, statsOpen, shuffleOpen, historyOpen, anytypeOpen])

  // Overview Discord presence
  useEffect(() => {
    if (openId) return
    updateDiscordPresence({
      details: 'Merkliste',
      state: `${items.length} ${items.length === 1 ? 'Serie' : 'Serien'} (${stats.watchingCount} aktiv)`,
      assets: {
        large_image: 'sondra',
        large_text: 'Sondra Studio',
      },
    })
    return () => {
      updateDiscordPresence(null)
    }
  }, [items.length, stats.watchingCount, openId])

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
      {historyOpen ? <WatchHistoryDialog items={items} onClose={() => setHistoryOpen(false)} /> : null}
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
      {anytypeOpen ? <AnytypeDialog link={anytypeLink} count={items.length} onClose={() => setAnytypeOpen(false)} /> : null}
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
                  onClick={() => setHistoryOpen(true)}
                  title="Kürzlich gesehene Folgen im Verlauf anzeigen"
                >
                  Verlauf
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="quiet"
                  onClick={() => setShuffleOpen(true)}
                  title="Zufällige Serie aus der Merkliste vorschlagen"
                  className="inline-flex items-center gap-[6px]"
                >
                  <DiceIcon />
                  <span>Würfeln</span>
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
                restoreMerkItem(removed.item, removed.index)
                setRemoved(null)
              }}
              className={`${linkClass} font-semibold`}
            >
              Rückgängig
            </button>
          </p>
        ) : null}
      </Card>

      {items.length > 0 ? (
        <div className="flex flex-col gap-[10px] -mt-[12px]">
          {/* Status filter tabs & controls */}
          <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[8px] border-b border-line pb-[10px] text-small">
            <div role="radiogroup" aria-label="Stand" className="flex flex-wrap items-center gap-[6px]">
              {(
                [
                  { value: 'all', label: 'Alle' },
                  { value: 'watching', label: 'Am Schauen' },
                  { value: 'later', label: 'Für später' },
                  { value: 'done', label: 'Fertig' },
                ] as const
              ).map((tab) => {
                const active = filterStatus === tab.value
                const count =
                  tab.value === 'all' ? items.length : items.filter((i) => statusOf(i) === tab.value).length
                return (
                  <button
                    key={tab.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setFilterStatus(tab.value)}
                    className={`press flex items-center gap-[6px] rounded-pill px-[12px] py-[5px] text-small font-medium ${
                      active
                        ? 'bg-ink font-semibold text-on-ink'
                        : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid hover:text-ink'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span className={`value text-micro ${active ? 'text-on-ink/75' : 'text-muted'}`}>{count}</span>
                  </button>
                )
              })}
            </div>

            <div className="flex flex-wrap items-center gap-[12px]">
              <button
                type="button"
                aria-pressed={onlyOpen}
                onClick={() => setOnlyOpen((prev) => !prev)}
                className={`press flex items-center gap-[6px] rounded-pill px-[12px] py-[5px] text-small ${
                  onlyOpen
                    ? 'bg-ink font-semibold text-on-ink'
                    : 'text-prose ring-1 ring-inset ring-line hover:bg-panel-soft hover:text-ink'
                }`}
                title="Nur Serien mit noch ungesehenen Folgen anzeigen"
              >
                {onlyOpen ? (
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden>
                    <path d="M3.5 8.4l2.9 2.9 6.1-6.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
                <span>Nur offene Folgen</span>
              </button>

              {/* Only in the app, where the check runs in the background and
                  Windows shows the notice (lib/newEpisodes.ts). */}
              {newEpisodesAvailable ? (
                <button
                  type="button"
                  aria-pressed={newEpisodesWatch}
                  onClick={() => {
                    const next = !newEpisodesWatch
                    setNewEpisodesWatch(next)
                    setNewEpisodesOn(next)
                  }}
                  className="press flex items-center gap-[6px] rounded-pill px-[10px] py-[5px] text-small text-prose hover:bg-panel-soft hover:text-ink"
                  title="Alle drei Stunden prüft Sondra die Serien „Am Schauen“ mit AniWorld-Adresse und meldet eine neue Folge über Windows."
                >
                  <span aria-hidden className={`size-[7px] rounded-pill ${newEpisodesWatch ? 'bg-accent-strong' : 'ring-1 ring-inset ring-rule'}`} />
                  <span>Neue Folgen melden {newEpisodesWatch ? 'an' : 'aus'}</span>
                </button>
              ) : null}
              {/* Only in the app: a web page cannot reach Discord on this computer. */}
              {APP_BRIDGE?.setDiscordPresence ? (
                <button
                  type="button"
                  aria-pressed={discordRpcOn}
                  onClick={() => {
                    const next = !discordRpcOn
                    setDiscordRpcOn(next)
                    setDiscordRpcEnabled(next)
                  }}
                  className="press flex items-center gap-[6px] rounded-pill px-[10px] py-[5px] text-small text-prose hover:bg-panel-soft hover:text-ink"
                  title="In Discord zeigen, was Sie gerade schauen"
                >
                  <span aria-hidden className={`size-[7px] rounded-pill ${discordRpcOn ? 'bg-accent-strong' : 'ring-1 ring-inset ring-rule'}`} />
                  <span>Discord {discordRpcOn ? 'an' : 'aus'}</span>
                </button>
              ) : null}
            </div>
          </div>

          {/* Tags row */}
          {availableTags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-[6px] text-micro">
              <span className="text-muted font-sans mr-[2px]">Tags:</span>
              <button
                type="button"
                onClick={() => setFilterTag(null)}
                aria-pressed={filterTag === null}
                className={`press rounded-pill px-[9px] py-[3px] ${
                  filterTag === null ? 'bg-ink font-semibold text-on-ink' : 'text-prose ring-1 ring-inset ring-line hover:bg-panel-soft hover:text-ink'
                }`}
              >
                Alle Tags
              </button>
              {availableTags.map((tag) => {
                const active = filterTag === tag
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setFilterTag(active ? null : tag)}
                    aria-pressed={active}
                    className={`press rounded-pill px-[9px] py-[3px] ${
                      active ? 'bg-ink font-semibold text-on-ink' : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid hover:text-ink'
                    }`}
                  >
                    #{tag}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {items.length === 0 ? (
        <EmptyState onAdd={() => setAdding(true)} onDownload={() => setPanel('downloader')} />
      ) : groups.length === 0 ? (
        <p className="text-small text-prose">Keine Serien gefunden für die gewählten Filter.</p>
      ) : (
        groups.map((group) => (
          <section key={group.value} aria-label={group.label} className="flex flex-col gap-[14px]">
            <h3 className="flex items-baseline gap-[10px] border-b border-line pb-[10px] text-subheading text-ink">
              {group.label}
              <span className="value text-small text-muted">{group.entries.length}</span>
            </h3>
            {/* Posters stand on one line at their foot, like books on a shelf,
                whatever their shape. */}
            <div
              onPointerDown={() => setFocusedId(null)}
              className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] items-end gap-x-[14px] gap-y-[24px] sm:grid-cols-[repeat(auto-fill,minmax(156px,1fr))] sm:gap-x-[18px]"
            >
              {group.entries.map((item) => (
                <SeriesTile
                  key={item.id}
                  item={item}
                  onOpen={() => openSeries(item.id)}
                  isFocused={focusedId === item.id}
                  onFocus={(event) => {
                    // Tab sets the keyboard's place; a click does not.
                    if ((event.target as HTMLElement).matches(':focus-visible')) setFocusedId(item.id)
                  }}
                />
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
    const next = answer.ok ? { reachable: answer.reachable, paired: answer.paired, lasting: answer.lasting, space: answer.space, note: answer.note } : null
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

  // Periodic and on-focus background synchronization with Anytype
  useEffect(() => {
    if (!connected) return
    const onFocus = () => void latest.current.run()
    window.addEventListener('focus', onFocus)
    const interval = window.setInterval(() => void latest.current.run(), 30_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.clearInterval(interval)
    }
  }, [connected])

  return { available: anytypeAvailable, status, connected, sync, run, refresh }
}

const clock = (at: number) => new Date(at).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })

/**
 * Connecting the Merkliste to Anytype, step by step — Anytype open, a code
 * it shows typed in here, a space — and, once connected, the state of it
 * with what can be done.
 */
function AnytypeDialog({ link, count, onClose }: { link: AnytypeLink; count: number; onClose: () => void }) {
  const { status } = link
  const [challenge, setChallenge] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [spaces, setSpaces] = useState<{ id: string; name: string }[] | null>(null)
  const [pick, setPick] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ text: string; detail?: string } | null>(null)
  // The space being looked at, the lists found there, and which one is meant.
  const [selectedSpace, setSelectedSpace] = useState<{ id: string; name: string } | null>(null)
  const [foundNotes, setFoundNotes] = useState<FoundNote[] | null>(null)
  const [noteId, setNoteId] = useState('')
  const [creatingNew, setCreatingNew] = useState(false)
  const [newNoteName, setNewNoteName] = useState('Sondra · Merkliste (Gerät 2)')
  /** What „Aus Anytype laden“ replaced, to take it back in. */
  const [loaded, setLoaded] = useState<{ count: number; before: SavedLinkItem[] } | null>(null)

  const failed = (answer: { error: AnytypeError; detail?: string }) => {
    setProblem({ text: ANYTYPE_PROBLEM[answer.error], detail: answer.detail })
    setBusy(false)
  }
  const askCode = async () => {
    setBusy(true)
    setProblem(null)
    setCode('')
    const answer = await anytype.challenge()
    if (!answer.ok) return failed(answer)
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
      return failed(answer)
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
    if (!answer.ok) return failed(answer)
    setSpaces(answer.spaces)
    setBusy(false)
    // With one space there is nothing to choose.
    if (answer.spaces.length === 1) return loadNotesForSpace(answer.spaces[0])
    setPick((current) => (answer.spaces.some((space) => space.id === current) ? current : (answer.spaces[0]?.id ?? '')))
  }
  const loadNotesForSpace = async (space: { id: string; name: string }) => {
    setBusy(true)
    setProblem(null)
    setSelectedSpace(space)
    setFoundNotes(null)
    setCreatingNew(false)
    const answer = await anytype.listNotes(space.id)
    if (!answer.ok) return failed(answer)
    // The fullest list first: that is the one people mean.
    const notes = [...answer.notes].sort((a, b) => b.itemCount - a.itemCount)
    setFoundNotes(notes)
    setNoteId(notes[0]?.id ?? '')
    setBusy(false)
  }
  const finish = async () => {
    setChoosing(false)
    setSelectedSpace(null)
    setFoundNotes(null)
    setCreatingNew(false)
    await link.refresh()
    setBusy(false)
    await link.run()
  }
  /** Connects to a list in Anytype: loading it here unless asked to keep both. */
  const connect = async (note: FoundNote, mode: 'load' | 'merge') => {
    if (!selectedSpace) return
    setBusy(true)
    setProblem(null)
    resetAnytypeCache()
    const answer = await anytype.useSpace(selectedSpace.id, selectedSpace.name, note.id, note.name)
    if (!answer.ok) return failed(answer)
    setLoaded(null)
    if (mode === 'load') {
      const result = await loadFromAnytype()
      if (!result.ok) return failed(result)
      if (!result.empty) setLoaded({ count: result.loaded, before: result.before })
    }
    await finish()
  }
  const createNote = async (name: string) => {
    if (!selectedSpace) return
    setBusy(true)
    setProblem(null)
    resetAnytypeCache()
    const answer = await anytype.createNote(selectedSpace.id, name, selectedSpace.name)
    if (!answer.ok) return failed(answer)
    setLoaded(null)
    await finish()
  }
  const forget = async () => {
    setBusy(true)
    resetAnytypeCache()
    await anytype.forget()
    setChallenge(null)
    setSpaces(null)
    setSelectedSpace(null)
    setFoundNotes(null)
    setLoaded(null)
    await link.refresh()
    setBusy(false)
  }
  const takeBack = () => {
    if (!loaded) return
    importMerkliste(loaded.before)
    setLoaded(null)
  }
  const chooseAgain = () => {
    setProblem(null)
    setSpaces(null)
    setSelectedSpace(null)
    setFoundNotes(null)
    setChoosing(true)
  }

  // Spaces load by themselves once there is a key and none is chosen.
  const needsSpace = Boolean(status?.paired && (!status.space || choosing))
  useEffect(() => {
    if (needsSpace && spaces === null && !busy) void loadSpaces()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsSpace])

  const otherSpace =
    spaces && spaces.length > 1 ? (
      <button type="button" onClick={() => void loadSpaces()} disabled={busy} className={`${linkClass} text-small`}>
        Anderen Space wählen
      </button>
    ) : null

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
  } else if (needsSpace && selectedSpace) {
    const note = foundNotes?.find((entry) => entry.id === noteId) ?? foundNotes?.[0] ?? null
    if (foundNotes === null) {
      body = problem ? (
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-[8px]">
          <Button type="button" size="sm" variant="quiet" disabled={busy} onClick={() => void loadNotesForSpace(selectedSpace)}>
            Erneut suchen
          </Button>
          {otherSpace}
        </div>
      ) : (
        <p className="text-small text-prose">Sondra sucht in „{selectedSpace.name || 'Ohne Namen'}“ nach einer Merkliste …</p>
      )
    } else if (note) {
      body = (
        <div className="flex flex-col items-start gap-[16px]">
          <div className="flex flex-col gap-[6px]">
            <p className="text-body text-ink">
              In „{selectedSpace.name || 'Ohne Namen'}“ liegt schon eine Merkliste
              {foundNotes.length === 1 ? (
                <>
                  : <span className="font-semibold">„{note.name}“</span> mit {note.itemCount} {note.itemCount === 1 ? 'Serie' : 'Serien'}.
                </>
              ) : (
                '. Welche?'
              )}
            </p>
            {foundNotes.length > 1 ? (
              <ChoiceRow
                value={note.id}
                options={foundNotes.map((entry) => ({ value: entry.id, label: `${entry.name} · ${entry.itemCount}` }))}
                onChange={setNoteId}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-[18px] gap-y-[8px]">
            <Button type="button" size="sm" disabled={busy} onClick={() => void connect(note, 'load')}>
              Aus Anytype laden
            </Button>
            <button type="button" disabled={busy} onClick={() => void connect(note, 'merge')} className={`${linkClass} text-small`}>
              Nicht laden — beide Listen zusammenführen
            </button>
          </div>
          <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
            {count > 0
              ? `„Aus Anytype laden“ ersetzt die ${count} ${count === 1 ? 'Serie' : 'Serien'} auf diesem Gerät durch die Liste aus Anytype; danach lässt sich die bisherige wieder dazunehmen. „Zusammenführen“ behält beide.`
              : 'Auf diesem Gerät ist die Merkliste noch leer.'}
          </p>
          <div className="flex w-full flex-col items-start gap-[10px] border-t border-line pt-[14px]">
            {creatingNew ? (
              <div className="flex w-full flex-wrap items-center gap-[10px]">
                <TextInput
                  autoFocus
                  value={newNoteName}
                  onChange={(event) => setNewNoteName(event.target.value)}
                  aria-label="Name der neuen Notiz"
                  className="min-w-[200px] flex-1"
                />
                <Button type="button" size="sm" disabled={busy || !newNoteName.trim()} onClick={() => void createNote(newNoteName.trim())}>
                  Anlegen und verbinden
                </Button>
                <button type="button" onClick={() => setCreatingNew(false)} className={`${linkClass} text-small`}>
                  Abbrechen
                </button>
              </div>
            ) : (
              <p className="flex flex-wrap items-center gap-x-[18px] gap-y-[6px] text-small text-prose">
                <button type="button" disabled={busy} onClick={() => setCreatingNew(true)} className={linkClass}>
                  Eigene, neue Notiz anlegen
                </button>
                {otherSpace}
              </p>
            )}
          </div>
        </div>
      )
    } else {
      body = (
        <div className="flex flex-col items-start gap-[12px]">
          <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
            In „{selectedSpace.name || 'Ohne Namen'}“ gibt es noch keine Merkliste. Sondra legt die Seite „Sondra · Merkliste“ an
            {count > 0 ? ` — mit den ${count} ${count === 1 ? 'Serie' : 'Serien'} dieses Geräts` : ''}.
          </p>
          <div className="flex flex-wrap items-center gap-x-[18px] gap-y-[8px]">
            <Button type="button" size="sm" disabled={busy} onClick={() => void createNote('Sondra · Merkliste')}>
              Anlegen und verbinden
            </Button>
            {otherSpace}
          </div>
        </div>
      )
    }
  } else if (needsSpace) {
    body = (
      <div className="flex flex-col items-start gap-[12px]">
        <p className="text-small text-prose">In welchem Space soll die Merkliste liegen?</p>
        {spaces === null ? (
          problem ? (
            <Button type="button" size="sm" variant="quiet" disabled={busy} onClick={() => void loadSpaces()}>
              Spaces erneut laden
            </Button>
          ) : (
            <p className="text-small text-prose">Die Spaces werden geladen …</p>
          )
        ) : spaces.length === 0 ? (
          <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
            Anytype zeigt Sondra keinen Space. Legen Sie dort einen an — oder trennen Sie, verbinden Sie neu und geben Sie beim
            Bestätigen in Anytype einen Space frei.
          </p>
        ) : (
          <ChoiceRow value={pick} options={spaces.map((space) => ({ value: space.id, label: space.name || 'Ohne Namen' }))} onChange={setPick} />
        )}
        <div className="flex flex-wrap items-center gap-[12px]">
          {spaces && spaces.length > 0 ? (
            <Button
              type="button"
              size="sm"
              disabled={busy || !pick}
              onClick={() => {
                const space = spaces.find((entry) => entry.id === pick)
                if (space) void loadNotesForSpace(space)
              }}
            >
              Diesen Space nehmen
            </Button>
          ) : null}
          {choosing ? (
            <button type="button" onClick={() => setChoosing(false)} className={`${linkClass} text-small`}>
              Abbrechen
            </button>
          ) : null}
        </div>
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col items-start gap-[14px]">
        <p className="text-body text-prose">
          Verbunden mit „{status.space?.name || 'Ohne Namen'}“
          {status.note?.name ? ` · Notiz „${status.note.name}“` : ''}.
          <span className="text-muted">
            {' '}
            {link.sync.running ? 'Gleicht gerade ab …' : link.sync.at ? `Zuletzt abgeglichen um ${clock(link.sync.at)}.` : ''}
          </span>
        </p>
        {loaded ? (
          <p role="status" className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-small text-prose">
            <span>
              Aus Anytype geladen: {loaded.count} {loaded.count === 1 ? 'Serie' : 'Serien'}.
            </span>
            <button type="button" onClick={takeBack} className={`${linkClass} font-semibold`}>
              Bisherige Liste dieses Geräts dazunehmen
            </button>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-[8px]">
          <Button type="button" size="sm" disabled={link.sync.running} onClick={() => void link.run()}>
            Jetzt abgleichen
          </Button>
          <button type="button" onClick={chooseAgain} className={`${linkClass} text-small`}>
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
        <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
          Sondra legt die Merkliste als Seite in Anytype ab und gleicht sie bei jeder Änderung ab — so haben Sie sie auf allen
          Geräten, auch auf dem Handy. Covers aus Dateien bleiben auf diesem Rechner.
        </p>
        <div className="border-t border-line pt-[16px]">{body}</div>
        {problem ? (
          <Notice tone="error" title="Hat nicht geklappt">
            {problem.text}
            {problem.detail ? <span className="mt-[4px] block break-words text-micro text-muted">{problem.detail}</span> : null}
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
      const { result, before, saved } = importMerkliste(readMerklisteFile(await file.text()))
      if (!saved) {
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
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className={linkClass}
            title="Sondra JSON, MyAnimeList XML oder AniList JSON einlesen"
          >
            Aus Datei einlesen (JSON / MAL-XML)
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
              revertImport(done.before)
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
        accept=".json,.xml,application/json,text/xml,application/xml"
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
/** „Staffel 2 mit 12 Folgen“, „Staffel 1, Folgen 29–30“: what is new online, in words. */
function newsLabel(news: OnlineNews): string {
  if (news.newSeason) return `Staffel ${news.season} mit ${news.to} ${news.to === 1 ? 'Folge' : 'Folgen'}`
  if (news.countUnknown) return `Staffel ${news.season} hat ${news.to} Folgen`
  return `Staffel ${news.season}, ${news.from === news.to ? `Folge ${news.from}` : `Folgen ${news.from}–${news.to}`}`
}

function SeriesTile({
  item,
  onOpen,
  isFocused,
  onFocus,
}: {
  item: SavedLinkItem
  onOpen: () => void
  isFocused?: boolean
  onFocus?: (event: React.FocusEvent<HTMLDivElement>) => void
}) {
  const progress = itemProgress(item)
  const news = onlineNews(item)
  const cover = seriesCover(item)
  const [broken, setBroken] = useState<string | null>(null)
  const poster = cover && cover.src !== broken ? cover : null
  const count = seasonsOf(item).filter((season) => season.number > 0).length
  const done = caughtUp(seasonsOf(item))
  const stand = standLabel(item)
  const badge = item.url ? sourceBadgeForUrl(item.url) : null
  const canAdvance = !done && item.episode !== null

  return (
    <div
      tabIndex={0}
      onFocus={onFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onOpen()
        } else if ((e.key === '+' || e.key === ' ') && canAdvance) {
          e.preventDefault()
          markSeen(item)
        }
      }}
      className="group flex min-w-0 flex-col gap-[10px] rounded-card text-left outline-none"
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={onOpen}
        aria-label={`${item.title}: ${stand}, ${progress.total ? `${progress.watched} von ${progress.total} gesehen` : `${progress.watched} gesehen`}`}
        // The keyboard's place is a ring round the poster, as on the season
        // tiles — not round the whole column, and never after a click.
        className={`press relative block w-full overflow-hidden rounded-card text-left ${poster ? 'bg-stage' : 'bg-panel-mid'} ${
          isFocused ? 'ring-2 ring-ink ring-offset-2 ring-offset-canvas' : 'group-focus-visible:ring-2 group-focus-visible:ring-ink group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-canvas'
        }`}
        style={{ aspectRatio: ratioOf(item.tileFormat) }}
      >
        {poster ? (
          <CoverImage src={poster.src} frame={poster.frame} onError={() => setBroken(poster.src)} />
        ) : (
          <span className="absolute inset-0 transition-opacity duration-[var(--dur-base)] group-hover:opacity-0 group-focus-visible:opacity-0">
            <NamePoster title={item.title} />
          </span>
        )}
        
        {/* Rating badge top-right */}
        {item.rating ? (
          <span className="absolute top-[8px] right-[8px] z-10 flex items-center gap-[3px] rounded-pill bg-stage/85 px-[6px] py-[2px] text-micro font-semibold text-stage-ink backdrop-blur-xs ring-1 ring-inset ring-white/15">
            <span className="text-stage-accent">★</span>
            <span>{item.rating}</span>
          </span>
        ) : null}

        {/* Hover overlay */}
        <span
          aria-hidden
          className={`absolute inset-x-0 bottom-0 flex translate-y-[6px] flex-col gap-[4px] px-[12px] pb-[12px] pt-[52px] opacity-0 transition-[opacity,translate] duration-[var(--dur-base)] ease-[var(--ease-settle)] group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 ${
            poster ? 'bg-gradient-to-t from-stage/80 via-stage/45 to-transparent text-stage-ink' : 'text-ink'
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
          tabIndex={-1}
          onClick={onOpen}
          className="press truncate text-left text-body font-semibold leading-snug text-ink decoration-rule underline-offset-[3px] hover:underline"
          title={item.title}
        >
          {item.title}
        </button>
        <div className="flex items-center justify-between gap-[6px] text-small text-prose min-h-[22px]">
          <span className="flex items-center gap-[6px] min-w-0 truncate">
            {done ? <RowMark state="done" /> : null}
            <span className="truncate">{stand}</span>
          </span>
          {canAdvance ? (
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation()
                markSeen(item)
              }}
              title={`${hereLabel(item)} als gesehen markieren (+ oder Leertaste)`}
              className="press shrink-0 rounded-pill bg-panel-soft px-[8px] py-[1px] text-micro font-medium text-ink ring-1 ring-inset ring-line hover:bg-ink hover:text-on-ink hover:ring-ink"
            >
              +1
            </button>
          ) : null}
        </div>
        <ProgressBar fraction={progress.fraction ?? (progress.watched > 0 ? null : 0)} label={`${item.title}: gesehen`} />
        <div className="flex items-center justify-between gap-[4px] min-h-[1.25em] text-micro">
          <span className="text-muted font-mono truncate">{badge || '\u00A0'}</span>
          {news ? (
            <span
              className="shrink-0 flex items-center gap-[3px] font-sans font-medium text-accent-strong"
              title={`Neu auf AniWorld: ${newsLabel(news)}`}
            >
              <span className="size-[4px] rounded-full bg-accent-strong" />
              <span>Neu</span>
            </span>
          ) : item.tags && item.tags.length > 0 ? (
            <span className="text-muted/70 font-sans truncate">#{item.tags[0]}</span>
          ) : null}
        </div>
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
  const news = onlineNews(item)
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
  const setPanel = useSession((state) => state.setPanel)
  const [batchModalOpen, setBatchModalOpen] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  /** What a check asked for by hand found, when it found no new episode. */
  const [checkNote, setCheckNote] = useState<string | null>(null)

  // Automatic discreet AniWorld update check
  useEffect(() => {
    if (!item.url || !isAniworldUrl(item.url)) return
    const checked = item.onlineAvailable?.checkedAt ?? 0
    if (Date.now() - checked > 4 * 60 * 60 * 1000) {
      void checkOnlineUpdates(item)
    }
  }, [item.url, item.id])

  // Discord Rich Presence update when viewing series
  useEffect(() => {
    updateDiscordPresence({
      details: `Merkliste: ${item.title}`,
      state: item.season === 0 ? `Film ${item.episode ?? 1}` : `Staffel ${item.season} · Folge ${item.episode ?? 1}`,
      assets: {
        large_image: 'sondra',
        large_text: item.title,
      },
    })
    return () => {
      updateDiscordPresence(null)
    }
  }, [item.title, item.season, item.episode])

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true)
    setCheckNote(null)
    const info = await checkOnlineUpdates(item)
    setCheckingUpdates(false)
    // A new episode shows itself above; anything else is said here, or the
    // button looked as if it had done nothing.
    if (!info) setCheckNote('AniWorld war nicht zu erreichen. Später noch einmal.')
    else if (!info.hasNew) setCheckNote(`Nichts Neues: online bis Staffel ${info.maxSeason}, Folge ${info.maxEpisode}.`)
  }

  const activeSeason = seasons.find((s) => s.number === item.season) ?? seasons[0]

  return (
    <div className="flex flex-col gap-[32px]">
      {batchModalOpen && activeSeason ? (
        <BatchDownloadModal
          item={item}
          season={activeSeason}
          onClose={() => setBatchModalOpen(false)}
          onTransfer={(batch) => {
            setBatchModalOpen(false)
            requestBatchLookup(batch)
            setPanel('downloader')
          }}
        />
      ) : null}

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
            {item.tags && item.tags.length > 0 ? (
              <div className="flex flex-wrap items-center gap-[8px]">
                {item.tags.map((tag) => (
                  <span key={tag} className="text-micro font-sans font-medium text-muted">
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}

            {news ? (
              <div className="mt-[2px] flex flex-wrap items-center justify-between gap-[10px] rounded-card border border-line bg-panel-soft/60 px-[12px] py-[8px]">
                <div className="flex items-center gap-[8px] text-small text-ink">
                  <span className="size-[6px] shrink-0 rounded-full bg-accent-strong" />
                  <span>
                    Neu auf AniWorld: <strong>{newsLabel(news)}</strong>
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    const taken = takeOnlineNews(item)
                    if (taken) updateMerkItem(item.id, taken)
                  }}
                >
                  Auf die Merkliste nehmen
                </Button>
              </div>
            ) : null}

            <div className="mt-[4px] flex flex-wrap items-center gap-[8px]">
              {hasUrl && next ? (
                <Button type="button" size="sm" onClick={() => openHere(item)}>
                  {hereLabel(item)} laden
                </Button>
              ) : null}
              {hasUrl ? (
                <Button
                  type="button"
                  size="sm"
                  variant="quiet"
                  onClick={() => setBatchModalOpen(true)}
                  title="Nächste Folgen in den Downloader übertragen"
                >
                  Nächste Folgen laden …
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
              {hasUrl && isAniworldUrl(item.url) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="quiet"
                  disabled={checkingUpdates}
                  onClick={() => void handleCheckUpdates()}
                  title="Auf AniWorld nach neuen Staffeln oder Folgen suchen"
                >
                  {checkingUpdates ? 'Prüft…' : 'Online prüfen'}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="quiet" onClick={onEdit}>
                Bearbeiten
              </Button>
            </div>
            {checkNote ? (
              <p role="status" className="text-small text-prose">
                {checkNote}
              </p>
            ) : null}
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
    <Dialog open onClose={onClose} title={`${item.title} · ${name}`} size="lg">
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
            <div className="flex flex-wrap items-baseline gap-x-[10px] gap-y-[4px]">
              <h3 className="display-sm min-w-0 break-words">{item.title}</h3>
              {item.rating ? (
                <span className="flex items-center gap-[3px] text-small font-semibold text-ink">
                  <StarIcon filled className="size-[13px] text-ink" />
                  <span>{item.rating}</span>
                  <span className="sr-only"> von 5 Sternen</span>
                </span>
              ) : null}
            </div>
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
            <DiceIcon />
            <span>Anderen Vorschlag würfeln</span>
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

function WatchHistoryDialog({ items, onClose }: { items: SavedLinkItem[]; onClose: () => void }) {
  const history = useMemo(() => allHistory(items), [items])
  const [undoneId, setUndoneId] = useState<string | null>(null)

  const handleUndo = (itemId: string, entryId: string) => {
    undoWatchHistory(itemId, entryId)
    setUndoneId(entryId)
    setTimeout(() => setUndoneId(null), 2500)
  }

  const formatTimestamp = (timestamp: number) => {
    const d = new Date(timestamp)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    const time = d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
    if (isToday) return `Heute, ${time}`
    return `${d.toLocaleDateString('de-CH', { day: 'numeric', month: 'short' })}, ${time}`
  }

  return (
    <Dialog open onClose={onClose} title="Zuletzt geschaut (Verlauf)" size="md">
      <div className="flex flex-col gap-[14px] max-h-[65vh] overflow-y-auto pr-[4px]">
        {history.length === 0 ? (
          <p className="py-[32px] text-center text-small text-muted">
            Noch keine Folgen im Verlauf erfasst. Sobald Sie Folgen als gesehen markieren, erscheinen sie hier.
          </p>
        ) : (
          <div className="divide-y divide-line/40">
            {history.slice(0, 50).map(({ item, entry }) => (
              <div key={entry.id} className="flex items-center justify-between gap-[12px] py-[10px]">
                <div className="min-w-0 flex-1">
                  <p className="text-small font-semibold text-ink truncate">{item.title}</p>
                  <p className="text-micro text-muted">
                    {entry.season === 0 ? `Film ${entry.episode}` : `Staffel ${entry.season}, Folge ${entry.episode}`} ·{' '}
                    {formatTimestamp(entry.at)}
                  </p>
                </div>
                {undoneId === entry.id ? (
                  <span className="text-micro text-accent-strong font-medium">Zurückgesetzt</span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="quiet"
                    onClick={() => handleUndo(item.id, entry.id)}
                    title="Als ungesehen markieren"
                  >
                    Rückgängig
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mt-[16px] flex justify-end">
        <Button type="button" size="sm" onClick={onClose}>
          Schliessen
        </Button>
      </div>
    </Dialog>
  )
}

function BatchDownloadModal({
  item,
  season,
  onClose,
  onTransfer,
}: {
  item: SavedLinkItem
  season: MerkSeason
  onClose: () => void
  onTransfer: (batch: BatchLookupItem[]) => void
}) {
  const prog = seasonProgress(season)
  const currentEp = prog.next
  const total = season.episodes

  const openEpisodes: number[] = []
  if (total !== null) {
    for (let e = currentEp; e <= total; e++) {
      if (!season.watched.includes(e)) openEpisodes.push(e)
    }
  } else {
    for (let i = 0; i < 5; i++) {
      openEpisodes.push(currentEp + i)
    }
  }

  const prepareBatch = (count: number) => {
    const eps = openEpisodes.slice(0, count)
    const batch: BatchLookupItem[] = eps.map((ep) => ({
      url: buildUrlWithEpisode(item.url, season.number, ep),
      title: `${item.title} - S${season.number}E${ep}`,
      season: season.number,
      episode: ep,
    }))
    onTransfer(batch)
  }

  return (
    <Dialog open onClose={onClose} title="Nächste Folgen in den Downloader übertragen" size="md">
      <div className="flex flex-col gap-[12px]">
        <p className="text-small text-prose">
          Wählen Sie, wie viele Folgen von <strong>{item.title}</strong> (ab Folge {currentEp}) in die
          Download-Warteschlange übertragen werden sollen:
        </p>
        <div className="flex flex-col gap-[8px] pt-[8px]">
          <Button
            type="button"
            size="sm"
            variant="quiet"
            onClick={() => prepareBatch(1)}
            className="w-full justify-between"
          >
            <span>Nächste Folge ({season.number === 0 ? `Film ${currentEp}` : `Staffel ${season.number}, Folge ${currentEp}`})</span>
            <span className="text-micro text-muted">1 Folge</span>
          </Button>
          {openEpisodes.length >= 2 ? (
            <Button
              type="button"
              size="sm"
              variant="quiet"
              onClick={() => prepareBatch(3)}
              className="w-full justify-between"
            >
              <span>Nächste 3 Folgen ({currentEp}–{openEpisodes[Math.min(2, openEpisodes.length - 1)]})</span>
              <span className="text-micro text-muted">3 Folgen</span>
            </Button>
          ) : null}
          {openEpisodes.length >= 4 ? (
            <Button
              type="button"
              size="sm"
              variant="quiet"
              onClick={() => prepareBatch(5)}
              className="w-full justify-between"
            >
              <span>Nächste 5 Folgen ({currentEp}–{openEpisodes[Math.min(4, openEpisodes.length - 1)]})</span>
              <span className="text-micro text-muted">5 Folgen</span>
            </Button>
          ) : null}
          {openEpisodes.length > 1 ? (
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => prepareBatch(openEpisodes.length)}
              className="w-full justify-between"
            >
              <span>Alle offenen Folgen ({openEpisodes.length} {openEpisodes.length === 1 ? 'Folge' : 'Folgen'})</span>
              <span className="text-micro text-on-ink/80">{openEpisodes.length} Folgen</span>
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-[16px] flex justify-end">
        <Button type="button" size="sm" variant="quiet" onClick={onClose}>
          Abbrechen
        </Button>
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
    ctx.fillText(`Stand vom ${today}`, 40, 96)

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

      // The palette's greens, as in the window: ink, faint, rule.
      ctx.fillStyle = '#0b4a22'
      ctx.fillRect(barX, barY, wW, barH)
      ctx.fillStyle = '#799081'
      ctx.fillRect(barX + wW, barY, lW, barH)
      ctx.fillStyle = '#a7bca9'
      ctx.fillRect(barX + wW + lW, barY, dW, barH)
    }

    // Legend: the colour in the dot, the words in prose — light green text
    // on the paper would not be readable.
    ctx.font = '14px system-ui, sans-serif'
    const legend = (x: number, color: string, text: string) => {
      ctx.fillStyle = color
      ctx.fillText('●', x, 345)
      ctx.fillStyle = '#111a14'
      ctx.fillText(text, x + 18, 345)
    }
    legend(40, '#0b4a22', `Am Schauen: ${stats.watchingCount} (${stats.watchingPercent}%)`)
    legend(280, '#799081', `Später: ${stats.laterCount} (${stats.laterPercent}%)`)
    legend(460, '#a7bca9', `Fertig: ${stats.doneCount} (${stats.donePercent}%)`)

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
      `**Meine Sondra Merkliste**:`,
      `• ${stats.watchingCount} am Schauen · ${stats.laterCount} später · ${stats.doneCount} fertig (${stats.totalSeries} Serien)`,
      `• ${stats.seenTotal} Folgen gesehen (ca. ${stats.watchTime.short} / ${stats.watchTime.long} Sehzeit)`,
      stats.avgRating ? `• ⭐️ Durchschnittsbewertung: ★ ${stats.avgRating}` : null,
      stats.completedSeasons > 0 ? `• ${stats.completedSeasons} Staffeln komplett gesehen` : null,
      ``,
      `Erstellt mit Sondra (https://sondra.lizge.ch)`,
    ].filter(Boolean).join('\n')

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <Dialog open onClose={onClose} title="Statistiken zur Merkliste" size="lg">
      <div className="flex flex-col gap-[24px]">
        {/* 4 Hero Metric Cards - Wide, Clean & Modern */}
        <div className="grid grid-cols-2 gap-[12px] sm:grid-cols-4">
          <div className="flex flex-col justify-between rounded-card bg-panel-soft/80 p-[16px] ring-1 ring-inset ring-rule/40 transition-colors hover:bg-panel-soft">
            <div className="flex items-center justify-between text-small text-muted">
              <span>Gesehen</span>
              <span className="text-micro font-medium rounded-pill bg-raised px-[6px] py-[1px] text-ink ring-1 ring-inset ring-rule/40">
                {stats.overallProgressPercent !== null ? `${stats.overallProgressPercent}%` : 'Gesamt'}
              </span>
            </div>
            <div className="mt-[8px] flex items-baseline gap-[4px]">
              <span className="value pop text-headline font-bold text-ink">{stats.seenTotal}</span>
              <span className="text-small text-muted">{stats.seenTotal === 1 ? 'Folge' : 'Folgen'}</span>
            </div>
            <span className="mt-[4px] text-micro text-prose">
              {stats.knownTotalEpisodes > 0 ? `von ${stats.knownTotalEpisodes} erfassten Folgen` : 'über alle Serien'}
            </span>
          </div>

          <div className="flex flex-col justify-between rounded-card bg-panel-soft/80 p-[16px] ring-1 ring-inset ring-rule/40 transition-colors hover:bg-panel-soft">
            <div className="flex items-center justify-between text-small text-muted">
              <span>Sehzeit</span>
              <span className="text-micro font-medium rounded-pill bg-raised px-[6px] py-[1px] text-ink ring-1 ring-inset ring-rule/40">
                Laufzeit
              </span>
            </div>
            <div className="mt-[8px]">
              <span className="value pop text-headline font-bold text-ink">{stats.watchTime.short}</span>
            </div>
            <span className="mt-[4px] text-micro text-prose truncate" title={stats.watchTime.long}>
              {stats.watchTime.long}
            </span>
          </div>

          <div className="flex flex-col justify-between rounded-card bg-panel-soft/80 p-[16px] ring-1 ring-inset ring-rule/40 transition-colors hover:bg-panel-soft">
            <div className="flex items-center justify-between text-small text-muted">
              <span>Serien</span>
              <span className="text-micro font-medium rounded-pill bg-raised px-[6px] py-[1px] text-ink ring-1 ring-inset ring-rule/40">
                Katalog
              </span>
            </div>
            <div className="mt-[8px] flex items-baseline gap-[4px]">
              <span className="value pop text-headline font-bold text-ink">{stats.totalSeries}</span>
              <span className="text-small text-muted">{stats.totalSeries === 1 ? 'Serie' : 'Serien'}</span>
            </div>
            <span className="mt-[4px] text-micro text-prose">
              {stats.watchingCount} aktiv am Schauen
            </span>
          </div>

          <div className="flex flex-col justify-between rounded-card bg-panel-soft/80 p-[16px] ring-1 ring-inset ring-rule/40 transition-colors hover:bg-panel-soft">
            <div className="flex items-center justify-between text-small text-muted">
              <span>Bewertung</span>
              <span className="text-micro font-medium rounded-pill bg-raised px-[6px] py-[1px] text-ink ring-1 ring-inset ring-rule/40">
                Schnitt
              </span>
            </div>
            <div className="mt-[8px]">
              <span className="value pop text-headline font-bold text-ink">
                {stats.avgRating ? `★ ${stats.avgRating}` : '—'}
              </span>
            </div>
            <span className="mt-[4px] text-micro text-prose">
              {stats.ratedCount > 0 ? `${stats.ratedCount} bewertet` : 'Noch keine Bewertungen'}
            </span>
          </div>
        </div>

        {/* 2-Column Visual Dashboard: Left Visual Breakdown & Progress, Right Ratings & Activity */}
        <div className="grid grid-cols-1 gap-[20px] md:grid-cols-2">
          {/* Left Column: Visual Status Breakdown & Milestones */}
          <div className="flex flex-col gap-[18px] rounded-card bg-raised p-[18px] ring-1 ring-inset ring-rule/30">
            {/* Status Breakdown Section */}
            <div className="flex flex-col gap-[10px]">
              <div className="flex items-baseline justify-between text-small">
                <span className="font-semibold text-ink">Status-Verteilung</span>
                <span className="text-micro text-muted font-mono">{stats.totalSeries} {stats.totalSeries === 1 ? 'Serie' : 'Serien'}</span>
              </div>

              {/* Segmented Progress Bar */}
              {stats.totalSeries > 0 ? (
                <div className="flex h-[12px] w-full overflow-hidden rounded-full bg-rule/30 p-[1px]">
                  {stats.watchingCount > 0 ? (
                    <div
                      style={{ width: `${stats.watchingPercent}%` }}
                      className="h-full rounded-l-full bg-ink transition-all"
                      title={`${stats.watchingCount} am Schauen (${stats.watchingPercent}%)`}
                    />
                  ) : null}
                  {stats.laterCount > 0 ? (
                    <div
                      style={{ width: `${stats.laterPercent}%` }}
                      className="h-full bg-faint transition-all"
                      title={`${stats.laterCount} später (${stats.laterPercent}%)`}
                    />
                  ) : null}
                  {stats.doneCount > 0 ? (
                    <div
                      style={{ width: `${stats.donePercent}%` }}
                      className="h-full rounded-r-full bg-rule transition-all"
                      title={`${stats.doneCount} fertig (${stats.donePercent}%)`}
                    />
                  ) : null}
                </div>
              ) : null}

              {/* 3 Visual Metric Badges */}
              <div className="grid grid-cols-3 gap-[8px] pt-[2px]">
                <div className="flex flex-col rounded-nav bg-panel-soft/60 p-[8px] ring-1 ring-inset ring-rule/30 text-center">
                  <span className="flex items-center justify-center gap-[4px] text-micro font-medium text-ink">
                    <span className="size-[6px] rounded-full bg-ink inline-block" />
                    Am Schauen
                  </span>
                  <span className="value font-bold text-ink mt-[2px]">{stats.watchingCount}</span>
                  <span className="text-micro text-muted">{stats.watchingPercent}%</span>
                </div>
                <div className="flex flex-col rounded-nav bg-panel-soft/60 p-[8px] ring-1 ring-inset ring-rule/30 text-center">
                  <span className="flex items-center justify-center gap-[4px] text-micro font-medium text-ink">
                    <span className="size-[6px] rounded-full bg-faint inline-block" />
                    Später
                  </span>
                  <span className="value font-bold text-ink mt-[2px]">{stats.laterCount}</span>
                  <span className="text-micro text-muted">{stats.laterPercent}%</span>
                </div>
                <div className="flex flex-col rounded-nav bg-panel-soft/60 p-[8px] ring-1 ring-inset ring-rule/30 text-center">
                  <span className="flex items-center justify-center gap-[4px] text-micro font-medium text-ink">
                    <span className="size-[6px] rounded-full bg-rule inline-block" />
                    Fertig
                  </span>
                  <span className="value font-bold text-ink mt-[2px]">{stats.doneCount}</span>
                  <span className="text-micro text-muted">{stats.donePercent}%</span>
                </div>
              </div>
            </div>

            {/* Visual Milestones & Progress */}
            <div className="flex flex-col gap-[12px] border-t border-line/60 pt-[14px]">
              <span className="text-small font-semibold text-ink">Fortschritt & Meilensteine</span>

              {/* Overall Progress Bar */}
              <div className="flex flex-col gap-[4px]">
                <div className="flex items-center justify-between text-small">
                  <span className="text-prose">Gesamte Folgen</span>
                  <span className="value font-semibold text-ink">
                    {stats.overallProgressPercent !== null ? `${stats.overallProgressPercent} %` : '—'}
                  </span>
                </div>
                <div className="h-[8px] w-full overflow-hidden rounded-full bg-panel-mid">
                  <div
                    className="h-full rounded-full bg-ink transition-all"
                    style={{ width: `${stats.overallProgressPercent ?? 0}%` }}
                  />
                </div>
                <span className="text-micro text-muted">
                  {stats.seenTotal} von {stats.knownTotalEpisodes || stats.seenTotal} erfassten Folgen gesehen
                </span>
              </div>

              {/* Completed Seasons Bar */}
              <div className="flex flex-col gap-[4px]">
                <div className="flex items-center justify-between text-small">
                  <span className="text-prose">Staffeln komplett</span>
                  <span className="value font-semibold text-ink">
                    {stats.completedSeasons} von {stats.totalSeasons}
                  </span>
                </div>
                <div className="h-[8px] w-full overflow-hidden rounded-full bg-panel-mid">
                  <div
                    className="h-full rounded-full bg-ink transition-all"
                    style={{ width: `${stats.totalSeasons > 0 ? (stats.completedSeasons / stats.totalSeasons) * 100 : 0}%` }}
                  />
                </div>
                <span className="text-micro text-muted">
                  {stats.totalSeasons > 0 ? `${Math.round((stats.completedSeasons / stats.totalSeasons) * 100)} % aller Staffeln beendet` : 'Keine Staffeln'}
                </span>
              </div>

              {/* Films / Specials if any */}
              {stats.filmsSeen > 0 || stats.filmCount > 0 ? (
                <div className="flex items-center justify-between rounded-nav bg-panel-soft/40 px-[10px] py-[6px] text-small">
                  <span className="inline-flex items-center gap-[6px] text-prose"><SmallFilmIcon /> Filme & Specials</span>
                  <span className="value font-semibold text-ink">
                    {stats.filmsSeen} {stats.filmCount > 0 ? `von ${stats.filmCount} gesehen` : 'gesehen'}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Right Column: Visual Rating Chart & Recent Activity */}
          <div className="flex flex-col gap-[18px] rounded-card bg-raised p-[18px] ring-1 ring-inset ring-rule/30">
            {/* Ratings Histogram */}
            <div className="flex flex-col gap-[10px]">
              <div className="flex items-baseline justify-between text-small">
                <span className="font-semibold text-ink">Bewertungs-Verteilung</span>
                <span className="text-micro text-muted">
                  {stats.ratedCount > 0 ? `Schnitt: ★ ${stats.avgRating}` : 'Noch keine'}
                </span>
              </div>

              {stats.ratedCount > 0 ? (
                <div className="flex flex-col gap-[6px] pt-[2px]">
                  {stats.ratingDistribution.map(({ stars, count }) => {
                    const pct = stats.ratedCount > 0 ? Math.round((count / stats.ratedCount) * 100) : 0
                    return (
                      <div key={stars} className="flex items-center gap-[10px] text-small">
                        <span className="flex w-[38px] items-center justify-end gap-[3px] font-medium text-ink/80">{stars} <StarIcon filled className="size-[11px] text-ink" /></span>
                        <div className="h-[8px] flex-1 overflow-hidden rounded-full bg-panel-mid">
                          <div
                            className="h-full rounded-full bg-ink transition-all"
                            style={{ width: `${pct}%` }}
                            title={`${count} Serien (${pct}%)`}
                          />
                        </div>
                        <span className="value w-[28px] text-right font-medium text-ink">{count}</span>
                        <span className="w-[34px] text-right text-micro text-muted">{pct}%</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="flex h-[110px] items-center justify-center rounded-nav border border-dashed border-rule/60 text-small text-muted">
                  Bisher wurden noch keine Serien bewertet.
                </div>
              )}
            </div>

            {/* Recent Activity List with Visual Progress */}
            {stats.recentItems.length > 0 ? (
              <div className="flex flex-col gap-[10px] border-t border-line/60 pt-[14px]">
                <span className="text-small font-semibold text-ink">Zuletzt aktiv geschaut</span>
                <div className="flex flex-col gap-[8px]">
                  {stats.recentItems.slice(0, 4).map((item) => {
                    const prog = itemProgress(item)
                    const percent = prog.total ? Math.min(100, Math.round((prog.watched / prog.total) * 100)) : null
                    return (
                      <div key={item.id} className="flex flex-col gap-[3px] rounded-nav bg-panel-soft/40 p-[8px] ring-1 ring-inset ring-rule/20">
                        <div className="flex items-baseline justify-between gap-[8px]">
                          <span className="text-small font-medium text-ink truncate">{item.title}</span>
                          <span className="text-micro font-mono text-muted shrink-0">
                            {prog.watched} {prog.total ? `/ ${prog.total}` : 'gesehen'}
                          </span>
                        </div>
                        {prog.total ? (
                          <div className="h-[4px] w-full overflow-hidden rounded-full bg-rule/30">
                            <div className="h-full bg-ink" style={{ width: `${percent}%` }} />
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Export & Actions Footer */}
        <div className="flex flex-wrap items-center justify-between gap-[12px] border-t border-line pt-[16px]">
          <div className="flex flex-wrap items-center gap-[8px]">
            <Button type="button" size="sm" variant="quiet" onClick={exportImage} title="Statistiken als PNG-Grafik speichern" className="inline-flex items-center gap-[6px]">
              <ImageIcon />
              <span>Als Bild speichern</span>
            </Button>
            <Button type="button" size="sm" variant="quiet" onClick={copySummary} title="Zusammenfassung als Text kopieren" className="inline-flex items-center gap-[6px]">
              {copied ? <CheckIcon /> : <ClipboardIcon />}
              <span>{copied ? 'Kopiert!' : 'Text kopieren'}</span>
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
/**
 * A field or a row of choices under its name. Named as a group, so a screen
 * reader says the name on reaching what is inside — the span alone named
 * nothing, and every field in these dialogs was read out blank.
 */
function Group({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className={`flex min-w-0 flex-col gap-[6px] ${className}`}>
      <span id={id} className="text-small text-prose">
        {label}
      </span>
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
  stacked = false,
}: {
  value: string | undefined
  frame?: CoverFrame
  format?: TileFormat
  onChange: (value: string | undefined, frame: CoverFrame | undefined) => void
  onFormat: (format: TileFormat) => void
  stacked?: boolean
}) {
  return (
    <div className="flex flex-col gap-[10px] w-full">
      <div className="flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[6px]">
        <span className="text-small font-semibold text-ink">Cover & Format</span>
        <FormatChoice value={format} onChange={onFormat} />
      </div>
      <CoverField label="" value={value} frame={frame} format={format} onChange={onChange} stacked={stacked} />
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
      <div className={`grid gap-x-[20px] gap-y-[14px] ${hasFilms ? 'sm:grid-cols-2' : 'grid-cols-1'}`}>
        <Group label="Standard-Episodendauer">
          <div className="flex flex-wrap items-center justify-between gap-[10px]">
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
                className="w-[84px] font-sans"
              />
              <span className="text-small text-muted">Minuten pro Folge</span>
            </div>
            <div className="flex flex-wrap items-center gap-[6px]">
              <span className="text-micro text-muted">Schnellwahl:</span>
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
            <div className="flex flex-wrap items-center justify-between gap-[10px]">
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
                  className="w-[84px] font-sans"
                />
                <span className="text-small text-muted">Minuten pro Film</span>
              </div>
              <div className="flex flex-wrap items-center gap-[6px]">
                <span className="text-micro text-muted">Schnellwahl:</span>
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
  // The field keeps what was typed; only the tags read from it are stored.
  // Rebuilt from the stored tags, a comma vanished the moment it was typed,
  // and „Anime, Klassiker“ became the one tag „AnimeKlassiker“.
  const [tagText, setTagText] = useState(() => (item.tags ?? []).join(', '))
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
    <Dialog open onClose={onClose} title={item.title || 'Ohne Namen'} size="lg">
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-[24px]">
        {/* Linke Spalte: Cover, Format, Status, Bewertung & Aktionen */}
        <div className="flex flex-col gap-[18px] border-b md:border-b-0 md:border-r border-line pb-[18px] md:pb-0 md:pr-[24px]">
          <CoverWithFormat
            value={item.cover}
            frame={item.coverFrame}
            format={item.tileFormat}
            onChange={(cover, coverFrame) => update({ cover, coverFrame })}
            onFormat={(format) => update({ tileFormat: format === 'manga' ? 'manga' : undefined })}
            stacked={true}
          />

          <div className="flex flex-col gap-[14px] border-t border-line pt-[16px]">
            <Group label="Stand">
              <ChoiceRow value={statusOf(item)} options={STATUS_OPTIONS} onChange={(status) => update({ status })} />
            </Group>

            <Group label="Bewertung">
              <Rating value={item.rating ?? 0} onChange={(rating) => update({ rating })} />
            </Group>

            <div className="pt-[10px] border-t border-line/50">
              <button
                type="button"
                onClick={onRemove}
                className="press inline-flex items-center gap-[6px] rounded-nav text-small font-semibold text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
              >
                Von der Merkliste nehmen
              </button>
            </div>
          </div>
        </div>

        {/* Rechte Spalte: Stammdaten, Notizen, Staffeln, Zeiten & Download */}
        <div className="flex flex-col gap-[18px] min-w-0">
          <Group label="Name der Serie">
            <TextInput value={item.title} onChange={(event) => update({ title: event.target.value })} className="font-sans" />
          </Group>

          <Group label="Notiz">
            <textarea
              value={item.notes ?? ''}
              rows={2}
              onChange={(event) => update({ notes: event.target.value || undefined })}
              placeholder="Wo es spannend wurde, mit wem Sie schauen …"
              className={textAreaClass}
            />
          </Group>

          <Group label="Tags (durch Komma getrennt)">
            <TextInput
              value={tagText}
              aria-label="Tags, durch Komma getrennt"
              placeholder="Anime, Favorit, Manga …"
              onChange={(event) => {
                setTagText(event.target.value)
                update({
                  tags: event.target.value
                    .split(',')
                    .map((t) => t.trim().replace(/^#+/, ''))
                    .filter(Boolean),
                })
              }}
              className="font-sans"
            />
          </Group>

          <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[6px] border-b border-line pb-[10px]">
            <span className="text-small font-semibold text-ink">
              {seasonCount} {seasonCount === 1 ? 'Staffel' : 'Staffeln'}{hasFilms ? ', dazu Filme' : ''}
            </span>
            <span className="flex flex-wrap gap-x-[16px] gap-y-[4px] text-small">
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
          </div>

          {/* Dauer & Ausnahmen Karte */}
          <div className="rounded-card border border-line bg-panel-soft/40 p-[14px]">
            <div className="mb-[10px] flex items-center justify-between">
              <span className="text-small font-semibold text-ink">Episodendauer</span>
              <span className="text-micro text-muted">Standard: {item.episodeDuration ?? 24} Min.</span>
            </div>
            <DurationSettings item={item} update={update} />
          </div>

          {/* Herunterladen Einstellungen */}
          <Reveal label={host ? `Herunterladen · ${host}` : 'Herunterladen: Adresse und Einstellungen'} className="-mb-[4px]">
            <div className="grid gap-x-[20px] gap-y-[14px] pt-[10px] sm:grid-cols-2">
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
              <div className="self-end sm:col-span-2">
                <Toggle
                  label="Untertitel dazu erstellen"
                  hint="Whisper schreibt nach dem Laden auf diesem Gerät mit."
                  checked={item.autoTranscribe}
                  onChange={(autoTranscribe) => update({ autoTranscribe })}
                />
              </div>
            </div>
          </Reveal>

          <div className="flex items-center justify-end border-t border-line pt-[14px]">
            <Button type="button" size="sm" onClick={onClose}>
              Fertig
            </Button>
          </div>
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
  const [status, setStatus] = useState<SavedLinkStatus>('watching')
  const [seasonCount, setSeasonCount] = useState(1)
  const [typedCounts, setTypedCounts] = useState<(number | undefined)[]>([])
  const [countsUnknown, setCountsUnknown] = useState(false)
  const [films, setFilms] = useState(0)
  const [atSeason, setAtSeason] = useState(1)
  const [atEpisode, setAtEpisode] = useState(1)
  const [cover, setCover] = useState<string | undefined>(undefined)
  const [coverFrame, setCoverFrame] = useState<CoverFrame | undefined>(undefined)
  const [format, setFormat] = useState<TileFormat>('poster')
  const [tags, setTags] = useState('')

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
    setStatus('watching')
    setSeasonCount(1)
    setTypedCounts([])
    setCountsUnknown(false)
    setFilms(0)
    setAtSeason(1)
    setAtEpisode(1)
    setCover(undefined)
    setCoverFrame(undefined)
    setFormat('poster')
    setTags('')
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
    const cleanTags = tags
      .split(',')
      .map((t) => t.trim().replace(/^#+/, ''))
      .filter(Boolean)
    const item = createMerkItem({
      title: title.trim() || undefined,
      url: address ? buildUrlWithEpisode(address, position, episode) : '',
      season: position,
      episode,
      seasons,
      cover,
      coverFrame,
      ...(format === 'manga' ? { tileFormat: format } : {}),
      status,
      ...(cleanTags.length > 0 ? { tags: cleanTags } : {}),
    })
    setMerkItems((current) => [item, ...current])
    reset()
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Serie hinzufügen" size="lg">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (title.trim() || url.trim()) save()
        }}
      >
        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-[24px]">
          {/* Linke Spalte: Cover, Format & Start-Status */}
          <div className="flex flex-col gap-[18px] border-b md:border-b-0 md:border-r border-line pb-[18px] md:pb-0 md:pr-[24px]">
            <CoverWithFormat
              value={cover}
              frame={coverFrame}
              format={format}
              onChange={(picture, frame) => {
                setCover(picture)
                setCoverFrame(frame)
              }}
              onFormat={setFormat}
              stacked={true}
            />

            <div className="flex flex-col gap-[14px] border-t border-line pt-[16px]">
              <Group label="Start-Status">
                <ChoiceRow value={status} options={STATUS_OPTIONS} onChange={(nextStatus) => setStatus(nextStatus)} />
              </Group>

              <Group label="Filme dazu">
                <Stepper label="Anzahl Filme" value={films} min={0} max={200} onChange={setFilms} />
              </Group>
            </div>
          </div>

          {/* Rechte Spalte: Titel, Adresse, Staffeln & Fortschritt */}
          <div className="flex flex-col gap-[18px] min-w-0">
            <Group label="Name der Serie">
              <TextInput
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Wie die Serie heisst"
                className="font-sans"
              />
            </Group>

            <Group label="Web- / Stream-Adresse (zum Laden & Schnellstart)">
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
                  <span className="text-micro font-medium text-ink">
                    Erkannt: {badge ? `[${badge}] ` : ''}{derived ? `„${derived}“ · ` : ''}
                    {info.isEpisodicUrl ? `Staffel ${info.season}, Folge ${info.episode ?? 'alle'}` : ''}
                  </span>
                )
              })() : null}
            </Group>

            <Group label="Tags (durch Komma getrennt)">
              <TextInput
                value={tags}
                aria-label="Tags, durch Komma getrennt"
                onChange={(event) => setTags(event.target.value)}
                placeholder="Anime, Favorit, Manga …"
                className="font-sans"
              />
            </Group>

            {/* Staffel- & Episoden-Struktur */}
            <div className="rounded-card border border-line bg-panel-soft/40 p-[14px] flex flex-col gap-[12px]">
              <span className="text-small font-semibold text-ink">Staffeln & Episoden</span>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-[18px] gap-y-[12px]">
                <Group label="Staffeln">
                  <Stepper label="Anzahl Staffeln" value={seasonCount} max={60} onChange={setSeasonCount} />
                </Group>
                {seasonCount === 1 ? (
                  <Group label="Folgen">
                    <span className="flex flex-wrap items-center gap-[10px]">
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
                <Group label="Folgen je Staffel">
                  {countsUnknown ? null : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-[14px] gap-y-[8px]">
                      {counts.map((count, i) => (
                        <span key={i} className="flex items-center justify-between gap-[8px] text-small text-prose">
                          Staffel {i + 1}
                          <Stepper label={`Folgen in Staffel ${i + 1}`} value={count} max={2000} onChange={(value) => setCount(i, value)} />
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="w-max mt-[4px]">
                    <Toggle label="Noch unbekannt" checked={countsUnknown} onChange={setCountsUnknown} />
                  </span>
                </Group>
              ) : null}

              <div className="border-t border-line/60 pt-[10px]">
                <Group label="Gerade bei (was davor liegt, gilt als gesehen)">
                  <span className="flex flex-wrap items-center gap-[12px] text-small text-prose">
                    <span className="flex items-center gap-[6px]">
                      Staffel <Stepper label="Gerade bei Staffel" value={position} max={seasonCount} onChange={setAtSeason} />
                    </span>
                    <span className="flex items-center gap-[6px]">
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
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-[8px] border-t border-line pt-[14px]">
              <Button type="button" size="sm" variant="quiet" onClick={onClose}>
                Abbrechen
              </Button>
              <Button type="submit" size="sm" disabled={!title.trim() && !url.trim()}>
                Auf die Merkliste
              </Button>
            </div>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
