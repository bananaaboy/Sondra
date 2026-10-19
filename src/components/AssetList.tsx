/**
 * The session, as one control in the header.
 *
 * It used to be three things on every screen: a tinted strip under the header
 * („1 Datei im Arbeitsspeicher dieses Tabs …"), a right-hand column in each
 * tool with a player, fifteen buttons under „Damit geht" and the file list,
 * and a „Weitere Datei" button in the header. The fifteen buttons repeated the
 * tab bar; the strip repeated the chip; the column took a third of the width
 * from the tool. Together they were most of what made the page feel crowded.
 *
 * Now the header names the file that is being worked on, and everything about
 * the session — switching, playing, saving, removing, adding, freeing the
 * memory — is one click behind that name. Nothing that could be done before
 * is gone; it is just not all standing on the page at once.
 */

import { useEffect, useRef, useState } from 'react'

import { saveBytes } from '../lib/download'
import { startFileDragOut } from '../lib/dragOut'
import { formatBytes, formatDuration } from '../lib/format'
import { saveProjectFile } from '../lib/project'
import { useDecodedAudio } from '../hooks/useDecodedAudio'
import { useFilePicker, useProjectPicker } from '../hooks/useIngest'
import { useKept } from '../hooks/useKeptSession'
import { useActiveAsset, useSession } from '../state/store'
import { AudioPreview } from './AudioPreview'
import { Badge, Toggle } from './ui/primitives'
import { createZip, uniqueEntryNames } from '../lib/zip'
import { ZipSave } from './ZipSave'

/** Sondra's own 5-bar mark, rendered inside `.sondra` project actions. */
export function SondraProjectIcon({ className = 'h-3.5 w-3.5 shrink-0' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`fill-current ${className}`} aria-hidden>
      <rect x="9" y="5.35" width="13.99" height="3.3" rx="1.65" />
      <rect x="7.73" y="9.85" width="20.95" height="3.3" rx="1.65" />
      <rect x="4.6" y="14.35" width="22.8" height="3.3" rx="1.65" />
      <rect x="3.33" y="18.85" width="20.95" height="3.3" rx="1.65" />
      <rect x="9" y="23.35" width="13.99" height="3.3" rx="1.65" />
    </svg>
  )
}

/** Playback of the selected file, decoded only once the menu is open. */
function SelectedPlayer() {
  const selected = useActiveAsset()
  // Decoding a PNG as audio is a guaranteed failure and a pointless wait.
  const asset = selected && (selected.kind === 'audio' || selected.kind === 'video') ? selected : null
  const { audio, decode, status } = useDecodedAudio(asset)

  useEffect(() => {
    if (asset && !audio && status === 'idle') void decode()
  }, [asset, audio, status, decode])

  if (!asset) return null
  if (!audio) {
    return (
      <p className="text-small text-muted">
        {status === 'error' ? 'Diese Datei lässt sich nicht abspielen.' : 'Wird für die Wiedergabe vorbereitet…'}
      </p>
    )
  }
  return <AudioPreview sources={[{ id: asset.id, label: asset.name, audio }]} waveHeight={32} />
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden>
      <path
        d="M4 1.8h5.2L12.5 5v9.2H4z M9 1.8V5h3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="press flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-nav text-muted transition-colors hover:text-ink"
    >
      {children}
    </button>
  )
}

