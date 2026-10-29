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
  dismissTransfer,
  isOnline,
  sendToDevice,
  sendViaDrive,
  shortId,
  useDevices,
  type DeviceRecord,
  type Transfer,
} from '../lib/devices'
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
      line = `${peer} schickt ${bytes}`
      break
    case 'connecting':
      line = 'Verbindet die Geräte …'
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
      line = out ? `Angekommen auf ${peer}` : `Von ${peer} gespeichert`
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
              Annehmen
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

  const shown = transfers.filter((entry) => !entry.dismissed)
  if (panel === 'devices' || !shown.length) return null
  return (
    <div
      role="region"
      aria-label="Übertragungen zwischen Geräten"
      className="dock fixed inset-x-[12px] bottom-[calc(84px+env(safe-area-inset-bottom,0px))] z-50 flex max-h-[60dvh] flex-col gap-[12px] overflow-y-auto rounded-card bg-raised p-[14px] ring-1 ring-inset ring-line elevate-lift sm:bottom-[84px] sm:left-auto sm:right-[24px] sm:w-[400px]"
    >
      {shown.slice(0, 3).map((transfer, index) => (
        <div key={transfer.id} className={index ? 'border-t border-line pt-[12px]' : ''}>
          <TransferRow transfer={transfer} compact />
        </div>
      ))}
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
