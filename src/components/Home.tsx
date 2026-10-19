/**
 * The start screen: a way in, three featured jobs, and every capability as a tile.
 *
 * Flat surfaces, no glow, no shadow — strictly following DESIGN.md („Das ruhige Blatt"):
 * 1. The way in: two side-by-side blocks on `bg-panel-soft` — the headline with
 *    the local-privacy badge on the left, and the dashed drop zone with the two
 *    entry actions on the right. With an active file, it names the file and
 *    offers the tools that fit it.
 * 2. The filter bar: group pills on the left, search pill on the right.
 * 3. The tools: three featured horizontal cards (`Ton schneiden`,
 *    `Rauschen entfernen`, `Gesprochenes als Text`) with flat vector graphics,
 *    followed by the 5-column grid of all remaining tools.
 * 4. The Windows app block at the foot (web only).
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/shallow'

import { useFilePicker, useIngestFiles } from '../hooks/useIngest'
import { ACTIONS, GROUP_LABEL, actionsFor, searchActions, type ToolAction, type ToolGroup } from '../lib/actions'
import { IN_DESKTOP_APP } from '../lib/desktop'
import { formatBytes, formatDuration } from '../lib/format'
import { KIND_LABEL, useActiveAsset, useSession, type PanelId } from '../state/store'
import { openGetAppDialog } from './GetApp'
import { PANELS, ToolIcon } from './panelMeta'
import { ArrowRight, Button } from './ui/primitives'

/* -------------------------------------------------------------------------- */

/** A tile borrows the icon of the tool it opens, unless it has its own below. */
const ICONS: Record<PanelId, ReactNode> = Object.fromEntries(
  PANELS.map((panel) => [panel.id, panel.icon]),
) as Record<PanelId, ReactNode>

/**
 * The sound editor's jobs, each with its own mark. Borrowing the editor's
 * icon put the same wave on thirteen tiles, and a field of identical marks
 * reads as no marks at all.
 */
const ACTION_ICONS: Partial<Record<string, ReactNode>> = {
  'audio-cut': <path d="M5 3.4v9.2M11 3.4v9.2M1.8 8h1.6M12.6 8h1.6M6.6 8l.8-2.4 1.2 4.8.8-2.4" />,
  'audio-fade': <path d="M1.8 12.4L5.6 3.6h4.8l3.8 8.8M1.8 12.4h12.4" />,
  'audio-gain': <path d="M3 12.6v-1.8M6 12.6V8.6M9 12.6V6.2M12 12.6V3.6" />,
  'audio-silence': <path d="M1.6 8h.8l.9-2.8.9 5.6.9-2.8h4.6l.9-2.8.9 5.6.9-2.8h.8" />,
  'audio-clipboard': <path d="M5.6 5.6h7v7h-7zM3.4 10.4v-7h7" />,
  'audio-filter': <path d="M1.8 10.6c1.6 0 2-5.2 3.6-5.2s2 6.2 3.6 6.2 2.2-3.8 5.2-3.8" />,
  'audio-noise': <path d="M1.8 8h1.6l1-2.6 1.4 5.2 1-2.6h1.4M10.6 5.2v.01M12.8 7.2v.01M10.8 10.4v.01M13.2 11.6v.01M12.4 3.8v.01" />,
  'audio-dynamics': <path d="M3.4 8h.01M6 5.6a3.4 3.4 0 010 4.8M8.6 3.6a6.2 6.2 0 010 8.8M11.2 1.8a8.8 8.8 0 010 12.4" />,
  'audio-reverse': <path d="M13.6 4.8H2.6m0 0l2-2m-2 2l2 2M2.6 11.2h1.6l.9-1.8 1.4 3.6 1.4-3.6.9 1.8h4.8" />,
  'audio-join': <path d="M1.8 5.2h4.4v5.6H1.8zM9.8 5.2h4.4v5.6H9.8zM6.2 8h3.6" />,
  'audio-pitch': <path d="M2 12.8h3V9.6h3V6.4h3V3.2h3" />,
  'audio-tempo': <path d="M5.4 13.2L7 2.8h2l1.6 10.4zM4.4 13.2h7.2M8 10.2l3.4-5.2" />,
  'audio-shape': <path d="M9.4 8a3.6 3.6 0 11-7.2 0 3.6 3.6 0 017.2 0zM13.8 8a3.6 3.6 0 11-7.2 0 3.6 3.6 0 017.2 0z" />,
}

