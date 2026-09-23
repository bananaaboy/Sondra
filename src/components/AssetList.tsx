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
import { formatBytes, formatDuration } from '../lib/format'
import { useDecodedAudio } from '../hooks/useDecodedAudio'
import { useFilePicker } from '../hooks/useIngest'
import { useActiveAsset, useSession } from '../state/store'
import { AudioPreview } from './AudioPreview'
import { Badge } from './ui/primitives'

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
  const clearAssets = useSession((state) => state.clearAssets)
  const active = useActiveAsset()
  const picker = useFilePicker('geöffnet')
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

  return (
    <div ref={rootRef} className="relative">
      {picker.input}
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

      {arrived !== null && !open ? (
        <span
          aria-hidden
          className="rise pointer-events-none absolute right-0 top-[calc(100%+8px)] z-30 max-w-[260px] truncate rounded-nav bg-ink px-[10px] py-[6px] text-micro font-semibold text-on-ink"
        >
          In der Sitzung: {arrived}
        </span>
      ) : null}

      {open ? (
        <div
          role="dialog"
          aria-label="Dateien dieser Sitzung"
          className="rise elevate-lift fixed inset-x-[16px] top-[64px] z-30 flex flex-col gap-[12px] rounded-card bg-raised p-[16px] ring-1 ring-inset ring-line sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+8px)] sm:w-[380px]"
        >
          <SelectedPlayer />

          <ul className="flex flex-col">
            {assets.map((asset) => {
              const current = asset.id === activeId
              return (
                <li key={asset.id} className="flex items-center gap-[4px] border-t border-line first:border-t-0">
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

          <div className="flex flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[4px] border-t border-line pt-[12px] text-small text-muted">
            <span>
              <span className="value">{(totalBytes / 1024 / 1024).toFixed(1)} MB</span> im Arbeitsspeicher
              dieses Tabs, nichts davon gesendet
            </span>
            <button
              type="button"
              onClick={clearAssets}
              className="press text-muted underline-offset-[3px] hover:text-ink hover:underline"
            >
              Alles verwerfen
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
