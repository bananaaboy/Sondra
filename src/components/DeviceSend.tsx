/**
 * The small parts of „Geräte“ that live outside its page: the card that asks
 * whether to take what another device sends — wherever in Sondra one is —
 * the line one transfer stands in, and „An Gerät“ beside „In Drive“ under
 * every result.
 *
 * The card floats: it is the one thing here that has to be seen without
 * looking for it, so it takes the sheet's one shadow, as the player's and the
 * downloader's small bars do.
 */

import { useEffect, useRef, useState } from 'react'

import {
  acceptTransfer,
  cancelTransfer,
  declineTransfer,
  dismissNote,
  dismissTransfer,
  isOnline,
  onlineDevices,
  playNote,
  playOnDevice,
  PLAY_TRANSFER_MAX,
  sendToDevice,
  sendViaDrive,
  shortId,
  useDevices,
  type DeviceRecord,
  type Note,
  type Transfer,
} from '../lib/devices'
import { can } from '../lib/deviceIdentity'
import { formatBytes } from '../lib/format'
import { useSession } from '../state/store'
import { Button, Progress } from './ui/primitives'

/** A phone, a laptop, a browser window: what kind of device. */
export function DeviceGlyph({ kind, className = 'h-[20px] w-[20px]' }: { kind: DeviceRecord['kind']; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`shrink-0 ${className}`} fill="none" aria-hidden>
      {kind === 'android' ? (
        <>
          <rect x="5.5" y="2.5" width="9" height="15" rx="2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8.8 15h2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : kind === 'windows' ? (
        <>
          <rect x="3" y="4" width="14" height="9.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M1.8 16.2h16.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : (
        <>
          <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3 7.5h14" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="5.4" cy="5.8" r="0.7" fill="currentColor" />
        </>
      )}
    </svg>
  )
}

function filesLabel(transfer: Transfer): string {
  // A folder: its name and how many files, not the first file's.
  const top = transfer.files[0]?.path?.split('/')[0]
  if (top && transfer.files.every((file) => file.path?.split('/')[0] === top)) {
    return `${top} (${transfer.files.length} ${transfer.files.length === 1 ? 'Datei' : 'Dateien'})`
  }
  const first = transfer.files[0]?.name ?? 'Datei'
  const more = transfer.files.length - 1
  return more > 0 ? `${first} und ${more} weitere` : first
}

const isActive = (transfer: Transfer) =>
  ['offering', 'asking', 'connecting', 'sending', 'receiving', 'direct-failed', 'via-drive'].includes(transfer.state)