const iconFor = (action: ToolAction): ReactNode => ACTION_ICONS[action.id] ?? ICONS[action.panel]

/** The groups a visitor filters by. „Hereinholen" is the way in above. */
const FILTERS: ToolGroup[] = ['ton', 'video', 'bild', 'musik']

/** The three featured cards shown in the top row. */
const FEATURED_IDS = ['audio-cut', 'audio-noise', 'transcript'] as const

/** Priority ordering for the compact 5-column grid directly below the featured row. */
const PRIORITY_GRID_IDS = [
  'mic-test',
  'mix-duck',
  'convert-audio',
  'audio-gain',
  'audio-silence',
  'audio-clipboard',
  'audio-filter',
  'audio-dynamics',
  'audio-fade',
  'audio-reverse',
]

/* -- featured card illustrations (flat, no glow, DESIGN.md compliant) ------ */

const WAVE_BARS_LEFT = [5, 9, 4, 12, 7, 14, 6, 10, 5, 11, 7, 13, 5, 8, 6, 10]
const WAVE_BARS_SELECTED = [9, 15, 11, 17, 13, 16, 8, 14, 17, 10, 15, 12, 16, 9]
const WAVE_BARS_RIGHT = [10, 6, 12, 5, 9, 13, 7, 4, 10, 6, 11, 5, 8, 12, 6, 5]

function CutIllustration() {
  return (
    <svg viewBox="0 0 64 64" className="h-[64px] w-[64px] shrink-0 text-ink" fill="none" aria-hidden>
      {/* Flat horizontal waveform behind the blades */}
      <path
        d="M4 32h7l2.5-6 3 12 2.5-6h6M39 32h6l2.5-5 3 10 2.5-5h7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="opacity-45"
      />
      {/* Flat geometric scissors */}
      <path
        d="M22 12L38 36M42 12L26 36"
        stroke="currentColor"
        strokeWidth="4.2"
        strokeLinecap="round"
      />
      <circle cx="21" cy="44" r="7.5" stroke="currentColor" strokeWidth="3.8" />
      <circle cx="43" cy="44" r="7.5" stroke="currentColor" strokeWidth="3.8" />
      <circle cx="32" cy="27" r="2" fill="currentColor" />
    </svg>
  )
}

function CutWaveformStrip() {
  return (
    <div
      aria-hidden
      className="mt-[6px] flex h-[28px] w-full items-center justify-between gap-[3px] rounded-nav bg-panel-soft px-[8px] ring-1 ring-inset ring-line"
    >
      <div className="flex flex-1 items-center justify-between gap-[2px]">
        {WAVE_BARS_LEFT.map((h, i) => (
          <span
            key={`l-${i}`}
            className="w-[2px] rounded-pill bg-faint opacity-65"
            style={{ height: `${h}px` }}
          />
        ))}
      </div>
      <div className="flex h-[22px] items-center gap-[2.5px] rounded-[4px] bg-panel-strong px-[6px] ring-1 ring-inset ring-ink">
        {WAVE_BARS_SELECTED.map((h, i) => (
          <span
            key={`s-${i}`}
            className="w-[2px] rounded-pill bg-ink"
            style={{ height: `${h}px` }}
          />
        ))}
      </div>
      <div className="flex flex-1 items-center justify-between gap-[2px]">
        {WAVE_BARS_RIGHT.map((h, i) => (
          <span
            key={`r-${i}`}
            className="w-[2px] rounded-pill bg-faint opacity-65"
            style={{ height: `${h}px` }}
          />
        ))}
      </div>
    </div>
  )
}

