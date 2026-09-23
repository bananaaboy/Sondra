/**
 * The start screen: a way in, and every capability as a tile.
 *
 * Redesigned on 23.9.2026 together with the move to rounded forms. What it
 * replaced read as one long ruled column: a headline, a button row, a rule, a
 * second button row for the Windows app, a heading, a search field, and then
 * five group headings each over its own block of tiles — thirty tiles in a
 * scroll of five sections, every one of them weighted the same.
 *
 * Now the page has three parts with three different jobs:
 *
 * 1. The way in. Without a file it is a drop target — the one thing a
 *    visitor has to do before anything else works — beside a sentence saying
 *    what the page is. With a file it names the file and offers the tools that
 *    fit it, so the next step is one tap instead of a search.
 * 2. The tools, filtered by group with a row of pills rather than scrolled
 *    through as five sections. „Alle" keeps the groups, as asked.
 * 3. The Windows app, as its own quiet block at the end.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/shallow'

import { useFilePicker } from '../hooks/useIngest'
import { ACTIONS, GROUP_LABEL, actionsFor, searchActions, type ToolAction, type ToolGroup } from '../lib/actions'
import { IN_DESKTOP_APP, WINDOWS_SETUP } from '../lib/desktop'
import { formatBytes, formatDuration } from '../lib/format'
import { KIND_LABEL, useActiveAsset, useSession, type PanelId } from '../state/store'
import { PANELS, ToolIcon } from './panelMeta'
import { ArrowRight, Button } from './ui/primitives'

/* -------------------------------------------------------------------------- */

/** Every tile borrows the icon of the tool it opens. */
const ICONS: Record<PanelId, ReactNode> = Object.fromEntries(
  PANELS.map((panel) => [panel.id, panel.icon]),
) as Record<PanelId, ReactNode>

/** The groups a visitor filters by. „Hereinholen" is the way in above. */
const FILTERS: ToolGroup[] = ['ton', 'video', 'bild', 'musik']

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
      className="press group flex scroll-mt-[120px] flex-col gap-[6px] rounded-card bg-panel-mid p-[14px] text-left transition-colors duration-[var(--dur-fast)] hover:bg-panel-strong sm:p-[16px]"
    >
      <span className="flex items-center gap-[8px]">
        {/* A tool that needs a kind of file the session does not hold says so
            through its icon only; fading the whole tile cost legibility. */}
        <span className={dimmed ? 'text-faint' : 'text-ink'}>
          <ToolIcon>{ICONS[action.panel]}</ToolIcon>
        </span>
        <span className="text-small font-semibold leading-[1.3] text-ink">{action.label}</span>
      </span>
      <span className="text-small leading-[1.4] text-prose">{action.hint}</span>
    </button>
  )
}

function Grid({ children }: { children: ReactNode }) {
  // More desk means more tiles visible at once, not wider ones.
  return <div className="grid grid-cols-2 gap-[8px] lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{children}</div>
}

/* -- the way in ------------------------------------------------------------- */

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" aria-hidden>
      <path
        d="M12 15V4.5M7.5 9L12 4.5 16.5 9M4.5 14.5v3.5a2 2 0 002 2h11a2 2 0 002-2v-3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Without a file: the two ways in, stacked.
 *
 * This was a dashed drop target of its own, 250px tall, beside the headline —
 * mostly empty, and the dashes promised a drop zone the whole window already
 * is (dragging a file anywhere shows the overlay). Now it is just the actions:
 * the one that starts work, the other way in, and a line saying dragging
 * works too, on the same block as the headline.
 */
