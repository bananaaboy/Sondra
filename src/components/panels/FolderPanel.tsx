/**
 * „Ordner“: the files of a folder on this computer, to look through and to
 * pick from.
 *
 * Tiles with a picture of each film and photo, or a list with columns;
 * subfolders to walk into, or everything below at once; a kind to show, a
 * word to find, an order. Selecting is what every file manager does — a
 * click, Ctrl or Cmd for more, Shift for a run, the arrow keys and Space —
 * and what is selected can be played, taken into the session, saved as ZIP,
 * sent to Google Drive or, after asking, deleted.
 *
 * Two things come with it. Episodes of series on the Merkliste are
 * recognised by their names: the tile says which and whether it is seen,
 * and „Weiterschauen“ plays the next one with the rest of the series behind
 * it. And „Doppelte finden“ compares the files and selects the copies.
 *
 * Nothing here is read beyond names, sizes and dates until a picture is
 * made for a tile on screen, and nothing leaves the device.
 *
 * The folder can also be Sondra's own in Google Drive: the same view,
 * films played from there (streamed), and what is watched ticks the
 * Merkliste off. Without pictures on the tiles — those would mean fetching
 * every film — and without deleting.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'

import { saveBytes } from '../../lib/download'
import { copiesOf, findDuplicates, type DuplicateReport } from '../../lib/duplicates'
import {
  allowed,
  canPickFolder,
  clickSelect,
  crumbs,
  deleteFiles,
  episodeOf,
  episodesInSeason,
  folderSeries,
  listing,
  pickFolder,
  withoutFiles,
  type DirectoryHandle,
  type FolderEpisode,
  type FolderFile,
  type KindFilter,
  type SortKey,
} from '../../lib/folder'
import { formatBytes, formatDuration } from '../../lib/format'
import { fileHere, lookUpRemembered, playFiles, readDriveFolder, readFolder, stopReading, takeFileList, useFolder } from '../../lib/folderLibrary'
import { DRIVE_PROBLEM, DriveError, driveLinked, driveMediaUrl, saveFilesToDrive, useDrive } from '../../lib/googleDrive'
import { DriveIcon } from '../GoogleDrive'
import { SeasonFilingDialog } from '../SeasonFiling'
import { requestOpenSeries, useMerkliste } from '../../lib/merkliste'
import { thumbnailFor, type Thumbnail } from '../../lib/thumbnails'
import { createZip, uniqueEntryNames } from '../../lib/zip'
import { useIngestFiles } from '../../hooks/useIngest'
import { KIND_LABEL, useSession } from '../../state/store'
import { Button, Dialog, Notice } from '../ui/primitives'

type View = 'kacheln' | 'liste'
interface Preferences {
  view: View
  sort: SortKey
  descending: boolean
  deep: boolean
}
const PREFS_KEY = 'sondra:ordner'
const DEFAULT_PREFS: Preferences = { view: 'kacheln', sort: 'name', descending: false, deep: false }

function readPrefs(): Preferences {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Preferences>) }
  } catch {
    return DEFAULT_PREFS
  }
}

/** Tiles drawn at once; more on request — a folder of thousands stays quick. */
const PAGE = 240

const FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'alle', label: 'Alle' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Ton' },
  { id: 'image', label: 'Bilder' },
  { id: 'andere', label: 'Andere' },
]
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'modified', label: 'Geändert' },
  { id: 'size', label: 'Grösse' },
  { id: 'kind', label: 'Art' },
]

const dateOf = (ms: number) => new Date(ms).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' })
const extensionOf = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase() ?? ''
const keyOf = (file: FolderFile) => `${file.path}|${file.size}|${file.modified}`
const linkClass =
  'press inline-flex items-center gap-[6px] rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-40'

/* -------------------------------------------------------------------------- */
/* Icons                                                                       */
/* -------------------------------------------------------------------------- */

function FolderGlyph({ className = 'h-[30px] w-[30px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      <path d="M3 7.2c0-1 .8-1.8 1.8-1.8h4.3l2 2.2h8.1c1 0 1.8.8 1.8 1.8v8.4c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8z" />
    </svg>
  )
}

function KindGlyph({ kind, className = 'h-[26px] w-[26px]' }: { kind: FolderFile['kind']; className?: string }) {
  const path =
    kind === 'video'
      ? 'M3.5 6h12v12h-12zM15.5 10.2l5-2.8v9.2l-5-2.8'
      : kind === 'audio'
        ? 'M9 17.5V6.5l10-2v11M9 17.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM19 15.5a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z'
        : kind === 'image'
          ? 'M3.5 5h17v14h-17zM3.5 15.5l5-4.5 4 3.6 3-2.6 5 4.5M9 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3z'
          : 'M6 3.5h8l4 4V20.5H6zM14 3.5v4h4'
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  )
}