function NoiseIllustration() {
  return (
    <svg viewBox="0 0 64 64" className="h-[64px] w-[64px] shrink-0 text-ink" fill="none" aria-hidden>
      {/* Four-point flat star marks (cleaned signal) */}
      <path
        d="M24 12l2.4 6.6L33 21l-6.6 2.4L24 30l-2.4-6.6L15 21l6.6-2.4L24 12z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="M44 10l1.4 3.8L49 15.2l-3.6 1.4L44 20.4l-1.4-3.8L39 15.2l3.6-1.4L44 10z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="14" cy="31" r="1.6" fill="currentColor" />
      <circle cx="48" cy="27" r="1.6" fill="currentColor" />
      {/* Smooth double wave below */}
      <path
        d="M8 42c5.5 0 5.5-7 11-7s5.5 7 11 7 5.5-7 11-7 5.5 7 11 7 5.5-4 8-4"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
      <path
        d="M12 50c5 0 5-5 10-5s5 5 10 5 5-5 10-5 5 5 10 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="opacity-55"
      />
    </svg>
  )
}

function TranscriptIllustration() {
  return (
    <svg viewBox="0 0 64 64" className="h-[64px] w-[64px] shrink-0 text-ink" fill="none" aria-hidden>
      <rect
        x="6"
        y="10"
        width="52"
        height="44"
        rx="8"
        className="fill-panel-soft stroke-rule"
        strokeWidth="2"
      />
      {/* T | cursor and lines */}
      <path
        d="M15 21h9M19.5 21v11M28 19v15"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <rect x="34" y="21" width="15" height="3" rx="1.5" fill="currentColor" className="opacity-55" />
      <rect x="34" y="28" width="11" height="3" rx="1.5" fill="currentColor" className="opacity-55" />
      <rect x="15" y="39" width="22" height="3.2" rx="1.6" fill="currentColor" />
      <rect x="40" y="39" width="9" height="3.2" rx="1.6" fill="currentColor" className="opacity-45" />
      <rect x="15" y="45.5" width="13" height="3.2" rx="1.6" fill="currentColor" className="opacity-55" />
      <rect x="31" y="45.5" width="16" height="3.2" rx="1.6" fill="currentColor" />
    </svg>
  )
}

function FeaturedTool({
  action,
  dimmed,
  onClick,
}: {
  action: ToolAction
  dimmed: boolean
  onClick: () => void
}) {
  const illustration =
    action.id === 'audio-cut' ? (
      <CutIllustration />
    ) : action.id === 'audio-noise' ? (
      <NoiseIllustration />
    ) : (
      <TranscriptIllustration />
    )

  return (
    <button
      id={`v-${action.id}`}
      type="button"
      onClick={onClick}
      className={`press group flex scroll-mt-[120px] items-center gap-[16px] rounded-card bg-panel-mid p-[18px] text-left ring-1 ring-inset ring-line transition-colors duration-[var(--dur-fast)] hover:bg-panel-strong sm:p-[20px] ${
        dimmed ? 'opacity-75' : ''
      }`}
    >
      {illustration}
      <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
        <span className="text-body font-bold leading-[1.25] text-ink">{action.label}</span>
        <span className="text-small leading-[1.45] text-prose">{action.hint}</span>
        {action.id === 'audio-cut' ? <CutWaveformStrip /> : null}
      </div>
    </button>
  )
}

/**
 * One tool, as a tile.
 *
 * A tint gives the tile its edge, the radius makes it an object you can press
 * rather than a cell of a table. The icon sits beside the label instead of
 * stacked above it: a column of icon, label, hint made thirty tiles thirty
 * little posters.
 *
 * The hint is `prose`, not `muted`: on this tint `muted` measured APCA Lc 59.3
 * in the dark theme against a floor of 60.
 */