function WayIn({ onOpen, busy }: { onOpen: () => void; busy: boolean }) {
  const setPanel = useSession((state) => state.setPanel)
  return (
    <div className="flex flex-col gap-[10px] sm:w-[280px] sm:shrink-0">
      <Button onClick={onOpen} disabled={busy} className="w-full">
        <UploadIcon />
        {busy ? 'Wird gelesen…' : 'Datei öffnen'}
      </Button>
      <Button variant="quiet" onClick={() => setPanel('downloader')} className="w-full">
        Von einer Adresse laden
      </Button>
      <p className="hidden text-center text-small text-prose sm:block">oder einfach ins Fenster ziehen</p>
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
    <div className="flex flex-col gap-[12px] rounded-card bg-panel-soft p-[16px] sm:p-[20px]">
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
                <ToolIcon>{ICONS[action.panel]}</ToolIcon>
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

  // Searching looks through everything, the way in included; filtering by a
  // group narrows the grid; „Alle" shows the groups in their order.
  const matches = useMemo(() => {
    if (searching) return searchActions(query)
    return ACTIONS.filter((action) => action.group !== 'holen' && (filter === 'alle' || action.group === filter))
  }, [query, searching, filter])

  const grouped = useMemo(() => {
    const map = new Map<ToolGroup, ToolAction[]>()
    for (const action of matches) {
      const list = map.get(action.group)
      if (list) list.push(action)
      else map.set(action.group, [action])
    }
    return FILTERS.filter((group) => map.has(group)).map((group) => ({ group, actions: map.get(group) ?? [] }))
  }, [matches])

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
    <div className="flex flex-col gap-[40px] sm:gap-[56px]">
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
        /* One block: what the page is, and how to start. The tint holds both,
           so the headline is not a sentence floating beside a box. */
        <section className="flex flex-col gap-[24px] rounded-card bg-panel-soft p-[24px] sm:flex-row sm:items-center sm:justify-between sm:gap-[40px] sm:p-[40px]">
          <div className="flex max-w-[40em] flex-col gap-[12px]">
            <h2 className="display-md sm:display-lg">Ton, Video und Bilder bearbeiten</h2>
            <p className="text-body leading-[1.55] text-prose">
              Alles rechnet in diesem Tab. Ihre Dateien werden nirgendwohin hochgeladen, und mit dem
              Schließen des Tabs ist alles weg.
            </p>
          </div>
          <WayIn onOpen={picker.open} busy={picker.busy} />
        </section>
      )}

      {/* -- the tools ------------------------------------------------------ */}
      <section className="flex flex-col gap-[16px]">
        <h2 className="display-md">Werkzeuge</h2>

        {/* One bar: narrow by group on the left, search on the right. The
            search was a thin outlined pill parked at the far edge of the
            heading row, related to nothing next to it; filled and on the same
            line as the pills it reads as the second half of one control. */}
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
                  className={`press rounded-pill px-[12px] py-[8px] text-small font-medium sm:px-[16px] transition-colors duration-[var(--dur-fast)] ${
                    on ? 'bg-ink text-on-ink' : 'bg-panel-soft text-ink hover:bg-panel-mid'
                  }`}
                >
                  {group === 'alle' ? 'Alle' : GROUP_LABEL[group]}
                </button>
              )
            })}
          </div>

          <label className="relative flex w-full items-center md:w-[320px]">
            <svg
              viewBox="0 0 16 16"
              aria-hidden
              className="pointer-events-none absolute left-[16px] h-4 w-4 text-ink"
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
              placeholder="Werkzeug suchen"
              aria-label="Werkzeuge durchsuchen, zum Beispiel „mp3 aus video“ oder „tonart“"
              className="w-full rounded-pill border-0 bg-panel-soft py-[9px] pl-[42px] pr-[16px] text-small text-ink outline-none ring-1 ring-inset ring-transparent transition-colors duration-[var(--dur-fast)] placeholder:text-muted hover:bg-panel-mid focus:bg-raised focus:ring-2 focus:ring-ink [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
        </div>

        {searching ? (
          matches.length > 0 ? (
            <Grid>{matches.map(tile)}</Grid>
          ) : (
            <p className="text-small text-muted">
              Nichts gefunden für <span className="value text-ink">{query}</span>. Versuchen Sie es mit
              einem Format („mp3“, „webp“, „gif“) oder mit dem, was herauskommen soll.
            </p>
          )
        ) : filter === 'alle' ? (
          <div className="flex flex-col gap-[24px]">
            {grouped.map(({ group, actions }) => (
              <div key={group} className="flex flex-col gap-[10px]">
                <h3 className="text-body font-semibold text-ink">{GROUP_LABEL[group]}</h3>
                <Grid>{actions.map(tile)}</Grid>
              </div>
            ))}
          </div>
        ) : (
          <Grid>{matches.map(tile)}</Grid>
        )}
      </section>

      {/* -- the Windows app ------------------------------------------------ */}
      {IN_DESKTOP_APP ? null : (
        <section className="flex flex-col items-start gap-[16px] rounded-card bg-panel-soft p-[20px] sm:flex-row sm:items-center sm:justify-between sm:p-[24px]">
          <div className="flex flex-col gap-[4px]">
            <h2 className="text-body font-semibold text-ink">Sondra als Windows-App</h2>
            <p className="text-small text-prose">Eigenes Fenster, läuft ohne Browser, rechnet auf Ihrem Rechner.</p>
          </div>
          <a
            href={WINDOWS_SETUP}
            rel="noopener"
            className="press inline-flex shrink-0 items-center gap-[8px] rounded-nav bg-raised px-[14px] py-[10px] text-small font-medium text-ink ring-1 ring-inset ring-rule hover:ring-ink"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
              <path d="M8 2.5v7.5M4.8 6.8 8 10l3.2-3.2M3 13h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Für Windows herunterladen
          </a>
        </section>
      )}
    </div>
  )
}
