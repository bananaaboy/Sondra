/**
 * The start screen: a way in, films and series, and every tool as a tile.
 *
 * Rebuilt on 28.10.2026 after „sie ist sehr cluttered“: two boxes, a
 * privacy badge, three illustrated cards and forty-five tiles of the same
 * weight in one block — 4 300 px on a phone, where the app also advertised
 * the Windows app. Now, following DESIGN.md („Das ruhige Blatt“):
 * 1. The way in: one tinted block — headline, one sentence, „Datei
 *    auswählen“; the whole block takes a dropped file.
 * 2. Films and series: the Merkliste (with what comes next), the player, the
 *    folder and the downloader — on a phone the reason to open Sondra.
 * 3. The tools in their groups, each under its heading, two rows of each
 *    and the rest one click on; a group pill shows one group whole, the
 *    search looks through everything.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/shallow'

import { useFilePicker, useIngestFiles, useProjectPicker } from '../hooks/useIngest'
import { ACTIONS, GROUP_LABEL, actionsFor, searchActions, type ToolAction, type ToolGroup } from '../lib/actions'
import { formatBytes, formatDuration } from '../lib/format'
import { useMerkliste } from '../lib/merkliste'
import { saveProjectFile } from '../lib/project'
import { KIND_LABEL, useActiveAsset, useSession, type PanelId } from '../state/store'
import { SondraProjectIcon } from './AssetList'
import { ProjectToDriveButton } from './GoogleDrive'
import { positionLabel } from './panels/merklisteShared'
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

/** The order within a group: the common jobs first, the rest as the list keeps them. */
const PRIORITY_GRID_IDS = [
  'audio-cut',
  'audio-noise',
  'transcript',
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

/**
 * One tool, as a tile.
 *
 * A tint gives the tile its edge, the radius makes it an object you can press
 * rather than a cell of a table. The icon sits beside the label instead of
 * stacked above it: a column of icon, label, hint made thirty tiles thirty
 * little posters. The tint is the pale one (`panel-soft`) since 28.10.2026 —
 * forty tiles on `panel-mid` made the page one green wall — and the hint
 * stops after two lines.
 *
 * The hint is `prose`, not `muted`: on a tint `muted` measured APCA Lc 59.3
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
      className="press group flex scroll-mt-[120px] flex-col gap-[6px] rounded-card bg-panel-soft p-[12px] text-left ring-1 ring-inset ring-line transition-colors duration-[var(--dur-fast)] hover:bg-panel-mid sm:p-[14px]"
    >
      <span className="flex items-center gap-[8px]">
        {/* A tool that needs a kind of file the session does not hold says so
            through its icon only; fading the whole tile cost legibility. The
            icon's own small field takes the ink when the tile is pointed at. */}
        <span
          className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-nav bg-raised transition-colors duration-[var(--dur-fast)] ${
            dimmed ? 'text-faint' : 'text-ink group-hover:bg-ink group-hover:text-on-ink'
          }`}
        >
          <ToolIcon>{iconFor(action)}</ToolIcon>
        </span>
        <span className="text-small font-semibold leading-[1.25] text-ink">{action.label}</span>
      </span>
      <span className="line-clamp-2 text-small leading-[1.4] text-prose">{action.hint}</span>
    </button>
  )
}

function Grid({ children }: { children: ReactNode }) {
  // More desk means more tiles visible at once, not wider ones.
  return <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{children}</div>
}

/** How many tiles stand in a row of `Grid` at this width — two rows of a group are shown. */
function useColumns(): number {
  const read = () =>
    typeof window === 'undefined'
      ? 5
      : window.matchMedia('(min-width: 1280px)').matches
        ? 5
        : window.matchMedia('(min-width: 1024px)').matches
          ? 4
          : window.matchMedia('(min-width: 640px)').matches
            ? 3
            : 2
  const [columns, setColumns] = useState(read)
  useEffect(() => {
    const queries = ['(min-width: 640px)', '(min-width: 1024px)', '(min-width: 1280px)'].map((q) => window.matchMedia(q))
    const update = () => setColumns(read())
    queries.forEach((query) => query.addEventListener('change', update))
    return () => queries.forEach((query) => query.removeEventListener('change', update))
  }, [])
  return columns
}

/* -- the way in ------------------------------------------------------------- */

function UploadTrayIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" aria-hidden>
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

/**
 * Without a file: one block that says what Sondra does and opens a file —
 * and takes one dropped on it anywhere. Before, a headline box with a
 * „100 % lokal & privat“ badge stood beside a dashed drop box with three
 * buttons: two blocks and a badge for one step.
 */
function WayIn({
  onOpen,
  onOpenProject,
  busy,
  projectBusy,
}: {
  onOpen: () => void
  onOpenProject: () => void
  busy: boolean
  projectBusy: boolean
}) {
  const setPanel = useSession((state) => state.setPanel)
  const { ingest } = useIngestFiles()
  const [dragging, setDragging] = useState(false)

  return (
    <section
      aria-label="Datei öffnen"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'copy'
        if (!dragging) setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setDragging(false)
        if (event.dataTransfer.files.length) void ingest(event.dataTransfer.files, 'hierher gezogen')
      }}
      className={`flex flex-col gap-[20px] rounded-card p-[20px] transition-colors duration-[var(--dur-fast)] sm:p-[28px] lg:flex-row lg:items-end lg:justify-between lg:gap-[40px] ${
        dragging ? 'bg-panel-mid ring-2 ring-inset ring-ink' : 'bg-panel-soft ring-1 ring-inset ring-line'
      }`}
    >
      <div className="flex max-w-[34em] flex-col gap-[8px]">
        <h2 className="display-md sm:display-lg">{dragging ? 'Loslassen zum Öffnen' : 'Ton, Video und Bilder bearbeiten'}</h2>
        <p className="text-body leading-[1.55] text-prose">
          Gerechnet wird auf Ihrem Gerät — keine Datei wird hochgeladen.
        </p>
      </div>
      <div className="flex flex-col gap-[10px] lg:items-end">
        <div className="flex flex-wrap items-center gap-[8px]">
          <Button onClick={onOpen} disabled={busy} className="font-semibold">
            <UploadTrayIcon />
            {busy ? 'Wird gelesen…' : 'Datei auswählen'}
          </Button>
          <Button variant="quiet" onClick={() => setPanel('downloader')}>
            Von Adresse laden
          </Button>
        </div>
        <p className="flex flex-wrap items-center gap-x-[6px] text-small text-prose">
          <span className="hidden sm:inline">oder hierher ziehen ·</span>
          <button
            type="button"
            onClick={onOpenProject}
            disabled={projectBusy}
            className="press inline-flex items-center gap-[5px] text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink disabled:opacity-40"
            title=".sondra Projektdatei laden"
          >
            <SondraProjectIcon />
            {projectBusy ? 'Lädt…' : 'Projekt laden'}
          </button>
        </p>
      </div>
    </section>
  )
}

/* -- films and series ------------------------------------------------------- */

/**
 * The Merkliste, the player, the folder and the downloader: what is watched
 * and kept, as four wide tiles. On a phone, the reason Sondra is opened; the
 * Merkliste says what comes next.
 */
function MediaTiles() {
  const setPanel = useSession((state) => state.setPanel)
  const list = useMerkliste()
  const watching = list
    .filter((item) => (item.status ?? 'watching') === 'watching')
    .sort((a, b) => (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt))
  const next = watching[0]
  const tiles: { id: PanelId; label: string; line: string }[] = [
    {
      id: 'merkliste',
      label: 'Merkliste',
      line: next
        ? `Weiter: ${next.title} · ${positionLabel(next.season, next.episode)}`
        : list.length
          ? `${list.length} ${list.length === 1 ? 'Eintrag' : 'Einträge'}`
          : 'Serien und Filme, mit Staffeln und Stand',
    },
    { id: 'player', label: 'Abspielen', line: 'Filme und Musik, mit Untertiteln' },
    { id: 'folder', label: 'Ordner', line: 'Folgen auf dem Gerät oder in Drive' },
    { id: 'downloader', label: 'Herunterladen', line: 'Von einer Adresse holen' },
  ]
  return (
    <section aria-labelledby="start-filme" className="flex flex-col gap-[12px]">
      <h2 id="start-filme" className="text-subheading text-ink">
        Filme und Serien
      </h2>
      <div className="grid grid-cols-2 gap-[10px] lg:grid-cols-4">
        {tiles.map((tile, index) => (
          <button
            key={tile.id}
            type="button"
            onClick={() => setPanel(tile.id)}
            // The Merkliste across the row on a phone: „Weiter: …“ needs the width.
            className={`${index === 0 ? 'col-span-2 lg:col-span-1 ' : ''}press group flex min-w-0 items-center gap-[12px] rounded-card bg-panel-soft p-[12px] text-left ring-1 ring-inset ring-line transition-colors duration-[var(--dur-fast)] hover:bg-panel-mid sm:p-[14px]`}
          >
            <span className="grid h-[36px] w-[36px] shrink-0 place-items-center rounded-nav bg-raised text-ink transition-colors duration-[var(--dur-fast)] group-hover:bg-ink group-hover:text-on-ink">
              <ToolIcon>{ICONS[tile.id]}</ToolIcon>
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-small font-semibold leading-[1.25] text-ink">{tile.label}</span>
              <span className="line-clamp-2 text-small leading-[1.4] text-prose sm:line-clamp-1" title={tile.line}>
                {tile.line}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

/** With a file: what it is, and the tools that fit it. */
function FileCard({ onOpen, onOpenProject }: { onOpen: () => void; onOpenProject: () => void }) {
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
      <div className="flex flex-wrap items-center justify-between gap-[10px]">
        <button
          type="button"
          onClick={onOpen}
          className="press text-small text-ink underline underline-offset-[3px] hover:no-underline"
        >
          Andere Datei öffnen
        </button>
        <div className="flex flex-wrap items-center gap-[6px]">
          <button
            type="button"
            onClick={onOpenProject}
            className="press inline-flex items-center gap-[6px] rounded-nav bg-raised px-[10px] py-[5px] text-small font-medium text-ink ring-1 ring-inset ring-line hover:ring-ink"
            title=".sondra Projektdatei laden"
          >
            <SondraProjectIcon />
            <span>Projekt laden</span>
          </button>
          <button
            type="button"
            onClick={() => void saveProjectFile()}
            className="press inline-flex items-center gap-[6px] rounded-nav bg-raised px-[10px] py-[5px] text-small font-medium text-ink ring-1 ring-inset ring-line hover:ring-ink"
            title="Speichert alle Sitzungsdateien und Werkzeugeinstellungen als .sondra Projektdatei"
          >
            <SondraProjectIcon />
            <span>Projekt speichern (.sondra)</span>
          </button>
          <ProjectToDriveButton className="press inline-flex items-center gap-[6px] rounded-nav bg-raised px-[10px] py-[5px] text-small font-medium text-ink ring-1 ring-inset ring-line hover:ring-ink" />
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

export function Home() {
  const setPanel = useSession((state) => state.setPanel)
  const active = useActiveAsset()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ToolGroup | 'alle'>('alle')
  const [unfolded, setUnfolded] = useState<Set<ToolGroup>>(() => new Set())
  const picker = useFilePicker('geöffnet')
  const projectPicker = useProjectPicker()
  const columns = useColumns()

  const searching = query.trim().length > 0

  // Each group in its order: the common jobs first.
  const groups = useMemo(() => {
    const rank = new Map(PRIORITY_GRID_IDS.map((id, index) => [id, index]))
    return FILTERS.map((group) => ({
      group,
      actions: ACTIONS.filter((action) => action.group === group).sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999)),
    }))
  }, [])
  const matches = useMemo(() => (searching ? searchActions(query) : []), [query, searching])

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
    <div className="flex flex-col gap-[28px] sm:gap-[36px]">
      {picker.input}
      {projectPicker.input}

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
          <FileCard onOpen={picker.open} onOpenProject={projectPicker.open} />
        </section>
      ) : (
        <WayIn onOpen={picker.open} onOpenProject={projectPicker.open} busy={picker.busy} projectBusy={projectPicker.busy} />
      )}

      {active ? null : <MediaTiles />}

      {/* -- the tools ------------------------------------------------------ */}
      <section aria-labelledby="start-werkzeuge" className="flex flex-col gap-[16px]">
        <div className="flex flex-col gap-[12px] border-b border-line pb-[14px] md:flex-row md:items-center md:justify-between">
          <h2 id="start-werkzeuge" className="text-subheading text-ink">
            Werkzeuge
          </h2>
          <div className="flex flex-col-reverse gap-[10px] md:flex-row md:items-center">
            <div
              role="radiogroup"
              aria-label="Werkzeuge nach Gruppe"
              className={`flex flex-wrap gap-[6px] transition-opacity duration-[var(--dur-fast)] ${searching ? 'opacity-40' : ''}`}
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
                    className={`press rounded-pill px-[12px] py-[6px] text-small font-medium transition-colors duration-[var(--dur-fast)] ${
                      on ? 'bg-ink font-semibold text-on-ink' : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid hover:text-ink'
                    }`}
                  >
                    {group === 'alle' ? 'Alle' : GROUP_LABEL[group]}
                  </button>
                )
              })}
            </div>

            <label className="relative flex w-full items-center md:w-[260px]">
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
                className="w-full rounded-pill border-0 bg-raised py-[8px] pl-[38px] pr-[16px] text-small text-ink outline-none ring-1 ring-inset ring-line transition-colors duration-[var(--dur-fast)] placeholder:text-muted hover:ring-rule focus:ring-2 focus:ring-ink [&::-webkit-search-cancel-button]:hidden"
              />
            </label>
          </div>
        </div>

        {searching ? (
          matches.length === 0 ? (
            <p className="text-small text-prose">
              Nichts gefunden für <span className="value text-ink">{query}</span>. Versuchen Sie es mit einem Format („mp3“,
              „webp“, „gif“) oder mit dem, was herauskommen soll.
            </p>
          ) : (
            <Grid>{matches.map(tile)}</Grid>
          )
        ) : (
          groups
            .filter(({ group }) => filter === 'alle' || filter === group)
            .map(({ group, actions }) => {
              // Two rows of each group; a chosen group, or one opened, whole.
              const whole = filter === group || unfolded.has(group)
              const shown = whole ? actions : actions.slice(0, columns * 2)
              const rest = actions.length - shown.length
              return (
                <section key={group} aria-labelledby={`start-${group}`} className="flex flex-col gap-[10px]">
                  <h3 id={`start-${group}`} className="flex items-baseline gap-[8px] text-body font-semibold text-ink">
                    {GROUP_LABEL[group]}
                    <span className="value text-small font-normal text-prose">{actions.length}</span>
                  </h3>
                  <Grid>{shown.map(tile)}</Grid>
                  {rest > 0 ? (
                    <button
                      type="button"
                      onClick={() => setUnfolded((current) => new Set(current).add(group))}
                      className="press self-start text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                    >
                      {rest === 1 ? 'Noch ein Werkzeug' : `Noch ${rest} Werkzeuge`} für {GROUP_LABEL[group]}
                    </button>
                  ) : null}
                </section>
              )
            })
        )}
      </section>
    </div>
  )
}