function Check({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid h-[22px] w-[22px] place-items-center rounded-pill ring-1 ring-inset transition-colors duration-[var(--dur-fast)] ${
        on ? 'bg-ink text-on-ink ring-ink' : 'bg-raised/90 text-transparent ring-rule'
      }`}
    >
      <svg viewBox="0 0 16 16" className="h-[12px] w-[12px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Pictures, made when a tile comes into view                                  */
/* -------------------------------------------------------------------------- */

function useThumbnail(file: FolderFile | null) {
  const ref = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<Thumbnail | null>(null)
  useEffect(() => {
    const node = ref.current
    // A file in Drive gets no picture: it would mean fetching it.
    if (!node || !file?.file || (file.kind !== 'video' && file.kind !== 'audio' && file.kind !== 'image')) return
    const kind = file.kind
    const local = file.file
    let cancelled = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void thumbnailFor(local, kind, keyOf(file)).then((made) => {
          if (!cancelled) setThumb(made)
        })
      },
      { rootMargin: '200px' },
    )
    observer.observe(node)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [file])
  return { ref, thumb }
}

/* -------------------------------------------------------------------------- */
/* Tiles and rows                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Keyboard focus follows the arrow keys — but only while it is in the
 * list already. On arrival the first tile took it, showed its ring and
 * scrolled the page to itself.
 */
function moveFocus(node: HTMLElement | null) {
  if (node && node.closest('[role=listbox]')?.contains(document.activeElement)) node.focus()
}

interface ItemProps {
  focused: boolean
  onFocus: () => void
}

function EpisodeMark({ episode }: { episode: FolderEpisode }) {
  return (
    <span
      className={`value inline-flex items-center gap-[4px] rounded-pill px-[7px] py-[2px] text-micro ${
        episode.seen ? 'bg-raised text-prose ring-1 ring-inset ring-line' : 'bg-ink text-on-ink'
      }`}
      title={episode.seen ? 'In der Merkliste als gesehen abgehakt' : 'Noch nicht gesehen'}
    >
      S{episode.season} · F{episode.episode}
      {episode.seen ? ' ✓' : ''}
    </span>
  )
}

function DirTile({
  name,
  count,
  size,
  focused,
  onFocus,
  onOpen,
  list,
}: ItemProps & { name: string; count: number; size: number; onOpen: () => void; list: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) moveFocus(ref.current)
  }, [focused])
  if (list) {
    return (
      <div
        ref={ref}
        role="option"
        aria-selected={false}
        tabIndex={focused ? 0 : -1}
        onFocus={onFocus}
        onClick={onOpen}
        className="press grid cursor-pointer grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-[10px] border-t border-line px-[10px] py-[8px] outline-none first:border-t-0 hover:bg-panel-soft focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink sm:grid-cols-[28px_minmax(0,1fr)_90px_90px_90px_80px]"
      >
        <span className="text-ink">
          <FolderGlyph className="h-[20px] w-[20px]" />
        </span>
        <span className="truncate text-small font-medium text-ink">{name}</span>
        <span className="hidden text-small text-prose sm:inline">Ordner</span>
        <span className="value hidden text-small text-prose sm:inline">{formatBytes(size)}</span>
        <span className="value text-right text-small text-prose sm:col-span-2">
          {count} {count === 1 ? 'Datei' : 'Dateien'}
        </span>
      </div>
    )
  }
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={false}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onClick={onOpen}
      title={`${name} öffnen`}
      className="press group flex cursor-pointer items-center gap-[12px] rounded-card bg-panel-mid px-[14px] py-[12px] text-left ring-1 ring-inset ring-line outline-none transition-colors duration-[var(--dur-fast)] hover:bg-panel-strong focus-visible:ring-2 focus-visible:ring-ink"
    >
      <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-nav bg-panel-strong text-ink transition-transform duration-[var(--dur-fast)] group-hover:scale-105">
        <FolderGlyph className="h-[22px] w-[22px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-semibold leading-[1.25] text-ink">{name}</span>
        <span className="value block truncate text-micro text-prose">
          {count} {count === 1 ? 'Datei' : 'Dateien'} · {formatBytes(size)}
        </span>
      </span>
      <svg
        viewBox="0 0 16 16"
        aria-hidden
        className="h-4 w-4 shrink-0 text-prose transition-transform duration-[var(--dur-fast)] group-hover:translate-x-[2px] group-hover:text-ink"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 3.5L10.5 8 6 12.5" />
      </svg>
    </div>
  )
}

function FileItem({
  file,
  selected,
  focused,
  onFocus,
  onClick,
  onToggle,
  onOpen,
  episode,
  list,
}: ItemProps & {
  file: FolderFile
  selected: boolean
  onClick: (event: ReactMouseEvent) => void
  onToggle: () => void
  onOpen: () => void
  episode: FolderEpisode | null
  list: boolean
}) {
  const { ref: seen, thumb } = useThumbnail(file)
  const node = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (focused) moveFocus(node.current)
  }, [focused])
  const setRef = (element: HTMLDivElement | null) => {
    node.current = element
    seen.current = element
  }
  const duration = thumb?.duration ? formatDuration(thumb.duration) : null
  const ext = extensionOf(file.name)
  const previewSrc = thumb?.url || null
  const common = {
    ref: setRef,
    role: 'option',
    'aria-selected': selected,
    tabIndex: focused ? 0 : -1,
    onFocus,
    onClick,
    onDoubleClick: onOpen,
    title: file.path,
  } as const
  const checkbox = (
    <button
      type="button"
      tabIndex={-1}
      aria-label={selected ? `${file.name} abwählen` : `${file.name} auswählen`}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      className="press grid place-items-center rounded-pill"
    >
      <Check on={selected} />
    </button>
  )

  if (list) {
    return (
      <div
        {...common}
        className={`grid cursor-default grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-[10px] border-t border-line px-[10px] py-[7px] outline-none first:border-t-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink sm:grid-cols-[28px_minmax(0,1fr)_90px_90px_90px_80px] ${
          selected ? 'bg-panel-mid' : 'hover:bg-panel-soft'
        }`}
      >
        {checkbox}
        <span className="flex min-w-0 items-center gap-[8px]">
          <span className="shrink-0 text-ink">
            <KindGlyph kind={file.kind} className="h-[18px] w-[18px]" />
          </span>
          <span className="value min-w-0 truncate text-small text-ink">{file.name}</span>
          {episode ? <EpisodeMark episode={episode} /> : null}
        </span>
        <span className="hidden text-small text-prose sm:inline">{KIND_LABEL[file.kind]}</span>
        <span className="value hidden text-small text-prose sm:inline">{formatBytes(file.size)}</span>
        <span className="value hidden text-small text-prose sm:inline">{dateOf(file.modified)}</span>
        <span className="value text-right text-small text-prose">{duration ?? '—'}</span>
      </div>
    )
  }

  return (
    <div
      {...common}
      className={`group relative flex cursor-default flex-col overflow-hidden rounded-card text-left outline-none transition-colors duration-[var(--dur-fast)] focus-visible:ring-2 focus-visible:ring-ink ${
        selected ? 'bg-panel-strong ring-2 ring-inset ring-ink' : 'bg-panel-mid ring-1 ring-inset ring-line hover:bg-panel-strong'
      }`}
    >
      <span className="relative grid aspect-[16/10] place-items-center overflow-hidden bg-panel-strong text-ink">
        {previewSrc ? (
          <img src={previewSrc} alt="" draggable={false} className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
        ) : (
          <span className="flex flex-col items-center gap-[4px] text-ink">
            <KindGlyph kind={file.kind} className="h-[34px] w-[34px]" />
            <span className="value text-micro uppercase tracking-wider text-prose">{ext || KIND_LABEL[file.kind]}</span>
          </span>
        )}
        {episode ? (
          <span className="absolute left-[8px] top-[8px]">
            <EpisodeMark episode={episode} />
          </span>
        ) : null}
        {duration ? (
          <span className="value absolute bottom-[8px] right-[8px] rounded-nav bg-ink/85 px-[6px] py-[2px] text-micro text-on-ink">{duration}</span>
        ) : null}
        <span
          className={`absolute right-[8px] top-[8px] transition-opacity duration-[var(--dur-fast)] ${
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100'
          }`}
        >
          {checkbox}
        </span>
      </span>
      <span className="flex flex-col gap-[3px] px-[12px] pb-[12px] pt-[9px]">
        <span className="line-clamp-2 text-small font-semibold leading-[1.3] text-ink [overflow-wrap:anywhere]">{file.name}</span>
        <span className="value text-micro text-prose">
          {KIND_LABEL[file.kind]} · {formatBytes(file.size)} · {dateOf(file.modified)}
        </span>
      </span>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* „Weiterschauen“                                                             */
/* -------------------------------------------------------------------------- */

function ContinueRow({ files, onPlay }: { files: FolderFile[]; onPlay: (queue: FolderEpisode[]) => void }) {
  const merk = useMerkliste()
  const setPanel = useSession((state) => state.setPanel)
  const series = useMemo(() => folderSeries(files, merk), [files, merk])
  if (series.length === 0) return null
  return (
    <section aria-labelledby="ordner-weiter" className="flex flex-col gap-[10px]">
      <h3 id="ordner-weiter" className="m-0 text-body font-semibold text-ink">
        Weiterschauen
      </h3>
      <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-3">
        {series.slice(0, 6).map((entry) => {
          const next = entry.next!
          const total = episodesInSeason(entry.item, next.season)
          const more = entry.queue.length - 1
          return (
            <div key={entry.item.id} className="flex flex-col gap-[10px] rounded-card bg-panel-mid p-[14px] ring-1 ring-inset ring-line">
              <div className="flex min-w-0 flex-col gap-[2px]">
                <button
                  type="button"
                  onClick={() => {
                    requestOpenSeries(entry.item.id)
                    setPanel('merkliste')
                  }}
                  title={`„${entry.item.title}“ in der Merkliste öffnen`}
                  className="press truncate text-left text-body font-semibold text-ink decoration-rule underline-offset-[3px] hover:underline"
                >
                  {entry.item.title}
                </button>
                <span className="text-small text-prose">
                  Staffel <span className="value">{next.season}</span> · Folge <span className="value">{next.episode}</span>
                  {total ? (
                    <>
                      {' '}
                      von <span className="value">{total}</span>
                    </>
                  ) : null}
                </span>
                <span className="value truncate text-micro text-prose" title={next.file.path}>
                  {next.file.name}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[6px]">
                <Button type="button" size="sm" onClick={() => onPlay(entry.queue)}>
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                    <path d="M5 3.6c0-.6.7-1 1.2-.7l6.6 4.1c.5.3.5 1.1 0 1.4L6.2 12.5c-.5.3-1.2-.1-1.2-.7z" />
                  </svg>
                  Abspielen
                </Button>
                <span className="text-small text-prose">{more > 0 ? `danach ${more} weitere aus dem Ordner` : 'die letzte ungesehene hier'}</span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* „Doppelte finden“                                                           */
/* -------------------------------------------------------------------------- */

function DuplicatesSection({
  state,
  onCancel,
  onSelect,
  onClose,
}: {
  state: { running: { done: number; total: number } | null; report: DuplicateReport | null; error: string | null }
  onCancel: () => void
  onSelect: () => void
  onClose: () => void
}) {
  const [open, setOpen] = useState(false)
  const { running, report, error } = state
  return (
    <section aria-labelledby="ordner-doppelt" className="flex flex-col gap-[10px] border-t border-line pt-[14px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[4px]">
        <h3 id="ordner-doppelt" className="m-0 text-body font-semibold text-ink">
          Doppelte Dateien
        </h3>
        {!running ? (
          <button type="button" onClick={onClose} className={`${linkClass} text-small`}>
            Schliessen
          </button>
        ) : null}
      </div>
      {running ? (
        <div role="status" className="flex flex-wrap items-center gap-x-[14px] gap-y-[6px] text-small text-prose">
          <span>
            Vergleicht <span className="value">{running.done}</span> von <span className="value">{running.total}</span> Dateien gleicher Grösse …
          </span>
          <button type="button" onClick={onCancel} className={`${linkClass} text-small`}>
            Abbrechen
          </button>
        </div>
      ) : error ? (
        <Notice tone="error" title="Vergleich nicht fertig">
          {error}
        </Notice>
      ) : report && report.groups.length === 0 ? (
        <p role="status" className="text-small text-prose">
          Keine doppelten Dateien{report.read ? ` — ${report.read} Dateien gleicher Grösse verglichen, alle verschieden` : ''}.
        </p>
      ) : report ? (
        <div className="flex flex-col gap-[10px]">
          <p role="status" className="text-small text-prose">
            <span className="font-semibold text-ink">
              {copiesOf(report).length} {copiesOf(report).length === 1 ? 'Kopie' : 'Kopien'}
            </span>{' '}
            in {report.groups.length} {report.groups.length === 1 ? 'Gruppe' : 'Gruppen'}, zusammen{' '}
            <span className="value">{formatBytes(report.spare)}</span>. Behalten wird je Gruppe die Datei ohne „(1)“ oder „Kopie“ im
            Namen, sonst die älteste.
          </p>
          <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[6px]">
            <Button type="button" size="sm" variant="quiet" onClick={onSelect}>
              Kopien auswählen
            </Button>
            <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className={`${linkClass} text-small`}>
              {open ? 'Gruppen verbergen' : 'Gruppen zeigen'}
            </button>
          </div>
          {open ? (
            <ul className="flex flex-col">
              {report.groups.map((group) => (
                <li key={group.files[0].path} className="flex flex-col gap-[2px] border-t border-line py-[8px] first:border-t-0">
                  <span className="text-micro text-prose">
                    <span className="value">{formatBytes(group.size)}</span> · {group.whole ? 'Byte für Byte gleich' : 'an 32 Stellen gleich'}
                  </span>
                  {group.files.map((file, index) => (
                    <span key={file.path} className="flex items-baseline gap-[8px] text-small">
                      <span className={`shrink-0 text-micro ${index === 0 ? 'font-semibold text-ink' : 'text-prose'}`}>{index === 0 ? 'Behalten' : 'Kopie'}</span>
                      <span className={`value min-w-0 truncate ${index === 0 ? 'text-ink' : 'text-prose'}`} title={file.path}>
                        {file.path}
                      </span>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

export function FolderPanel() {
  const { scan, dir, selected, anchor } = useFolder()
  const setPanel = useSession((state) => state.setPanel)
  const log = useSession((state) => state.log)
  const { ingest } = useIngestFiles()
  const merk = useMerkliste()
  const drive = useDrive((state) => driveLinked(state))
  const driveConfigured = useDrive((state) => state.configured)
  const fromDrive = scan?.source === 'drive'

  const [prefs, setPrefs] = useState<Preferences>(readPrefs)
  const [filter, setFilter] = useState<KindFilter>('alle')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [focusIndex, setFocusIndex] = useState(0)
  const scanning = useFolder((state) => state.scanning)
  const remembered = useFolder((state) => state.remembered)
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [dupes, setDupes] = useState<{ running: { done: number; total: number } | null; report: DuplicateReport | null; error: string | null } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<FolderFile[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [zipping, setZipping] = useState(false)
  /** Files on their way from Drive for the session or a ZIP. */
  const [fetchingFiles, setFetchingFiles] = useState<string | null>(null)
  /** Episodes in Drive being filed into a series' season. */
  const [filing, setFiling] = useState<FolderFile[] | null>(null)
  /** File currently open in the inline/modal preview. */
  const [previewFile, setPreviewFile] = useState<FolderFile | null>(null)
  const pickerRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const updatePrefs = (patch: Partial<Preferences>) =>
    setPrefs((current) => {
      const next = { ...current, ...patch }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        /* only a convenience */
      }
      return next
    })

  // Automatically load Drive or remembered folder when connected or already permitted.
  useEffect(() => {
    if (scan || scanning) return
    if (drive) {
      void readDriveFolder().catch(() => {})
      return
    }
    if (canPickFolder) {
      void lookUpRemembered().then(async (handle) => {
        if (handle && (await allowed(handle, 'read', false))) {
          void readFolder(handle).catch(() => {})
        }
      })
    }
  }, [scan, scanning, drive])

  useEffect(() => {
    setLimit(PAGE)
    setFocusIndex(0)
  }, [dir, filter, query, prefs.deep, prefs.sort, prefs.descending])

  const read = async (handle: DirectoryHandle) => {
    setProblem(null)
    setNote(null)
    setDupes(null)
    try {
      await readFolder(handle)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Der Ordner liess sich nicht lesen.')
    }
  }

  const choose = async () => {
    if (!canPickFolder) {
      pickerRef.current?.click()
      return
    }
    try {
      const handle = await pickFolder()
      if (handle) await read(handle)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Der Ordner liess sich nicht öffnen.')
    }
  }

  /** Sondra's folder in Drive. On the website the click may sign in first. */
  const chooseDrive = async () => {
    setProblem(null)
    setNote(null)
    setDupes(null)
    try {
      await readDriveFolder()
    } catch (error) {
      setProblem(error instanceof DriveError ? DRIVE_PROBLEM[error.code] : error instanceof Error ? error.message : 'Google Drive liess sich nicht lesen.')
    }
  }

  /** The files on this device, fetched from Drive first where they lie there. */
  const filesHere = async (files: FolderFile[]): Promise<File[] | null> => {
    if (files.every((file) => file.file)) return files.map((file) => file.file!)
    const total = files.reduce((sum, file) => sum + file.size, 0)
    let before = 0
    const out: File[] = []
    try {
      for (const file of files) {
        setFetchingFiles(`Lädt aus Drive … ${total ? Math.round((before / total) * 100) : 0} %`)
        out.push(
          await fileHere(file, (loaded) => setFetchingFiles(`Lädt aus Drive … ${total ? Math.round(((before + loaded) / total) * 100) : 0} %`)),
        )
        before += file.size
      }
      return out
    } catch (error) {
      setProblem(error instanceof DriveError ? DRIVE_PROBLEM[error.code] : error instanceof Error ? error.message : 'Aus Drive nicht geladen.')
      return null
    } finally {
      setFetchingFiles(null)
    }
  }

  const reopen = async (handle: DirectoryHandle) => {
    if (!(await allowed(handle, 'read', true))) {
      setProblem(`Für „${handle.name}“ hat der Browser den Zugriff nicht erlaubt. Wählen Sie den Ordner neu.`)
      return
    }
    await read(handle)
  }

  /* -- what is shown -------------------------------------------------------- */

  const view = useMemo(
    () =>
      scan
        ? listing(scan, { dir, deep: prefs.deep, filter, query, sort: prefs.sort, descending: prefs.descending })
        : { dirs: [], files: [], counts: { alle: 0, video: 0, audio: 0, image: 0, andere: 0 } },
    [scan, dir, prefs.deep, prefs.sort, prefs.descending, filter, query],
  )
  const shownFiles = view.files.slice(0, limit)
  const order = useMemo(() => view.files.map((file) => file.path), [view.files])
  const episodes = useMemo(() => {
    const map = new Map<string, FolderEpisode>()
    for (const file of shownFiles) {
      const found = episodeOf(file, merk)
      if (found) map.set(file.path, found)
    }
    return map
  }, [shownFiles, merk])
  const byPath = useMemo(() => new Map((scan?.files ?? []).map((file) => [file.path, file])), [scan])
  const chosen = useMemo(() => [...selected].map((path) => byPath.get(path)).filter((file): file is FolderFile => Boolean(file)), [selected, byPath])
  const chosenSize = chosen.reduce((sum, file) => sum + file.size, 0)
  const items = view.dirs.length + shownFiles.length

  const select = (next: Set<string>, nextAnchor: string | null) => useFolder.setState({ selected: next, anchor: nextAnchor })
  /**
   * A folder opens on one click, a file on two — so a double click on a
   * folder, out of habit, landed its second click on whatever took the
   * folder's place, and a film started playing. The rest of the double click
   * that changed the view is not counted; any click of its own is — a first
   * click ends the wait.
   */
  const movedAt = useRef(0)
  const settled = (event?: { detail?: number }) => {
    if ((event?.detail ?? 1) < 2) {
      movedAt.current = 0
      return true
    }
    return performance.now() - movedAt.current > 600
  }
  const goTo = (path: string) => {
    movedAt.current = performance.now()
    useFolder.setState({ dir: path })
    setQuery('')
  }

  /* -- what can be done ----------------------------------------------------- */

  const media = (files: FolderFile[]) => files.filter((file) => file.kind === 'video' || file.kind === 'audio')

  const play = (files: FolderFile[], replace: boolean) => playFiles(files, replace)

  const open = async (file: FolderFile) => {
    if (file.kind === 'video' || file.kind === 'audio') return play([file], false)
    const here = await filesHere([file])
    if (!here) return
    const count = await ingest(here, fromDrive ? 'aus Google Drive geöffnet' : 'aus dem Ordner geöffnet')
    if (count > 0 && file.kind === 'image') setPanel('images')
    else if (count > 0) setNote(`${file.name} ist jetzt in der Sitzung.`)
  }

  const intoSession = async (files: FolderFile[]) => {
    const here = await filesHere(files)
    if (!here) return
    const count = await ingest(here, fromDrive ? 'aus Google Drive geöffnet' : 'aus dem Ordner geöffnet')
    setNote(count > 0 ? `${count} ${count === 1 ? 'Datei' : 'Dateien'} in der Sitzung — oben rechts im Dateimenü.` : 'Keine davon lässt sich in der Sitzung bearbeiten.')
  }

  const saveZip = async (files: FolderFile[]) => {
    setZipping(true)
    try {
      const here = await filesHere(files)
      if (!here) return
      const entries = await Promise.all(here.map(async (file, index) => ({ name: files[index].path, data: new Uint8Array(await file.arrayBuffer()) })))
      saveBytes(createZip(uniqueEntryNames(entries)), `${scan?.name ?? 'ordner'}-auswahl.zip`, 'application/zip')
    } catch (error) {
      setProblem(error instanceof Error ? `ZIP nicht erstellt: ${error.message}` : 'ZIP nicht erstellt.')
    } finally {
      setZipping(false)
    }
  }

  const reallyDelete = async (files: FolderFile[]) => {
    if (!scan?.handle) return
    setDeleting(true)
    try {
      if (!(await allowed(scan.handle, 'readwrite', true))) {
        setProblem('Der Browser hat das Ändern des Ordners nicht erlaubt — es wurde nichts gelöscht.')
        return
      }
      const { deleted, failed } = await deleteFiles(files)
      const gone = new Set(deleted.map((file) => file.path))
      useFolder.setState((state) => ({
        scan: state.scan ? withoutFiles(state.scan, gone) : null,
        selected: new Set([...state.selected].filter((path) => !gone.has(path))),
      }))
      setDupes(null)
      log('ordner', `${deleted.length} ${deleted.length === 1 ? 'Datei' : 'Dateien'} gelöscht (${formatBytes(deleted.reduce((sum, file) => sum + file.size, 0))})`)
      if (failed.length > 0) setProblem(`${failed.length} nicht gelöscht: ${failed[0].file.name} — ${failed[0].reason}`)
      else setNote(`${deleted.length} ${deleted.length === 1 ? 'Datei' : 'Dateien'} gelöscht.`)
    } finally {
      setDeleting(false)
      setConfirmDelete(null)
    }
  }

  const runDuplicates = async () => {
    if (!scan) return
    const controller = new AbortController()
    abortRef.current = controller
    setDupes({ running: { done: 0, total: 0 }, report: null, error: null })
    try {
      const report = await findDuplicates(scan.files, {
        signal: controller.signal,
        onProgress: (done, total) => setDupes({ running: { done, total }, report: null, error: null }),
      })
      setDupes({ running: null, report, error: null })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') setDupes(null)
      else setDupes({ running: null, report: null, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /* -- keys ------------------------------------------------------------------- */

  const columns = useCallback(() => {
    const options = listRef.current?.querySelectorAll<HTMLElement>('[role=option]')
    if (!options || options.length === 0) return 1
    const top = options[0].offsetTop
    let count = 0
    for (const option of options) {
      if (option.offsetTop !== top) break
      count += 1
    }
    return Math.max(1, count)
  }, [])

  const fileAt = (index: number) => (index >= view.dirs.length ? shownFiles[index - view.dirs.length] : null)

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (items === 0) return
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }[event.key]
    if (step !== undefined) {
      event.preventDefault()
      const next = Math.min(items - 1, Math.max(0, focusIndex + (prefs.view === 'liste' && Math.abs(step) !== 1 ? Math.sign(step) : step)))
      setFocusIndex(next)
      const file = fileAt(next)
      if (event.shiftKey && file) select(clickSelect(selected, order, anchor ?? file.path, file.path, { toggle: false, range: true }).selected, anchor ?? file.path)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setFocusIndex(event.key === 'Home' ? 0 : items - 1)
      return
    }
    if (event.key === ' ') {
      event.preventDefault()
      const file = fileAt(focusIndex)
      if (file) select(clickSelect(selected, order, anchor, file.path, { toggle: true, range: event.shiftKey }).selected, file.path)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const file = fileAt(focusIndex)
      if (file) void open(file)
      else if (view.dirs[focusIndex]) goTo(view.dirs[focusIndex].path)
      return
    }
    if ((event.key === 'a' || event.key === 'A') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      select(new Set(order), order[0] ?? null)
      return
    }
    if (event.key === 'Escape' && selected.size > 0) {
      event.preventDefault()
      event.stopPropagation()
      select(new Set(), null)
      return
    }
    if (event.key === 'Backspace' && dir) {
      event.preventDefault()
      goTo(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')
    }
  }

  /* -- before a folder ---------------------------------------------------------- */

  const fallbackInput = (
    <input
      ref={pickerRef}
      type="file"
      multiple
      hidden
      {...{ webkitdirectory: '' }}
      onChange={(event) => {
        const list = event.target.files
        if (list && list.length > 0) takeFileList(list)
        event.target.value = ''
      }}
    />
  )

  if (!scan) {
    return (
      <div className="flex flex-col gap-[20px]">
        {fallbackInput}
        <div className="flex max-w-[640px] flex-col items-start gap-[14px]">
          <h2 className="m-0 text-subheading font-semibold text-ink">Ihre Dateien, aus einem Ordner</h2>
          <p className="text-body leading-[1.55] text-prose">
            Wählen Sie einen Ordner auf diesem Gerät. Sondra zeigt, was darin liegt — Filme und Fotos mit Vorschaubild, Folgen Ihrer
            Merkliste mit Staffel und Folge — und Sie wählen aus, was abgespielt, bearbeitet oder gespeichert wird. Gelesen wird nur, was Sie
            ansehen; gesendet wird nichts.
            {driveConfigured
              ? ' Oder den Ordner „Sondra“ in Ihrem Google Drive: von dort abspielen, und was Sie schauen, hakt die Merkliste ab.'
              : ''}
          </p>
          {scanning ? (
            <div role="status" className="flex flex-wrap items-center gap-x-[14px] gap-y-[6px] text-small text-prose">
              <span>
                Liest den Ordner … <span className="value">{scanning.files}</span> Dateien
              </span>
              <button type="button" onClick={stopReading} className={`${linkClass} text-small`}>
                Abbrechen
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-[10px]">
              <Button type="button" onClick={() => void choose()}>
                <FolderGlyph className="h-[18px] w-[18px]" />
                Ordner wählen
              </Button>
              {remembered ? (
                <Button type="button" variant="quiet" onClick={() => void reopen(remembered)}>
                  „{remembered.name}“ wieder öffnen
                </Button>
              ) : null}
              {driveConfigured ? (
                <Button type="button" variant="quiet" onClick={() => void chooseDrive()}>
                  <DriveIcon />
                  Aus Google Drive
                </Button>
              ) : null}
            </div>
          )}
          {!canPickFolder ? (
            <p className="text-small leading-[1.5] text-prose">
              In diesem Browser liest Sondra den Ordner einmal ein. Ihn beim nächsten Mal mit einem Klick wieder öffnen und Dateien darin
              löschen geht in Edge, Chrome und der Sondra-App.
            </p>
          ) : null}
          {problem ? (
            <Notice tone="error" title="Hat nicht geklappt">
              {problem}
            </Notice>
          ) : null}
        </div>
      </div>
    )
  }

  /* -- with a folder ---------------------------------------------------------------- */

  const steps = crumbs(scan.name, dir)
  const selectedMedia = media(chosen)
  const empty = view.dirs.length === 0 && view.files.length === 0

  return (
    <div className="flex flex-col gap-[18px]">
      {fallbackInput}

      {/* Where we are, and the folder itself. */}
      <div className="flex flex-wrap items-center justify-between gap-x-[20px] gap-y-[8px]">
        <nav aria-label="Ordnerpfad" className="flex min-w-0 flex-wrap items-center gap-x-[6px] gap-y-[2px]">
          {steps.map((step, index) => (
            <span key={step.path} className="flex items-center gap-[6px]">
              {index > 0 ? (
                <span aria-hidden className="text-prose">
                  /
                </span>
              ) : null}
              {index === steps.length - 1 ? (
                <h2 aria-current="page" className="m-0 flex items-center gap-[8px] text-subheading font-semibold text-ink">
                  {index === 0 ? fromDrive ? <DriveIcon className="h-[22px] w-[22px]" /> : <FolderGlyph className="h-[22px] w-[22px]" /> : null}
                  {step.label}
                </h2>
              ) : (
                <button type="button" onClick={() => goTo(step.path)} className={`${linkClass} text-body`}>
                  {index === 0 ? fromDrive ? <DriveIcon className="h-[18px] w-[18px]" /> : <FolderGlyph className="h-[18px] w-[18px]" /> : null}
                  {step.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <span className="flex flex-wrap items-center gap-x-[16px] gap-y-[4px] text-small">
          <span className="value text-prose">
            {scan.files.length} Dateien{scan.truncated ? ' (gekürzt)' : ''}
          </span>
          {scan.handle || fromDrive ? (
            <button
              type="button"
              onClick={() => void (fromDrive ? chooseDrive() : reopen(scan.handle!))}
              disabled={Boolean(scanning)}
              className={`${linkClass} text-small`}
            >
              {scanning ? `Liest … ${scanning.files}` : 'Neu einlesen'}
            </button>
          ) : null}
          <button type="button" onClick={() => void choose()} className={`${linkClass} text-small`}>
            {fromDrive ? 'Ordner auf diesem Gerät' : 'Anderer Ordner'}
          </button>
          {driveConfigured && !fromDrive ? (
            <button type="button" onClick={() => void chooseDrive()} className={`${linkClass} text-small`}>
              Google Drive
            </button>
          ) : null}
        </span>
      </div>

      {fromDrive ? (
        <p className="max-w-[72ch] text-small leading-[1.5] text-prose">
          Der Ordner „Sondra“ in Ihrem Google Drive. Sondra sieht dort nur, was es selbst abgelegt hat — Heruntergeladenes, Dateien,
          Projekte. Filme spielen direkt aus Drive; was Sie zu Ende schauen, hakt die Merkliste ab.
        </p>
      ) : null}

      {scan.truncated ? (
        <Notice tone="warn" title="Sehr grosser Ordner">
          Sondra hat die ersten {scan.files.length} Dateien gelesen und dann aufgehört. Ein Unterordner davon ist schneller.
        </Notice>
      ) : null}

      {dir === '' && !query ? <ContinueRow files={scan.files} onPlay={(queue) => play(queue.map((entry) => entry.file), true)} /> : null}

      {/* Find, show, order. */}
      <div className="flex flex-col gap-[10px] border-t border-line pt-[14px]">
        <div className="flex flex-wrap items-center gap-[8px]">
          <div role="radiogroup" aria-label="Art" className="flex flex-wrap gap-[6px]">
            {FILTERS.map((entry) => {
              const on = filter === entry.id
              const count = view.counts[entry.id]
              if (entry.id !== 'alle' && count === 0 && !on) return null
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setFilter(entry.id)}
                  className={`press rounded-pill px-[12px] py-[6px] text-small font-medium transition-colors duration-[var(--dur-fast)] ${
                    on ? 'bg-ink font-semibold text-on-ink' : 'bg-panel-soft text-prose ring-1 ring-inset ring-line hover:bg-panel-mid hover:text-ink'
                  }`}
                >
                  {entry.label} <span className="value">{count}</span>
                </button>
              )
            })}
          </div>
          <span className="flex-1" />
          <label className="relative flex w-full items-center sm:w-[240px]">
            <svg viewBox="0 0 16 16" aria-hidden className="pointer-events-none absolute left-[12px] h-4 w-4 text-prose" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.4 10.4L14 14" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Im Ordner suchen…"
              aria-label="Dateinamen im Ordner und seinen Unterordnern durchsuchen"
              className="w-full rounded-pill border-0 bg-panel-soft py-[7px] pl-[34px] pr-[14px] text-small text-ink outline-none ring-1 ring-inset ring-line placeholder:text-prose hover:bg-panel-mid focus:bg-raised focus:ring-2 focus:ring-ink"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px] text-small">
          <label className="flex items-center gap-[6px] text-prose">
            Sortieren
            <select
              value={prefs.sort}
              onChange={(event) => updatePrefs({ sort: event.target.value as SortKey })}
              className="sondra-select cursor-pointer appearance-none rounded-nav bg-raised py-[5px] pl-[10px] pr-[28px] text-small text-ink outline-none ring-1 ring-inset ring-line focus:ring-ink"
            >
              {SORTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => updatePrefs({ descending: !prefs.descending })}
            aria-label={prefs.descending ? 'Absteigend — umkehren' : 'Aufsteigend — umkehren'}
            title={prefs.descending ? 'Absteigend' : 'Aufsteigend'}
            className="press grid h-[30px] w-[30px] place-items-center rounded-nav text-ink ring-1 ring-inset ring-line hover:bg-panel-soft"
          >
            <svg viewBox="0 0 16 16" className={`h-4 w-4 transition-transform ${prefs.descending ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 3v10M4.5 9.5L8 13l3.5-3.5" />
            </svg>
          </button>
          <div role="radiogroup" aria-label="Ansicht" className="flex rounded-pill bg-panel-soft p-[2px] ring-1 ring-inset ring-line">
            {(['kacheln', 'liste'] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                role="radio"
                aria-checked={prefs.view === entry}
                onClick={() => updatePrefs({ view: entry })}
                className={`press rounded-pill px-[12px] py-[4px] text-small ${prefs.view === entry ? 'bg-ink font-semibold text-on-ink' : 'text-prose hover:text-ink'}`}
              >
                {entry === 'kacheln' ? 'Kacheln' : 'Liste'}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-[8px] text-prose">
            <input type="checkbox" checked={prefs.deep} onChange={(event) => updatePrefs({ deep: event.target.checked })} className="h-[16px] w-[16px] accent-[var(--color-ink)]" />
            Mit Unterordnern
          </label>
          <span className="flex-1" />
          {!dupes && !fromDrive ? (
            <button type="button" onClick={() => void runDuplicates()} className={`${linkClass} text-small`}>
              Doppelte finden
            </button>
          ) : null}
        </div>
      </div>

      {dupes ? (
        <DuplicatesSection
          state={dupes}
          onCancel={() => abortRef.current?.abort()}
          onClose={() => setDupes(null)}
          onSelect={() => {
            const copies = dupes.report ? copiesOf(dupes.report) : []
            // Shown wherever they are: all files, every subfolder.
            setFilter('alle')
            setQuery('')
            updatePrefs({ deep: true })
            useFolder.setState({ dir: '', selected: new Set(copies.map((file) => file.path)), anchor: copies[0]?.path ?? null })
          }}
        />
      ) : null}

      {note ? (
        <p role="status" className="text-small text-prose">
          {note}
        </p>
      ) : null}
      {problem ? (
        <Notice tone="error" title="Hat nicht geklappt">
          {problem}
        </Notice>
      ) : null}

      {dir !== '' ? (
        <div className="flex flex-wrap items-center justify-between gap-[8px] border-b border-line pb-[8px]">
          <button
            type="button"
            onClick={() => {
              const parentDir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
              goTo(parentDir)
            }}
            className={`${linkClass} inline-flex items-center gap-[6px] text-small font-medium`}
          >
            ← Zurück zu {steps.at(-2)?.label ?? scan.name}
          </button>
          <span className="value text-micro text-prose">
            {view.dirs.length > 0 ? `${view.dirs.length} Ordner · ` : ''}
            {view.files.length} {view.files.length === 1 ? 'Datei' : 'Dateien'}
          </span>
        </div>
      ) : null}

      {/* The files. */}
      {empty ? (
        <div className="flex flex-col items-start gap-[8px] border-t border-line pt-[16px]">
          <p className="text-body text-prose">
            {query
              ? `Keine Datei heisst wie „${query}“.`
              : filter !== 'alle'
                ? `Hier ist keine Datei der Art „${FILTERS.find((entry) => entry.id === filter)?.label}“.`
                : 'Dieser Ordner ist leer.'}
          </p>
          {query || filter !== 'alle' ? (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setFilter('alle')
              }}
              className={`${linkClass} text-small`}
            >
              Alles zeigen
            </button>
          ) : null}
        </div>
      ) : (
        <div
          className={
            chosen.length === 1 && view.files.some((f) => f.path === chosen[0].path)
              ? 'grid grid-cols-1 items-start gap-[16px] xl:grid-cols-[minmax(0,1fr)_340px]'
              : 'flex flex-col'
          }
        >
          <div
            ref={listRef}
            role="listbox"
            aria-multiselectable
            aria-label={`Dateien in ${steps.at(-1)?.label ?? scan.name}`}
            onKeyDown={onKey}
            className={
              prefs.view === 'kacheln'
                ? 'flex flex-col gap-[18px]'
                : 'flex flex-col overflow-hidden rounded-card ring-1 ring-inset ring-line'
            }
          >
            {prefs.view === 'kacheln' ? (
              <>
                {view.dirs.length > 0 ? (
                  <div className="flex flex-col gap-[8px]">
                    {shownFiles.length > 0 ? (
                      <div className="flex items-baseline justify-between">
                        <span className="text-small font-semibold text-ink">Ordner</span>
                        <span className="value text-micro text-prose">{view.dirs.length}</span>
                      </div>
                    ) : null}
                    <div
                      className={
                        chosen.length === 1 && view.files.some((f) => f.path === chosen[0].path)
                          ? 'grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-3'
                          : 'grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                      }
                    >
                      {view.dirs.map((entry, index) => (
                        <DirTile
                          key={entry.path}
                          name={entry.name}
                          count={entry.count}
                          size={entry.size}
                          list={false}
                          focused={focusIndex === index}
                          onFocus={() => setFocusIndex(index)}
                          onOpen={(event?: ReactMouseEvent) => {
                            if (settled(event)) goTo(entry.path)
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}

                {shownFiles.length > 0 ? (
                  <div className="flex flex-col gap-[8px]">
                    {view.dirs.length > 0 ? (
                      <div className="flex items-baseline justify-between">
                        <span className="text-small font-semibold text-ink">Dateien</span>
                        <span className="value text-micro text-prose">{view.files.length}</span>
                      </div>
                    ) : null}
                    <div
                      className={
                        chosen.length === 1 && view.files.some((f) => f.path === chosen[0].path)
                          ? 'grid grid-cols-2 gap-[12px] sm:grid-cols-3 lg:grid-cols-4'
                          : 'grid grid-cols-2 gap-[12px] sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
                      }
                    >
                      {shownFiles.map((file, at) => {
                        const index = view.dirs.length + at
                        return (
                          <FileItem
                            key={file.path}
                            file={file}
                            list={false}
                            selected={selected.has(file.path)}
                            episode={episodes.get(file.path) ?? null}
                            focused={focusIndex === index}
                            onFocus={() => setFocusIndex(index)}
                            onClick={(event) => {
                              if (!settled(event)) return
                              const next = clickSelect(selected, order, anchor, file.path, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })
                              select(next.selected, next.anchor)
                            }}
                            onToggle={() => select(clickSelect(selected, order, anchor, file.path, { toggle: true, range: false }).selected, file.path)}
                            onOpen={(event?: ReactMouseEvent) => {
                              if (settled(event)) void open(file)
                            }}
                          />
                        )
                      })}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div
                  aria-hidden
                  className="hidden grid-cols-[28px_minmax(0,1fr)_90px_90px_90px_80px] items-center gap-[10px] bg-panel-soft px-[10px] py-[7px] text-micro font-semibold text-prose sm:grid"
                >
                  <span />
                  <span>Name</span>
                  <span>Art</span>
                  <span>Grösse</span>
                  <span>Geändert</span>
                  <span className="text-right">Dauer</span>
                </div>
                {view.dirs.map((entry, index) => (
                  <DirTile
                    key={entry.path}
                    name={entry.name}
                    count={entry.count}
                    size={entry.size}
                    list
                    focused={focusIndex === index}
                    onFocus={() => setFocusIndex(index)}
                    onOpen={(event?: ReactMouseEvent) => {
                      if (settled(event)) goTo(entry.path)
                    }}
                  />
                ))}
                {shownFiles.map((file, at) => {
                  const index = view.dirs.length + at
                  return (
                    <FileItem
                      key={file.path}
                      file={file}
                      list
                      selected={selected.has(file.path)}
                      episode={episodes.get(file.path) ?? null}
                      focused={focusIndex === index}
                      onFocus={() => setFocusIndex(index)}
                      onClick={(event) => {
                        if (!settled(event)) return
                        const next = clickSelect(selected, order, anchor, file.path, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })
                        select(next.selected, next.anchor)
                      }}
                      onToggle={() => select(clickSelect(selected, order, anchor, file.path, { toggle: true, range: false }).selected, file.path)}
                      onOpen={(event?: ReactMouseEvent) => {
                        if (settled(event)) void open(file)
                      }}
                    />
                  )
                })}
              </>
            )}
          </div>

          {chosen.length === 1 && view.files.some((f) => f.path === chosen[0].path) ? (
            <FolderInlinePreview
              file={chosen[0]}
              episode={episodes.get(chosen[0].path) ?? null}
              onExpand={() => setPreviewFile(chosen[0])}
              onPlay={() => play([chosen[0]], true)}
              onTakeIntoSession={() => void intoSession([chosen[0]])}
            />
          ) : null}
        </div>
      )}
      {view.files.length > limit ? (
        <button type="button" onClick={() => setLimit((value) => value + PAGE)} className={`${linkClass} self-start text-small`}>
          Weitere {Math.min(PAGE, view.files.length - limit)} von {view.files.length - limit} zeigen
        </button>
      ) : null}
      {!empty ? (
        <p className="text-small text-prose">
          Klick wählt, Strg oder ⌘ dazu, Umschalt einen Bereich; Doppelklick oder Enter öffnet. Pfeiltasten und Leertaste gehen auch.
        </p>
      ) : null}

      {/* What is selected, and what can be done with it. */}
      {chosen.length > 0 ? (
        <div
          role="region"
          aria-label="Auswahl"
          className="rise elevate-lift sticky bottom-[12px] z-20 flex flex-wrap items-center gap-x-[12px] gap-y-[8px] rounded-card bg-raised px-[14px] py-[10px] ring-1 ring-inset ring-rule"
        >
          <span className="text-small text-ink">
            <span className="font-semibold">{chosen.length} ausgewählt</span> · <span className="value">{formatBytes(chosenSize)}</span>
          </span>
          <span className="flex-1" />
          {chosen.length === 1 && (chosen[0].kind === 'video' || chosen[0].kind === 'audio' || chosen[0].kind === 'image') ? (
            <Button type="button" size="sm" variant="quiet" onClick={() => setPreviewFile(chosen[0])}>
              Vorschau
            </Button>
          ) : null}
          {selectedMedia.length > 0 ? (
            <Button type="button" size="sm" onClick={() => play(chosen, true)}>
              Abspielen{selectedMedia.length < chosen.length ? ` (${selectedMedia.length})` : ''}
            </Button>
          ) : null}
          {fromDrive && selectedMedia.length > 0 ? (
            <Button type="button" size="sm" variant="quiet" onClick={() => setFiling(selectedMedia)}>
              In Staffel einordnen{selectedMedia.length < chosen.length ? ` (${selectedMedia.length})` : ''}
            </Button>
          ) : null}
          {fetchingFiles ? (
            <span role="status" className="value text-small text-prose">
              {fetchingFiles}
            </span>
          ) : null}
          <Button type="button" size="sm" variant="quiet" disabled={Boolean(fetchingFiles)} onClick={() => void intoSession(chosen)}>
            In die Sitzung
          </Button>
          <Button type="button" size="sm" variant="quiet" disabled={zipping || Boolean(fetchingFiles)} onClick={() => void saveZip(chosen)}>
            {zipping ? 'Packt …' : 'Als ZIP'}
          </Button>
          {drive && !fromDrive ? (
            <Button
              type="button"
              size="sm"
              variant="quiet"
              onClick={() => saveFilesToDrive(chosen.flatMap((file) => (file.file ? [{ file: file.file, kind: file.kind }] : [])))}
            >
              In Drive
            </Button>
          ) : null}
          {scan.handle ? (
            <Button type="button" size="sm" variant="quiet" onClick={() => setConfirmDelete(chosen)}>
              Löschen …
            </Button>
          ) : null}
          <button type="button" onClick={() => select(new Set(), null)} className={`${linkClass} text-small`}>
            Auswahl aufheben
          </button>
        </div>
      ) : null}

      {filing ? (
        <SeasonFilingDialog
          files={filing}
          onClose={() => setFiling(null)}
          onFiled={(where, count, path) => {
            setFiling(null)
            setNote(`${count} ${count === 1 ? 'Folge' : 'Folgen'} in ${where}.`)
            // Read again, and show the season's folder with what went there.
            void readDriveFolder().then(() => {
              useFolder.setState({ dir: path, selected: new Set(), anchor: null })
              setNote(`${count} ${count === 1 ? 'Folge' : 'Folgen'} in ${where}.`)
            }, () => undefined)
          }}
        />
      ) : null}

      {confirmDelete ? (
        <DeleteDialog files={confirmDelete} busy={deleting} onCancel={() => setConfirmDelete(null)} onConfirm={() => void reallyDelete(confirmDelete)} />
      ) : null}

      {previewFile ? (
        <FolderPreviewDialog
          file={previewFile}
          episode={episodes.get(previewFile.path) ?? null}
          files={shownFiles}
          onSelectFile={setPreviewFile}
          onClose={() => setPreviewFile(null)}
          onPlayInPlayer={(f) => {
            setPreviewFile(null)
            play([f], true)
          }}
          onTakeIntoSession={(f) => {
            setPreviewFile(null)
            void intoSession([f])
          }}
        />
      ) : null}
    </div>
  )
}

function FolderInlinePreview({
  file,
  episode,
  onExpand,
  onPlay,
  onTakeIntoSession,
}: {
  file: FolderFile
  episode: FolderEpisode | null
  onExpand: () => void
  onPlay: () => void
  onTakeIntoSession: () => void
}): ReactNode {
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let revoked: string | null = null
    let cancelled = false
    setMediaUrl(null)

    if (file.file) {
      const u = URL.createObjectURL(file.file)
      revoked = u
      setMediaUrl(u)
      setLoading(false)
      return () => {
        if (revoked) URL.revokeObjectURL(revoked)
      }
    }

    if (file.drive && (file.kind === 'video' || file.kind === 'audio' || file.kind === 'image')) {
      setLoading(true)
      void (async () => {
        try {
          if (file.kind === 'video' || file.kind === 'audio') {
            const streamUrl = await driveMediaUrl({
              id: file.drive!.id,
              size: file.size,
              type: file.drive!.mime,
            })
            if (cancelled) return
            if (streamUrl) {
              setMediaUrl(streamUrl)
              setLoading(false)
              return
            }
          }
          const fetched = await fileHere(file)
          if (cancelled) return
          const u = URL.createObjectURL(fetched)
          revoked = u
          setMediaUrl(u)
        } catch {
          // Fallback to cover or icon if inline preview cannot be loaded
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    }

    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [file])

  const canPreviewModal = file.kind === 'video' || file.kind === 'audio' || file.kind === 'image'

  return (
    <aside
      aria-label="Dateivorschau"
      className="sticky top-[16px] flex flex-col gap-[12px] rounded-card bg-panel-mid p-[14px] ring-1 ring-inset ring-line"
    >
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-nav bg-stage ring-1 ring-inset ring-line">
        {loading ? (
          <span className="text-small text-prose">Lädt Vorschau …</span>
        ) : mediaUrl && file.kind === 'video' ? (
          <video
            key={mediaUrl}
            src={mediaUrl}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full bg-black object-contain"
          />
        ) : mediaUrl && file.kind === 'image' ? (
          <img src={mediaUrl} alt={file.name} className="h-full w-full object-contain" />
        ) : mediaUrl && file.kind === 'audio' ? (
          <div className="flex w-full flex-col items-center gap-[10px] px-[12px]">
            <KindGlyph kind="audio" className="h-[36px] w-[36px] text-ink" />
            <audio key={mediaUrl} src={mediaUrl} controls preload="metadata" className="w-full" />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-[6px] text-ink">
            <KindGlyph kind={file.kind} className="h-[36px] w-[36px]" />
            <span className="value text-micro uppercase tracking-wider text-prose">
              {extensionOf(file.name) || KIND_LABEL[file.kind]}
            </span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-[4px]">
        <p className="m-0 break-words text-body font-semibold leading-[1.3] text-ink">{file.name}</p>
        <p className="value m-0 truncate text-micro text-prose" title={file.path}>
          {file.path}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-[10px] gap-y-[6px] border-t border-line pt-[10px] text-small">
        <div>
          <dt className="text-micro text-prose">Art</dt>
          <dd className="m-0 font-medium text-ink">
            {KIND_LABEL[file.kind]} ({extensionOf(file.name)})
          </dd>
        </div>
        <div>
          <dt className="text-micro text-prose">Grösse</dt>
          <dd className="value m-0 font-medium text-ink">{formatBytes(file.size)}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-micro text-prose">Geändert</dt>
          <dd className="value m-0 text-ink">{dateOf(file.modified)}</dd>
        </div>
      </dl>

      {episode ? (
        <div className="flex items-center justify-between border-t border-line pt-[10px] text-small">
          <span className="text-prose">Merkliste</span>
          <EpisodeMark episode={episode} />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-[8px] border-t border-line pt-[10px]">
        {file.kind === 'video' || file.kind === 'audio' ? (
          <Button type="button" size="sm" onClick={onPlay}>
            Abspielen
          </Button>
        ) : null}
        {canPreviewModal ? (
          <Button type="button" size="sm" variant="quiet" onClick={onExpand}>
            Große Vorschau
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="quiet" onClick={onTakeIntoSession}>
          In die Sitzung
        </Button>
      </div>
    </aside>
  )
}

function FolderPreviewDialog({
  file,
  episode,
  files,
  onSelectFile,
  onClose,
  onPlayInPlayer,
  onTakeIntoSession,
}: {
  file: FolderFile
  episode: FolderEpisode | null
  files: FolderFile[]
  onSelectFile: (next: FolderFile) => void
  onClose: () => void
  onPlayInPlayer: (file: FolderFile) => void
  onTakeIntoSession: (file: FolderFile) => void
}): ReactNode {
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const previewableList = useMemo(
    () => files.filter((f) => f.kind === 'video' || f.kind === 'audio' || f.kind === 'image'),
    [files],
  )
  const currentIdx = previewableList.findIndex((f) => f.path === file.path)
  const prevFile = currentIdx > 0 ? previewableList[currentIdx - 1] : null
  const nextFile = currentIdx >= 0 && currentIdx + 1 < previewableList.length ? previewableList[currentIdx + 1] : null

  useEffect(() => {
    let revoked: string | null = null
    let cancelled = false
    setMediaUrl(null)
    setErr(null)

    if (file.file) {
      const u = URL.createObjectURL(file.file)
      revoked = u
      setMediaUrl(u)
      setLoading(false)
      return () => {
        if (revoked) URL.revokeObjectURL(revoked)
      }
    }

    if (file.drive) {
      setLoading(true)
      void (async () => {
        try {
          if (file.kind === 'video' || file.kind === 'audio') {
            const streamUrl = await driveMediaUrl({
              id: file.drive!.id,
              size: file.size,
              type: file.drive!.mime,
            })
            if (cancelled) return
            if (streamUrl) {
              setMediaUrl(streamUrl)
              setLoading(false)
              return
            }
          }
          const fetched = await fileHere(file)
          if (cancelled) return
          const u = URL.createObjectURL(fetched)
          revoked = u
          setMediaUrl(u)
        } catch (e) {
          if (!cancelled) setErr(e instanceof Error ? e.message : 'Vorschau konnte nicht geladen werden.')
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    }

    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [file])

  return (
    <Dialog open onClose={onClose} title={`Vorschau: ${file.name}`} size="lg">
      <div className="flex flex-col gap-[14px]">
        <div className="flex flex-wrap items-center justify-between gap-[8px] text-small text-prose">
          <span className="truncate" title={file.path}>
            {KIND_LABEL[file.kind]} · <span className="value">{formatBytes(file.size)}</span> · {dateOf(file.modified)}
          </span>
          {episode ? <EpisodeMark episode={episode} /> : null}
        </div>

        <div className="relative flex min-h-[240px] items-center justify-center overflow-hidden rounded-card bg-stage p-[8px] ring-1 ring-inset ring-line">
          {loading ? (
            <p className="text-small text-prose">Vorschau wird geladen …</p>
          ) : err ? (
            <p className="text-small text-danger">{err}</p>
          ) : mediaUrl ? (
            file.kind === 'video' ? (
              <video
                key={mediaUrl}
                src={mediaUrl}
                controls
                autoPlay
                playsInline
                className="max-h-[60vh] w-full rounded-nav bg-black object-contain"
              />
            ) : file.kind === 'audio' ? (
              <div className="flex w-full flex-col items-center gap-[12px] py-[28px]">
                <KindGlyph kind="audio" className="h-[44px] w-[44px] text-ink" />
                <audio key={mediaUrl} src={mediaUrl} controls autoPlay className="w-full max-w-[440px]" />
              </div>
            ) : file.kind === 'image' ? (
              <img src={mediaUrl} alt={file.name} className="max-h-[60vh] max-w-full rounded-nav object-contain" />
            ) : null
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-[8px]">
          <div className="flex items-center gap-[6px]">
            <Button type="button" size="sm" variant="quiet" disabled={!prevFile} onClick={() => prevFile && onSelectFile(prevFile)}>
              ← Vorherige
            </Button>
            <Button type="button" size="sm" variant="quiet" disabled={!nextFile} onClick={() => nextFile && onSelectFile(nextFile)}>
              Nächste →
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-[8px]">
            {file.kind === 'video' || file.kind === 'audio' ? (
              <Button type="button" size="sm" onClick={() => onPlayInPlayer(file)}>
                Im Player öffnen
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="quiet" onClick={() => onTakeIntoSession(file)}>
              In die Sitzung übernehmen
            </Button>
            <Button type="button" size="sm" variant="quiet" onClick={onClose}>
              Schliessen
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

function DeleteDialog({ files, busy, onCancel, onConfirm }: { files: FolderFile[]; busy: boolean; onCancel: () => void; onConfirm: () => void }): ReactNode {
  const total = files.reduce((sum, file) => sum + file.size, 0)
  return (
    <Dialog open onClose={busy ? () => undefined : onCancel} title={files.length === 1 ? 'Datei löschen?' : `${files.length} Dateien löschen?`} size="md">
      <div className="flex flex-col gap-[16px]">
        <p className="text-body leading-[1.55] text-prose">
          {files.length === 1 ? 'Sie wird' : 'Sie werden'} endgültig aus dem Ordner gelöscht —{' '}
          <span className="font-semibold text-ink">nicht in den Papierkorb</span>. Zusammen <span className="value">{formatBytes(total)}</span>.
        </p>
        <ul className="flex max-h-[240px] flex-col overflow-y-auto">
          {files.slice(0, 12).map((file) => (
            <li key={file.path} className="value truncate border-t border-line py-[5px] text-small text-ink first:border-t-0" title={file.path}>
              {file.path}
            </li>
          ))}
          {files.length > 12 ? <li className="border-t border-line py-[5px] text-small text-prose">und {files.length - 12} weitere</li> : null}
        </ul>
        <div className="flex flex-wrap items-center gap-[10px]">
          <Button type="button" disabled={busy} onClick={onConfirm}>
            {busy ? 'Löscht …' : 'Endgültig löschen'}
          </Button>
          <Button type="button" variant="quiet" disabled={busy} onClick={onCancel}>
            Abbrechen
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