/** One transfer: what, with whom, how far, and what can be done about it now. */
export function TransferRow({ transfer, compact = false }: { transfer: Transfer; compact?: boolean }) {
  const peer = `„${transfer.peerName}“`
  const out = transfer.direction === 'out'
  const share = transfer.total > 0 ? transfer.done / transfer.total : null
  const bytes = `${transfer.files.length} ${transfer.files.length === 1 ? 'Datei' : 'Dateien'} · ${formatBytes(transfer.total)}`

  let line: string
  switch (transfer.state) {
    case 'offering':
      line = `Wartet, bis ${peer} annimmt …`
      break
    case 'asking':
      line = transfer.play ? `${peer} möchte „${transfer.files[0]?.name ?? 'eine Datei'}“ auf diesem Gerät abspielen (${formatBytes(transfer.total)})` : `${peer} schickt ${bytes}`
      break
    case 'connecting':
      line = transfer.queued ? 'Verbunden — wartet, bis eine der anderen Übertragungen fertig ist …' : 'Verbindet die Geräte …'
      break
    case 'sending':
      line = `An ${peer}, direkt`
      break
    case 'receiving':
      line = `Von ${peer}, direkt`
      break
    case 'direct-failed':
      line = out
        ? `Kein direkter Weg zu ${peer} — die Geräte sind wohl nicht im selben Netz.`
        : `Kein direkter Weg. Wartet, ob ${peer} über Google Drive sendet …`
      break
    case 'via-drive':
      line = out
        ? transfer.done >= transfer.total
          ? `In Drive — wartet, bis ${peer} es abholt …`
          : 'Lädt in Ihr Google Drive …'
        : 'Holt es aus Ihrem Google Drive …'
      break
    case 'done':
      line = out ? (transfer.play ? `Läuft jetzt im Player auf ${peer}` : `Angekommen auf ${peer}`) : transfer.play ? `Von ${peer} — läuft im Player` : `Von ${peer} gespeichert`
      break
    case 'declined':
      line = out ? `${peer} hat abgelehnt.` : 'Abgelehnt.'
      break
    case 'expired':
      line = `Nicht angenommen — ${peer} war nicht offen.`
      break
    case 'cancelled':
      line = transfer.error ?? 'Abgebrochen.'
      break
    default:
      line = transfer.error ?? 'Nicht übertragen.'
  }

  const running = transfer.state === 'sending' || transfer.state === 'receiving' || transfer.state === 'via-drive'
  return (
    <div className="flex min-w-0 flex-col gap-[8px]">
      <div className="flex min-w-0 items-baseline justify-between gap-[12px]">
        <span className="value min-w-0 truncate text-small text-ink" title={transfer.files.map((file) => file.name).join('\n')}>
          {filesLabel(transfer)}
        </span>
        <span className="shrink-0 text-small text-prose">{out ? `an ${transfer.peerName}` : `von ${transfer.peerName}`}</span>
      </div>
      {/* Keyed on the state: each step arrives instead of swapping in place,
          a waiting step breathes, and the arrival mark lands once. */}
      <p key={transfer.state} className="rise text-small leading-[1.5] text-prose" aria-live="polite">
        {transfer.state === 'done' ? (
          <span className="pop mr-[4px] inline-block text-ink">●</span>
        ) : transfer.state === 'failed' ? (
          '! '
        ) : transfer.state === 'offering' || transfer.state === 'connecting' || (transfer.state === 'direct-failed' && !out) ? (
          <span aria-hidden className="pulse-dot mr-[4px] inline-block text-ink">●</span>
        ) : null}
        {line}
        {transfer.state === 'done' && transfer.places?.length ? (
          <>
            {' — '}
            <span className="value text-ink">{transfer.places.length === 1 ? transfer.places[0] : `${transfer.places.length} Dateien`}</span>
          </>
        ) : null}
      </p>
      {running ? (
        <div className="flex items-center gap-[12px]">
          <div className="min-w-0 flex-1">
            <Progress value={share} />
          </div>
          <span className="value w-[5ch] text-right text-small text-ink">{share !== null ? `${Math.floor(share * 100)} %` : ''}</span>
        </div>
      ) : null}

      {/* Drive, said as such: here the files leave the device for a while. */}
      {out && transfer.state === 'direct-failed' ? (
        <p className="rounded-nav bg-panel-cool p-[10px] text-small leading-[1.5] text-ink">
          Über Google Drive senden: die Dateien liegen dann kurz in Ihrem Drive und werden gelöscht, sobald {peer} sie hat.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-[8px]">
        {transfer.state === 'asking' ? (
          <>
            <Button size="sm" onClick={() => void acceptTransfer(transfer.id)}>
              {transfer.play ? 'Abspielen' : 'Annehmen'}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => void declineTransfer(transfer.id)}>
              Ablehnen
            </Button>
          </>
        ) : null}
        {out && transfer.state === 'direct-failed' ? (
          <Button size="sm" onClick={() => void sendViaDrive(transfer.id)}>
            Über Google Drive senden
          </Button>
        ) : null}
        {isActive(transfer) && transfer.state !== 'asking' ? (
          <Button size="sm" variant="quiet" onClick={() => cancelTransfer(transfer.id)}>
            Abbrechen
          </Button>
        ) : null}
        {!compact || isActive(transfer) ? null : (
          <Button size="sm" variant="quiet" onClick={() => dismissTransfer(transfer.id)}>
            Schliessen
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * What arrives, and what is on its way, wherever one is in Sondra. Not on
 * the page „Geräte“, which lists them itself. A finished send goes by
 * itself; a received file stays until closed, so where it went is read.
 */
export function DeviceInbox() {
  const transfers = useDevices((state) => state.transfers)
  const panel = useSession((state) => state.panel)

  useEffect(() => {
    const finishedOut = transfers.filter(
      (entry) => entry.direction === 'out' && ['done', 'declined', 'expired', 'cancelled'].includes(entry.state) && !entry.dismissed,
    )
    if (!finishedOut.length) return
    const timer = window.setTimeout(() => finishedOut.forEach((entry) => dismissTransfer(entry.id)), 6000)
    return () => window.clearTimeout(timer)
  }, [transfers])

  const notes = useDevices((state) => state.notes)
  const shown = panel === 'devices' ? [] : transfers.filter((entry) => !entry.dismissed)
  if (!shown.length && !notes.length) return null
  // One stack at the bottom corner; the card for a note sits on top, since a
  // line someone sent is read in a glance and then gone.
  return (
    <div className="pointer-events-none fixed inset-x-[12px] bottom-[calc(84px+env(safe-area-inset-bottom,0px))] z-50 flex max-h-[80dvh] flex-col gap-[10px] sm:bottom-[84px] sm:left-auto sm:right-[24px] sm:w-[400px]">
      {notes.length ? (
        <div
          role="region"
          aria-label="Von einem anderen Gerät gesendet"
          className="dock pointer-events-auto flex max-h-[45dvh] flex-col gap-[12px] overflow-y-auto rounded-card bg-raised p-[14px] ring-1 ring-inset ring-line elevate-lift"
        >
          {notes.slice(0, 3).map((note, index) => (
            <div key={note.id} className={index ? 'border-t border-line pt-[12px]' : ''}>
              <NoteRow note={note} />
            </div>
          ))}
          {notes.length > 3 ? <p className="text-small text-prose">und {notes.length - 3} weitere</p> : null}
        </div>
      ) : null}
      {shown.length ? (
        <div
          role="region"
          aria-label="Übertragungen zwischen Geräten"
          className="dock pointer-events-auto flex max-h-[45dvh] flex-col gap-[12px] overflow-y-auto rounded-card bg-raised p-[14px] ring-1 ring-inset ring-line elevate-lift"
        >
          {shown.slice(0, 3).map((transfer, index) => (
            <div key={transfer.id} className={index ? 'border-t border-line pt-[12px]' : ''}>
              <TransferRow transfer={transfer} compact />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Where a link leads, short: the host, without „www.“. */
function hostOf(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, '')
  } catch {
    return link
  }
}

/**
 * A line of text or a link from another device. Nothing is opened by itself:
 * the link is shown with where it leads, and „Öffnen“ is a click here.
 */
export function NoteRow({ note }: { note: Note }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 2400)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(note.text)
      setCopied('yes')
    } catch {
      setCopied('no')
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-[8px]">
      <p className="text-small text-prose">
        {note.play ? 'Abspielen' : note.link ? 'Link' : 'Text'} von „{note.peerName}“{note.link ? <> · <span className="value text-ink">{hostOf(note.link)}</span></> : null}
      </p>
      <p className={`max-h-[18dvh] overflow-y-auto whitespace-pre-wrap break-words text-small leading-[1.5] text-ink ${note.link || note.play ? 'value' : ''}`}>
        {note.play ? `${note.text} auf diesem Gerät abspielen?` : note.text}
      </p>
      <div className="flex flex-wrap items-center gap-[8px]">
        {note.play ? (
          <Button size="sm" onClick={() => playNote(note.id)}>
            Abspielen
          </Button>
        ) : null}
        {note.link ? (
          <Button
            size="sm"
            onClick={() => {
              window.open(note.link!, '_blank', 'noopener,noreferrer')
              dismissNote(note.id)
            }}
          >
            Öffnen
          </Button>
        ) : null}
        {note.play ? null : (
          <Button size="sm" variant={note.link ? 'quiet' : 'primary'} onClick={() => void copy()}>
            Kopieren
          </Button>
        )}
        <Button size="sm" variant="quiet" onClick={() => dismissNote(note.id)}>
          {note.play ? 'Ablehnen' : 'Verwerfen'}
        </Button>
        <span aria-live="polite" className="text-small text-prose">
          {copied === 'yes' ? '● Kopiert' : copied === 'no' ? 'Nicht kopiert — markieren Sie den Text selbst.' : ''}
        </span>
      </div>
    </div>
  )
}

function seenLabel(device: DeviceRecord, now: number): string {
  if (isOnline(device, now)) return 'offen'
  const minutes = Math.round((now - device.seen) / 60_000)
  if (minutes < 60) return `vor ${minutes} Min.`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `vor ${hours} Std.`
  return `vor ${Math.round(hours / 24)} Tagen`
}

/** The devices to send to, as a list to pick from; one click offers the files. */
export function DevicePicker({ files, onSent }: { files: () => File[] | Promise<File[]>; onSent?: (device: DeviceRecord) => void }) {
  const devices = useDevices((state) => state.devices)
  const now = Date.now()
  return (
    <ul className="flex flex-col">
      {devices.map((device) => (
        <li key={device.id} className="max-w-none">
          <button
            type="button"
            onClick={async () => {
              await sendToDevice(device.id, await files())
              onSent?.(device)
            }}
            className="press flex w-full items-center gap-[10px] rounded-nav px-[10px] py-[8px] text-left text-ink hover:bg-panel-soft"
          >
            <DeviceGlyph kind={device.kind} className="h-[18px] w-[18px]" />
            <span className="min-w-0 flex-1 truncate text-small font-semibold">{device.name}</span>
            <span className="shrink-0 text-small text-prose">
              {isOnline(device, now) ? '● offen' : seenLabel(device, now)} · <span className="value">{shortId(device.id)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * „An Gerät“: a result straight to another of one's devices, beside „In
 * Drive“. Only there when devices are linked and there is another one.
 */
export function DeviceSendButton({
  name,
  bytes,
  mime,
  source,
  size = 'sm',
  disabled = false,
}: {
  name: string
  bytes: Uint8Array | Blob | (() => Uint8Array | Blob)
  mime: string
  source?: unknown
  size?: 'sm' | 'md'
  disabled?: boolean
}) {
  const enabled = useDevices((state) => state.enabled)
  const others = useDevices((state) => state.devices.length)
  const [open, setOpen] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => setSentTo(null), [source])
  useEffect(() => {
    if (!open) return
    const away = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  if (!enabled || !others) return null
  const asFile = () => {
    const made = typeof bytes === 'function' ? bytes() : bytes
    const blob = made instanceof Blob ? made : new Blob([made as Uint8Array<ArrayBuffer>], { type: mime })
    return [new File([blob], name, { type: mime })]
  }
  return (
    <div ref={box} className="relative">
      <Button
        type="button"
        size={size}
        variant="quiet"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        title={`${name} an ein anderes Ihrer Geräte senden`}
      >
        <DeviceGlyph kind="android" className="h-4 w-4" />
        <span aria-live="polite">{sentTo ? `An „${sentTo}“ angeboten` : 'An Gerät'}</span>
      </Button>
      {open ? (
        <div role="menu" className="drop absolute left-0 top-[calc(100%+6px)] z-40 w-[min(320px,calc(100vw-32px))] rounded-card bg-raised p-[6px] ring-1 ring-inset ring-line elevate-lift">
          <DevicePicker
            files={asFile}
            onSent={(device) => {
              setSentTo(device.name)
              setOpen(false)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * „Auf Gerät abspielen“: films of the Sondra folder in Drive start on another
 * device — only their names go, the device streams them itself — and a single
 * film on this one is sent along and starts when it has arrived. Only for
 * devices that can (an older Sondra would ignore the request), and only for
 * those open now: the question waits there, not for a day.
 */
export function PlayOnDeviceButton({
  media,
}: {
  media: { name: string; size: number; kind: string; file?: File; drive?: { id: string; mime: string } }[]
}) {
  const enabled = useDevices((state) => state.enabled)
  const devices = useDevices((state) => state.devices)
  const [open, setOpen] = useState(false)
  const [told, setTold] = useState<{ ok: boolean; line: string } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => setTold(null), [media])
  useEffect(() => {
    if (!open) return
    const away = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  if (!enabled || !media.length) return null
  const targets = onlineDevices(devices).filter((device) => can(device, 'play'))
  const inDrive = media.every((entry) => entry.drive)
  const single = media.length === 1 && media[0].file && media[0].size <= PLAY_TRANSFER_MAX ? media[0].file : null
  if (!targets.length || (!inDrive && !single)) return null
  const go = async (device: DeviceRecord) => {
    setOpen(false)
    try {
      if (inDrive) {
        await playOnDevice(
          device.id,
          media.map((entry) => ({ id: entry.drive!.id, name: entry.name, size: entry.size, type: entry.drive!.mime })),
        )
        setTold({ ok: true, line: `An „${device.name}“ gefragt — dort startet es mit „Abspielen“.` })
      } else if (single) {
        await sendToDevice(device.id, [single], { play: true })
        setTold({ ok: true, line: `An „${device.name}“ angeboten — dort startet es nach „Abspielen“.` })
      }
    } catch (error) {
      setTold({ ok: false, line: error instanceof Error ? error.message : String(error) })
    }
  }
  return (
    <div ref={box} className="relative">
      <Button type="button" size="sm" variant="quiet" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <DeviceGlyph kind="android" className="h-4 w-4" />
        Auf Gerät abspielen
      </Button>
      {open ? (
        <div role="menu" className="drop absolute bottom-[calc(100%+6px)] left-0 z-40 w-[min(320px,calc(100vw-32px))] rounded-card bg-raised p-[6px] ring-1 ring-inset ring-line elevate-lift">
          {targets.map((device) => (
            <button
              key={device.id}
              type="button"
              role="menuitem"
              onClick={() => void go(device)}
              className="press flex w-full items-center gap-[10px] rounded-nav px-[10px] py-[8px] text-left text-ink hover:bg-panel-soft"
            >
              <DeviceGlyph kind={device.kind} className="h-[18px] w-[18px]" />
              <span className="min-w-0 flex-1 truncate text-small font-semibold">{device.name}</span>
              <span className="shrink-0 text-small text-ink">● offen</span>
            </button>
          ))}
        </div>
      ) : null}
      <span role="status" aria-live="polite" className={`ml-[8px] text-small ${told?.ok === false ? 'text-ink' : 'text-prose'}`}>
        {told ? `${told.ok ? '● ' : '! '}${told.line}` : ''}
      </span>
    </div>
  )
}

/**
 * „An Geräte senden“ under a selection of files from a folder here: one or
 * several devices at once, and several files keep the folders they lay in.
 * Each device is its own transfer; two send at a time, the rest wait their
 * turn and say so. Not for files lying in Drive — those are not here yet.
 */
export function SendToDevicesButton({
  items,
  root,
}: {
  items: { file?: File; path: string }[]
  /** The chosen folder's name: several files arrive inside a folder of that name. */
  root: string
}) {
  const enabled = useDevices((state) => state.enabled)
  const devices = useDevices((state) => state.devices)
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [told, setTold] = useState<{ ok: boolean; line: string } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => setTold(null), [items])
  useEffect(() => {
    if (!open) return
    const away = (event: Event) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const here = items.filter((item): item is { file: File; path: string } => Boolean(item.file))
  if (!enabled || !devices.length || !here.length || here.length < items.length) return null
  const structured = here.length > 1
  const candidates = devices.filter((device) => !structured || can(device, 'folder'))
  const older = devices.length - candidates.length
  const now = Date.now()
  const go = async () => {
    const wanted = candidates.filter((device) => picked.has(device.id))
    if (!wanted.length) return
    setOpen(false)
    const files = here.map((item) => item.file)
    const paths = structured ? here.map((item) => `${root}/${item.path}`) : undefined
    const outcomes = await Promise.allSettled(wanted.map((device) => sendToDevice(device.id, files, paths ? { paths } : {})))
    const bad = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    if (bad) setTold({ ok: false, line: bad.reason instanceof Error ? bad.reason.message : String(bad.reason) })
    else setTold({ ok: true, line: wanted.length === 1 ? `An „${wanted[0].name}“ angeboten.` : `An ${wanted.length} Geräte angeboten — zwei senden gleichzeitig, die anderen warten.` })
    setPicked(new Set())
  }
  return (
    <div ref={box} className="relative">
      <Button type="button" size="sm" variant="quiet" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <DeviceGlyph kind="windows" className="h-4 w-4" />
        An Geräte senden
      </Button>
      {open ? (
        <div role="dialog" aria-label="An welche Geräte?" className="drop absolute bottom-[calc(100%+6px)] left-0 z-40 flex w-[min(340px,calc(100vw-32px))] flex-col gap-[6px] rounded-card bg-raised p-[10px] ring-1 ring-inset ring-line elevate-lift">
          <p className="px-[4px] text-small text-prose">
            {here.length} {here.length === 1 ? 'Datei' : 'Dateien'}{structured ? ` — mit ihren Ordnern, in „${root}“` : ''}
          </p>
          {candidates.length ? (
            <ul className="flex flex-col">
              {candidates.map((device) => (
                <li key={device.id} className="max-w-none">
                  <label className="press flex cursor-pointer items-center gap-[10px] rounded-nav px-[8px] py-[8px] text-ink hover:bg-panel-soft">
                    <input
                      type="checkbox"
                      checked={picked.has(device.id)}
                      onChange={() =>
                        setPicked((current) => {
                          const next = new Set(current)
                          if (!next.delete(device.id)) next.add(device.id)
                          return next
                        })
                      }
                      className="h-[16px] w-[16px] accent-[var(--color-ink)]"
                    />
                    <DeviceGlyph kind={device.kind} className="h-[18px] w-[18px]" />
                    <span className="min-w-0 flex-1 truncate text-small font-semibold">{device.name}</span>
                    <span className="shrink-0 text-small text-prose">{isOnline(device, now) ? '● offen' : seenLabel(device, now)}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-[4px] text-small text-prose">Kein Gerät kann Ordner annehmen — es fehlt dort ein Update.</p>
          )}
          {older > 0 && candidates.length ? <p className="px-[4px] text-small text-prose">{older} {older === 1 ? 'Gerät fehlt' : 'Geräte fehlen'}: dort läuft eine ältere Version, die keine Ordner annimmt.</p> : null}
          <Button type="button" size="sm" disabled={picked.size === 0} onClick={() => void go()}>
            {picked.size > 1 ? `An ${picked.size} Geräte senden` : 'Senden'}
          </Button>
        </div>
      ) : null}
      <span role="status" aria-live="polite" className="ml-[8px] text-small text-prose">
        {told ? `${told.ok ? '● ' : '! '}${told.line}` : ''}
      </span>
    </div>
  )
}