function Tool({
  action,
  dimmed,
  onClick,
}: {
  action: ToolAction
  dimmed: boolean
  onClick: () => void
}) {
  return (
    <button
      id={`v-${action.id}`}
      type="button"
      onClick={onClick}
      className="press group flex scroll-mt-[120px] flex-col gap-[8px] rounded-card bg-panel-mid p-[14px] text-left ring-1 ring-inset ring-line transition-colors duration-[var(--dur-fast)] hover:bg-panel-strong"
    >
      <span className="flex items-center gap-[8px]">
        {/* A tool that needs a kind of file the session does not hold says so
            through its icon only; fading the whole tile cost legibility. */}
        {/* The icon sits on its own small field, which takes the ink when the
            tile is pointed at — the one moment a tile spends ink. */}
        <span
          className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-nav bg-raised transition-colors duration-[var(--dur-fast)] ${
            dimmed ? 'text-faint' : 'text-ink group-hover:bg-ink group-hover:text-on-ink'
          }`}
        >
          <ToolIcon>{iconFor(action)}</ToolIcon>
        </span>
        <span className="text-small font-semibold leading-[1.25] text-ink">{action.label}</span>
      </span>
      <span className="text-small leading-[1.4] text-prose">{action.hint}</span>
    </button>
  )
}

function Grid({ children }: { children: ReactNode }) {
  // More desk means more tiles visible at once, not wider ones.
  return <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{children}</div>
}

/* -- the way in ------------------------------------------------------------- */

function UploadTrayIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[32px] w-[32px] text-ink" fill="none" aria-hidden>
      <path
        d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9M4.5 15v3a2 2 0 002 2h11a2 2 0 002-2v-3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-[15px] w-[15px] shrink-0 text-ink" fill="none" aria-hidden>
      <path
        d="M8 1.8L2.8 4v3.8c0 3.4 2.2 5.5 5.2 6.4 3-.9 5.2-3 5.2-6.4V4L8 1.8z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M5.7 8.1l1.6 1.6 3.1-3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Without a file: the dashed drop target with the two entry buttons inside it.
 * Flat surface, no glow, following DESIGN.md.
 */
function WayIn({ onOpen, busy }: { onOpen: () => void; busy: boolean }) {
  const setPanel = useSession((state) => state.setPanel)
  const { ingest } = useIngestFiles()
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    let depth = 0
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth += 1
      setDragging(true)
    }
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDropWindow = () => {
      depth = 0
      setDragging(false)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDropWindow)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDropWindow)
    }
  }, [])

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
        if (event.dataTransfer.files.length) void ingest(event.dataTransfer.files, 'hierher gezogen')
      }}
      className={`flex rounded-card p-[8px] transition-colors duration-[var(--dur-fast)] ${
        dragging ? 'bg-panel-mid ring-2 ring-inset ring-ink' : 'bg-panel-soft ring-1 ring-inset ring-line'
      }`}
    >
      <div
        className={`flex flex-1 flex-col items-center justify-center gap-[10px] rounded-[12px] border border-dashed px-[20px] py-[22px] text-center transition-colors sm:px-[28px] sm:py-[26px] ${
          dragging ? 'border-ink bg-raised/60' : 'border-rule'
        }`}
      >
        <UploadTrayIcon />
        <p className="display-sm">{dragging ? 'Loslassen zum Öffnen' : 'Datei hierher ziehen'}</p>
        <div className="mt-[4px] flex flex-wrap items-center justify-center gap-[8px]">
          <Button size="sm" onClick={onOpen} disabled={busy} className="px-[16px] py-[9px] font-semibold">
            {busy ? 'Wird gelesen…' : 'Datei auswählen'}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setPanel('downloader')}
            className="px-[16px] py-[9px]"
          >
            Von Adresse laden
          </Button>
        </div>
      </div>
    </div>
  )
}

/** With a file: what it is, and the tools that fit it. */
function FileCard({ onOpen }: { onOpen: () => void }) {
  const active = useActiveAsset()
  const setPanel = useSession((state) => state.setPanel)
  if (!active) return null
  // The first four that fit, in the order the list is kept in — the common
  // jobs come first there.
  const fits = actionsFor(active.kind).slice(0, 4)

  return (
    <div className="flex flex-col gap-[12px] rounded-card bg-panel-soft p-[16px] ring-1 ring-inset ring-line sm:p-[20px]">
      <p className="text-small text-prose">Weiter mit</p>
      {fits.length > 0 ? (
        <div className="grid gap-[8px] sm:grid-cols-2">
          {fits.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => setPanel(action.panel)}
              className="press flex items-center justify-between gap-[8px] rounded-nav bg-raised px-[14px] py-[12px] text-left text-small font-medium text-ink ring-1 ring-inset ring-line hover:ring-ink"
            >
              <span className="flex min-w-0 items-center gap-[8px]">
                <ToolIcon>{iconFor(action)}</ToolIcon>
                <span className="truncate">{action.label}</span>
              </span>
              <ArrowRight />
            </button>
          ))}
        </div>
      ) : (
        <p className="text-small text-prose">
          Für {KIND_LABEL[active.kind]}-Dateien gibt es hier noch kein Werkzeug. Speichern geht
          über das Dateimenü oben.
        </p>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="press self-start text-small text-ink underline underline-offset-[3px] hover:no-underline"
      >
        Andere Datei öffnen
      </button>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

export function Home() {
  const setPanel = useSession((state) => state.setPanel)
  const active = useActiveAsset()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ToolGroup | 'alle'>('alle')
  const picker = useFilePicker('geöffnet')

  const searching = query.trim().length > 0

  const featuredActions = useMemo(
    () =>
      FEATURED_IDS.map((id) => ACTIONS.find((a) => a.id === id)).filter(
        (a): a is ToolAction => Boolean(a),
      ),
    [],
  )

  const showFeatured = !searching && (filter === 'alle' || filter === 'ton')

  // Searching looks through everything, the way in included; filtering by a
  // group narrows the grid; „Alle" shows all tools in one compact grid below
  // the three featured cards.
  const matches = useMemo(() => {
    if (searching) return searchActions(query)
    const featuredSet = new Set<string>(FEATURED_IDS)
    const pool = ACTIONS.filter(
      (action) =>
        action.group !== 'holen' &&
        (filter === 'alle' || action.group === filter) &&
        !(showFeatured && featuredSet.has(action.id)),
    )
    if (filter === 'alle' || filter === 'ton') {
      const rank = new Map(PRIORITY_GRID_IDS.map((id, index) => [id, index]))
      return [...pool].sort((a, b) => {
        const ra = rank.get(a.id) ?? 999
        const rb = rank.get(b.id) ?? 999
        return ra - rb
      })
    }
    return pool
  }, [query, searching, filter, showFeatured])

  // Through `useShallow` and a `useMemo`, not `new Set(...)` inside the
  // selector: a fresh Set on every read is a fresh identity on every read,
  // which zustand turns into a render loop.
  const kinds = useSession(useShallow((state) => state.assets.map((asset) => asset.kind)))
  const have = useMemo(() => new Set(kinds), [kinds])
  const dimmed = (action: ToolAction) =>
    have.size > 0 && action.kinds.length > 0 && !action.kinds.some((kind) => have.has(kind))

  const tile = (action: ToolAction) => (
    <Tool key={action.id} action={action} dimmed={dimmed(action)} onClick={() => setPanel(action.panel)} />
  )

  return (
    <div className="flex flex-col gap-[24px] sm:gap-[28px]">
      {picker.input}

      {/* -- the way in ----------------------------------------------------- */}
      {active ? (
        <section className="grid items-center gap-[24px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-[48px]">
          <div className="flex min-w-0 flex-col gap-[8px]">
            <h2 className="display-md">Was soll mit der Datei passieren?</h2>
            <p className="value truncate text-body text-ink">{active.name}</p>
            <p className="text-small text-muted">
              {KIND_LABEL[active.kind]} · <span className="value">{formatBytes(active.sizeBytes)}</span>
              {active.durationSeconds ? (
                <>
                  {' '}· <span className="value">{formatDuration(active.durationSeconds)}</span>
                </>
              ) : null}
            </p>
          </div>
          <FileCard onOpen={picker.open} />
        </section>
      ) : (
        <section className="grid grid-cols-1 gap-[16px] lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div className="flex flex-col justify-between gap-[20px] rounded-card bg-panel-soft p-[24px] ring-1 ring-inset ring-line sm:p-[32px]">
            <div className="flex max-w-[38em] flex-col gap-[10px]">
              <h2 className="display-md sm:display-lg">Ton, Video und Bilder bearbeiten</h2>
              <p className="text-body leading-[1.55] text-prose">
                Alles rechnet direkt auf deinem Gerät. Deine Dateien bleiben 100% privat.
              </p>
            </div>
            <div className="inline-flex self-start items-center gap-[8px] rounded-pill bg-panel-mid px-[12px] py-[6px] text-small font-medium text-ink ring-1 ring-inset ring-rule">
              <ShieldCheckIcon />
              <span>100% lokal &amp; privat</span>
            </div>
          </div>
          <WayIn onOpen={picker.open} busy={picker.busy} />
        </section>
      )}

      {/* -- the tools ------------------------------------------------------ */}
      <section aria-label="Werkzeuge" className="flex flex-col gap-[14px]">
        {/* One bar: narrow by group on the left, search on the right. */}
        <div className="flex flex-col-reverse gap-[12px] md:flex-row md:items-center md:justify-between">
          <div
            role="radiogroup"
            aria-label="Werkzeuge nach Gruppe"
            className={`flex flex-wrap gap-[8px] transition-opacity duration-[var(--dur-fast)] ${searching ? 'opacity-40' : ''}`}
          >
            {(['alle', ...FILTERS] as const).map((group) => {
              const on = !searching && filter === group
              return (
                <button
                  key={group}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    setQuery('')
                    setFilter(group)
                  }}
                  className={`press rounded-pill px-[14px] py-[7px] text-small font-medium transition-colors duration-[var(--dur-fast)] ${
                    on
                      ? 'bg-ink font-semibold text-on-ink'
                      : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid hover:text-ink'
                  }`}
                >
                  {group === 'alle' ? 'Alle' : GROUP_LABEL[group]}
                </button>
              )
            })}
          </div>

          <label className="relative flex w-full items-center md:w-[300px]">
            <svg
              viewBox="0 0 16 16"
              aria-hidden
              className="pointer-events-none absolute left-[14px] h-4 w-4 text-muted"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.4 10.4L14 14" />
            </svg>
            <input
              type="search"
              data-own-focus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Werkzeug suchen…"
              aria-label="Werkzeuge durchsuchen, zum Beispiel „mp3 aus video“ oder „tonart“"
              className="w-full rounded-pill border-0 bg-panel-soft py-[8px] pl-[38px] pr-[16px] text-small text-ink outline-none ring-1 ring-inset ring-line transition-colors duration-[var(--dur-fast)] placeholder:text-muted hover:bg-panel-mid focus:bg-raised focus:ring-2 focus:ring-ink [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
        </div>

        {/* Featured 3-card row */}
        {showFeatured ? (
          <div className="grid grid-cols-1 gap-[12px] lg:grid-cols-3">
            {featuredActions.map((action) => (
              <FeaturedTool
                key={action.id}
                action={action}
                dimmed={dimmed(action)}
                onClick={() => setPanel(action.panel)}
              />
            ))}
          </div>
        ) : null}

        {/* Main tool grid */}
        {searching && matches.length === 0 ? (
          <p className="text-small text-muted">
            Nichts gefunden für <span className="value text-ink">{query}</span>. Versuchen Sie es mit
            einem Format („mp3“, „webp“, „gif“) oder mit dem, was herauskommen soll.
          </p>
        ) : (
          <Grid>{matches.map(tile)}</Grid>
        )}
      </section>

      {/* -- the Windows app ------------------------------------------------ */}
      {IN_DESKTOP_APP ? null : (
        <section className="flex flex-col items-start gap-[16px] rounded-card bg-panel-soft p-[20px] ring-1 ring-inset ring-line sm:flex-row sm:items-center sm:justify-between sm:p-[24px]">
          <div className="flex flex-col gap-[4px]">
            <h2 className="text-body font-semibold text-ink">Sondra als Windows-App</h2>
            <p className="text-small text-prose">Eigenes Fenster, läuft ohne Browser, rechnet auf Ihrem Rechner.</p>
          </div>
          <button
            type="button"
            onClick={openGetAppDialog}
            className="press inline-flex shrink-0 items-center gap-[8px] rounded-nav bg-raised px-[14px] py-[10px] text-small font-medium text-ink ring-1 ring-inset ring-rule hover:ring-ink"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <path d="M8 2.5v7.5M4.8 6.8 8 10l3.2-3.2M3 13h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Für Windows herunterladen
          </button>
        </section>
      )}
    </div>
  )
}