export function SessionMenu() {
  const assets = useSession((state) => state.assets)
  const activeId = useSession((state) => state.activeAssetId)
  const setActive = useSession((state) => state.setActiveAsset)
  const removeAsset = useSession((state) => state.removeAsset)
  const reorderAssets = useSession((state) => state.reorderAssets)
  const clearAssets = useSession((state) => state.clearAssets)
  const active = useActiveAsset()
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const picker = useFilePicker('geöffnet')
  const projectPicker = useProjectPicker()
  const keep = useKept((state) => state.keep)
  const saving = useKept((state) => state.saving)
  const setKeep = useKept((state) => state.setKeep)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  /**
   * A file just arrived — from a download, an editor's „In die Sitzung", a
   * bounce. The menu blinks and a short note says which, so the answer to
   * „did it work?" appears where the file now is, on whichever tab.
   */
  const [arrived, setArrived] = useState<string | null>(null)
  const knownCount = useRef(assets.length)
  useEffect(() => {
    const before = knownCount.current
    knownCount.current = assets.length
    if (assets.length <= before) return
    const newest = assets[assets.length - 1]
    setArrived(newest?.name ?? '')
    const timer = window.setTimeout(() => setArrived(null), 2400)
    return () => window.clearTimeout(timer)
  }, [assets])

  // Closes on a click anywhere else and on Escape, like every other popover.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // An emptied session has nothing to show.
  useEffect(() => {
    if (assets.length === 0) setOpen(false)
  }, [assets.length])

  if (assets.length === 0) return null

  const totalBytes = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0)

  // A file picked from disk keeps its bytes too; the original is only the
  // fallback for one whose bytes did not survive.
  const saveSessionZip = async (file: string) => {
    const entries = await Promise.all(
      assets.map(async (asset) => ({
        name: asset.name,
        data: asset.bytes.byteLength > 0 || !asset.source ? asset.bytes : new Uint8Array(await asset.source.arrayBuffer()),
      })),
    )
    saveBytes(createZip(uniqueEntryNames(entries)), file, 'application/zip')
  }

  return (
    <div ref={rootRef} className="relative">
      {picker.input}
      {projectPicker.input}
      <span className="sr-only" role="status" aria-live="polite">
        {arrived ? `${arrived} ist jetzt in der Sitzung` : ''}
      </span>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Dateien dieser Sitzung"
        className={`press flex max-w-[15rem] items-center gap-[8px] rounded-nav px-[8px] py-[8px] text-small text-ink hover:bg-panel-soft ${
          arrived !== null ? 'arrive' : ''
        }`}
      >
        <FileIcon />
        {/* The name is what is being worked on; on a phone the header has
            room for the fact that there is one, not for what it is called. */}
        <span className="hidden min-w-0 truncate sm:inline">{active?.name ?? 'Sitzung'}</span>
        {assets.length > 1 ? (
          <span className="value text-muted">
            <span className="sm:hidden">{assets.length}</span>
            <span className="hidden sm:inline">+{assets.length - 1}</span>
          </span>
        ) : (
          <span className="value text-muted sm:hidden">1</span>
        )}
        <svg viewBox="0 0 16 16" className={`h-3 w-3 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} fill="none" aria-hidden>
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Beside the button, in the header's own row — below it, the pill
          lay over the tool tabs. Where the row has no room for it, the
          button's own pulse and its count say the same. */}
      {arrived !== null && !open ? (
        <div
          role="status"
          className="rise absolute right-[calc(100%+8px)] top-1/2 z-30 hidden max-w-[280px] -translate-y-1/2 items-center gap-[6px] rounded-nav bg-ink py-[6px] pl-[10px] pr-[6px] text-small text-on-ink lg:flex"
        >
          <span className="truncate">In der Sitzung: {arrived}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setArrived(null)
            }}
            aria-label="Hinweis schliessen"
            title="Hinweis schliessen"
            className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-[6px] transition-colors hover:bg-on-ink/20"
          >
            <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" aria-hidden>
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : null}

      {open ? (
        <div
          role="dialog"
          aria-label="Dateien dieser Sitzung"
          className="rise elevate-lift fixed inset-x-[16px] top-[64px] z-30 flex flex-col gap-[12px] rounded-card bg-raised p-[16px] ring-1 ring-inset ring-line sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+8px)] sm:w-[380px]"
        >
          <SelectedPlayer />

          <ul className="flex flex-col">
            {assets.map((asset, index) => {
              const current = asset.id === activeId
              return (
                <li
                  key={asset.id}
                  draggable
                  onDragStart={(e) => {
                    setDraggedIndex(index)
                    e.dataTransfer.setData('text/plain', String(index))
                    startFileDragOut(e, { name: asset.name, bytes: asset.bytes, mime: asset.mime })
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragOverIndex !== index) setDragOverIndex(index)
                  }}
                  onDragLeave={() => {
                    if (dragOverIndex === index) setDragOverIndex(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOverIndex(null)
                    setDraggedIndex(null)
                    const fromStr = e.dataTransfer.getData('text/plain')
                    const fromIndex = fromStr ? parseInt(fromStr, 10) : draggedIndex
                    if (fromIndex !== null && !isNaN(fromIndex) && fromIndex !== index) {
                      reorderAssets(fromIndex, index)
                    }
                  }}
                  onDragEnd={() => {
                    setDraggedIndex(null)
                    setDragOverIndex(null)
                  }}
                  className={`group flex items-center gap-[4px] border-t border-line first:border-t-0 transition-colors ${
                    dragOverIndex === index ? 'bg-panel-strong/60 ring-1 ring-ink' : ''
                  } ${draggedIndex === index ? 'opacity-40' : ''}`}
                >
                  <span
                    title="Ziehen zum Sortieren oder in ein anderes Programm"
                    className="flex cursor-grab items-center justify-center p-[4px] text-muted/60 hover:text-ink active:cursor-grabbing"
                    aria-hidden
                  >
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
                      <circle cx="5" cy="4" r="1.2" />
                      <circle cx="11" cy="4" r="1.2" />
                      <circle cx="5" cy="8" r="1.2" />
                      <circle cx="11" cy="8" r="1.2" />
                      <circle cx="5" cy="12" r="1.2" />
                      <circle cx="11" cy="12" r="1.2" />
                    </svg>
                  </span>
                  <button
                    type="button"
                    onClick={() => setActive(asset.id)}
                    aria-current={current ? 'true' : undefined}
                    className="flex min-w-0 flex-1 items-center gap-[8px] py-[8px] text-left"
                  >
                    {/* The chosen file carries the ink mark, not a filled row. */}
                    <span aria-hidden className={`h-[6px] w-[6px] shrink-0 rounded-pill ${current ? 'bg-ink' : 'bg-transparent'}`} />
                    <span className="flex min-w-0 flex-col">
                      <span className={`truncate text-small ${current ? 'font-semibold text-ink' : 'text-prose'}`}>
                        {asset.name}
                      </span>
                      <span className="value text-micro text-muted">
                        {formatBytes(asset.sizeBytes)}
                        {asset.durationSeconds ? ` · ${formatDuration(asset.durationSeconds)}` : ''}
                      </span>
                    </span>
                  </button>
                  {asset.origin === 'derived' ? <Badge>abgeleitet</Badge> : null}
                  <IconButton label={`${asset.name} speichern`} onClick={() => saveBytes(asset.bytes, asset.name, asset.mime)}>
                    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
                      <path d="M8 2.5v7.5M5 7.5L8 10.5l3-3M3 12.5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </IconButton>
                  <IconButton label={`${asset.name} entfernen`} onClick={() => removeAsset(asset.id)}>
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </IconButton>
                </li>
              )
            })}
          </ul>

          <div className="flex flex-wrap items-center justify-between gap-[8px]">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                picker.open()
              }}
              disabled={picker.busy}
              className="press self-start text-small text-ink underline underline-offset-[3px] hover:no-underline disabled:opacity-40"
            >
              {picker.busy ? 'Wird gelesen…' : 'Weitere Datei öffnen'}
            </button>
            <div className="flex flex-wrap items-center gap-[6px]">
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  projectPicker.open()
                }}
                disabled={projectPicker.busy}
                className="press inline-flex items-center gap-[6px] rounded-nav bg-panel-soft px-[10px] py-[5px] text-small font-medium text-ink ring-1 ring-inset ring-line hover:ring-ink disabled:opacity-40"
                title="Öffnet eine gespeicherte .sondra Projektdatei"
              >
                <SondraProjectIcon />
                <span>{projectPicker.busy ? 'Lädt…' : 'Projekt laden'}</span>
              </button>
              <button
                type="button"
                onClick={() => void saveProjectFile()}
                className="press inline-flex items-center gap-[6px] rounded-nav bg-panel-soft px-[10px] py-[5px] text-small font-medium text-ink ring-1 ring-inset ring-line hover:ring-ink"
                title="Speichert alle Sitzungsdateien und Werkzeugeinstellungen als .sondra Projektdatei"
              >
                <SondraProjectIcon />
                <span>Projekt speichern (.sondra)</span>
              </button>
            </div>
          </div>

          {/* The whole session in one archive, under a name of one's own. */}
          {assets.length > 1 ? (
            <div className="border-t border-line pt-[12px]">
              <ZipSave
                stacked
                variant="quiet"
                suggestion={`sondra-sitzung-${new Date().toISOString().slice(0, 10)}`}
                label={`Alle ${assets.length} als ZIP speichern`}
                onSave={({ file }) => void saveSessionZip(file)}
              />
            </div>
          ) : null}

          <div className="flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[4px] border-t border-line pt-[12px] text-small text-muted">
            <span>
              <span className="value">{(totalBytes / 1024 / 1024).toFixed(1)} MB</span>{' '}
              {keep ? (saving ? 'wird auf diesem Gerät gespeichert …' : 'auf diesem Gerät gespeichert') : 'nur im Arbeitsspeicher'}, nichts
              davon gesendet
            </span>
            <button
              type="button"
              onClick={clearAssets}
              className="press text-muted underline-offset-[3px] hover:text-ink hover:underline"
            >
              Alles verwerfen
            </button>
          </div>

          <Toggle
            label="Sitzung auf diesem Gerät behalten"
            checked={keep}
            onChange={(next) => void setKeep(next)}
            hint={
              keep
                ? 'Nach dem Schliessen oder einem Update bietet Sondra die Dateien wieder an.'
                : 'Schliessen löscht alles. Für fremde oder geteilte Rechner.'
            }
          />
        </div>
      ) : null}
    </div>
  )
}
