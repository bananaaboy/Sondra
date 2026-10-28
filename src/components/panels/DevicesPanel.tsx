/**
 * „Geräte“: this device among the others of the same Google account, and
 * files to any of them.
 *
 * The page answers three things in order: is this device linked (a switch,
 * and what that puts into Drive), which others are there and which are open
 * right now, and what is on its way. Sending is a click on a device — or
 * files dropped on it; the other side is asked and says yes.
 */

import { useEffect, useRef, useState, type DragEvent } from 'react'

import {
  forgetThisDevice,
  isOnline,
  refreshDevices,
  renameThisDevice,
  sendToDevice,
  setDevicesEnabled,
  shortId,
  useDevices,
  type DeviceRecord,
} from '../../lib/devices'
import { connectDrive, driveLinked, useDrive } from '../../lib/googleDrive'
import { useSession } from '../../state/store'
import { DeviceGlyph, TransferRow } from '../DeviceSend'
import { Button, Notice, SectionHead, TextInput } from '../ui/primitives'

function seenLabel(device: DeviceRecord, now: number): string {
  if (isOnline(device, now)) return 'offen'
  const minutes = Math.max(1, Math.round((now - device.seen) / 60_000))
  if (minutes < 60) return `zuletzt vor ${minutes} Min.`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `zuletzt vor ${hours} Std.`
  return `zuletzt vor ${Math.round(hours / 24)} Tagen`
}

/** Ticks once a minute, so „offen“ and „vor 3 Min.“ stay true while the page is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function OtherDevice({ device, now }: { device: DeviceRecord; now: number }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const online = isOnline(device, now)
  const send = (files: File[]) => {
    if (files.length) void sendToDevice(device.id, files)
  }
  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    // Files dropped here are for this device, not for the session.
    event.stopPropagation()
    setOver(false)
    send([...event.dataTransfer.files])
  }
  return (
    <li
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`flex max-w-none flex-col gap-[10px] rounded-card p-[14px] ring-1 ring-inset transition-colors duration-[var(--dur-fast)] sm:flex-row sm:items-center sm:gap-[16px] ${
        over ? 'bg-panel-mid ring-ink' : 'bg-panel-soft ring-line'
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-[14px]">
        <span className="grid h-[40px] w-[40px] shrink-0 place-items-center rounded-nav bg-raised text-ink">
          <DeviceGlyph kind={device.kind} />
        </span>
        <span className="flex min-w-0 flex-col gap-[2px]">
          <span className="flex min-w-0 items-baseline gap-[8px]">
            <span className="truncate text-body font-semibold text-ink">{device.name}</span>
            <span className="value shrink-0 text-small text-prose" title={`Geräte-Kennung ${device.id}`}>
              {shortId(device.id)}
            </span>
          </span>
          <span className="text-small text-prose">
            {device.platform} · {online ? <span className="text-ink">● offen</span> : seenLabel(device, now)}
          </span>
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-start gap-[4px] pl-[54px] sm:items-end sm:pl-0">
        <Button size="sm" onClick={() => input.current?.click()}>
          Dateien senden
        </Button>
        {online ? null : <span className="text-small text-prose">Kommt an, wenn Sondra dort innerhalb von 15 Min. offen ist.</span>}
      </span>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          send([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
    </li>
  )
}

function ThisDevice() {
  const self = useDevices((state) => state.self)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  if (!self) return null
  const save = async () => {
    const wanted = draft.trim()
    setEditing(false)
    if (!wanted || wanted === self.name) return
    const name = await renameThisDevice(wanted)
    setNote(name.toLocaleLowerCase('de') === wanted.toLocaleLowerCase('de') ? null : `„${wanted}“ trägt schon ein anderes Gerät — dieses heisst jetzt „${name}“.`)
  }
  return (
    <div className="flex flex-col gap-[10px]">
      <div className="flex flex-col gap-[12px] sm:flex-row sm:items-center sm:gap-[16px]">
        <span className="flex min-w-0 flex-1 items-center gap-[14px]">
          <span className="grid h-[40px] w-[40px] shrink-0 place-items-center rounded-nav bg-ink text-on-ink">
            <DeviceGlyph kind={self.kind} />
          </span>
          {editing ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-[8px]"
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <TextInput
                autoFocus
                aria-label="Name dieses Geräts"
                maxLength={40}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setEditing(false)
                }}
                className="max-w-[280px]"
              />
              <Button size="sm" type="submit">
                Speichern
              </Button>
            </form>
          ) : (
            <span className="flex min-w-0 flex-col gap-[2px]">
              <span className="flex min-w-0 items-baseline gap-[8px]">
                <span className="truncate text-body font-semibold text-ink">{self.name}</span>
                <span className="value shrink-0 text-small text-prose" title={`Geräte-Kennung ${self.id}`}>
                  {shortId(self.id)}
                </span>
              </span>
              <span className="text-small text-prose">{self.platform} · dieses Gerät</span>
            </span>
          )}
        </span>
        {editing ? null : (
          <span className="flex shrink-0 gap-[8px] pl-[54px] sm:pl-0">
            <Button
              size="sm"
              variant="quiet"
              onClick={() => {
                setDraft(self.name)
                setEditing(true)
              }}
            >
              Umbenennen
            </Button>
            <Button size="sm" variant="quiet" onClick={() => void setDevicesEnabled(false)}>
              Trennen
            </Button>
          </span>
        )}
      </div>
      {note ? <p className="text-small text-prose">{note}</p> : null}
    </div>
  )
}

export function DevicesPanel() {
  const enabled = useDevices((state) => state.enabled)
  const status = useDevices((state) => state.status)
  const problem = useDevices((state) => state.problem)
  const devices = useDevices((state) => state.devices)
  const transfers = useDevices((state) => state.transfers)
  const configured = useDrive((state) => state.configured)
  const linked = useDrive((state) => driveLinked(state))
  const signingIn = useDrive((state) => state.signingIn)
  const setPanel = useSession((state) => state.setPanel)
  const now = useNow()

  useEffect(() => {
    if (enabled) refreshDevices()
  }, [enabled])

  const open = devices.filter((device) => isOnline(device, now))
  const away = devices.filter((device) => !isOnline(device, now))

  return (
    <div className="flex max-w-[760px] flex-col gap-[28px]">
      <header className="flex flex-col gap-[8px]">
        <h2 className="m-0 text-subheading font-semibold text-ink">Ihre Geräte</h2>
        <p className="text-body leading-[1.55] text-prose">
          Dateien von hier direkt auf Ihr Handy, Ihren Laptop oder einen anderen Rechner — und zurück. Gefunden werden die Geräte über
          Ihr Google-Konto; die Dateien gehen von Gerät zu Gerät, verschlüsselt und im selben WLAN, ohne das Netz zu verlassen.
        </p>
      </header>

      {!configured ? (
        <Notice tone="warn" title="Hier nicht eingerichtet">
          Geräte finden sich über Google Drive, und in dieser Fassung ist Google Drive nicht eingerichtet.
        </Notice>
      ) : !enabled ? (
        <section className="flex flex-col gap-[14px] rounded-card bg-panel-soft p-[20px]">
          <p className="text-body font-semibold text-ink">Dieses Gerät verbinden</p>
          <p className="text-small leading-[1.55] text-prose">
            In Ihrem Drive liegt dann je Gerät eine kleine Datei: Name, Art und wann es zuletzt offen war. Jede ist mit einem Schlüssel
            signiert, der dieses Gerät nie verlässt — kein anderes Gerät kann sie ändern oder sich als dieses ausgeben. Machen Sie dasselbe
            auf Ihren anderen Geräten, mit demselben Google-Konto.
          </p>
          <div className="flex flex-wrap items-center gap-[10px]">
            <Button
              onClick={() => {
                // The sign-in first: its popup has to open within the click.
                if (!linked) void connectDrive()
                void setDevicesEnabled(true)
              }}
            >
              {linked ? 'Dieses Gerät verbinden' : 'Mit Google anmelden und verbinden'}
            </Button>
          </div>
        </section>
      ) : (
        <>
          <section aria-labelledby="geraete-dieses" className="flex flex-col gap-[12px]">
            <SectionHead className="max-w-none">
              <span id="geraete-dieses">Dieses Gerät</span>
            </SectionHead>
            {status === 'waiting-drive' ? (
              <div className="flex flex-wrap items-center gap-[12px]">
                <p className="text-small text-prose">Wartet auf die Anmeldung bei Google Drive.</p>
                <Button size="sm" disabled={signingIn} onClick={() => void connectDrive()}>
                  {signingIn ? 'Meldet an …' : 'Bei Google anmelden'}
                </Button>
              </div>
            ) : status === 'joining' || (status !== 'ready' && status !== 'error') ? (
              <p className="text-small text-prose">Verbindet …</p>
            ) : status === 'error' ? (
              <div className="flex flex-wrap items-center gap-[12px]">
                <p className="text-small text-ink">! Drive antwortete nicht wie erwartet{problem ? `: ${problem}` : ''}.</p>
                <Button size="sm" variant="quiet" onClick={refreshDevices}>
                  Erneut
                </Button>
              </div>
            ) : (
              <ThisDevice />
            )}
          </section>

          <section aria-labelledby="geraete-andere" className="flex flex-col gap-[12px]">
            <SectionHead className="max-w-none">
              <span id="geraete-andere">Ihre anderen Geräte</span>
            </SectionHead>
            {devices.length === 0 ? (
              <p className="text-small leading-[1.55] text-prose">
                {status === 'ready'
                  ? 'Noch kein anderes. Öffnen Sie Sondra auf dem Handy oder einem anderen Rechner — Website oder App —, melden Sie sich mit demselben Google-Konto an und schalten Sie unter „Geräte“ dasselbe ein. Es erscheint dann hier.'
                  : 'Sobald dieses Gerät verbunden ist, stehen die anderen hier.'}
              </p>
            ) : (
              <>
                <ul className="flex flex-col gap-[8px]">
                  {[...open, ...away].map((device) => (
                    <OtherDevice key={device.id} device={device} now={now} />
                  ))}
                </ul>
                <p className="text-small text-prose">Dateien lassen sich auch auf ein Gerät ziehen.</p>
              </>
            )}
          </section>

          {transfers.length ? (
            <section aria-labelledby="geraete-uebertragungen" className="flex flex-col gap-[12px]">
              <SectionHead className="max-w-none">
                <span id="geraete-uebertragungen">Übertragungen</span>
              </SectionHead>
              <ul className="flex flex-col">
                {transfers.map((transfer) => (
                  <li key={transfer.id} className="max-w-none border-t border-line py-[12px] first:border-t-0 first:pt-0">
                    <TransferRow transfer={transfer} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="geraete-wie" className="flex flex-col gap-[8px]">
            <SectionHead className="max-w-none">
              <span id="geraete-wie">So geht es</span>
            </SectionHead>
            <p className="text-small leading-[1.55] text-prose">
              Das andere Gerät fragt, bevor es etwas annimmt. Auf dem Handy landen die Dateien in Downloads/Sondra; auf einem Rechner fragt
              Sondra beim ersten Mal nach einem Ordner und nimmt ihn danach wieder. Sind die Geräte nicht im selben Netz, findet sich kein
              direkter Weg — dann bietet Sondra Google Drive an, und erst auf Ihren Klick liegen die Dateien dort, bis das andere Gerät
              sie hat.
            </p>
            <p className="text-small leading-[1.55] text-prose">
              Ein Ergebnis eines Werkzeugs geht mit „An Gerät“ neben „In Drive“ direkt hinüber; Filme laufen dort im{' '}
              <button type="button" onClick={() => setPanel('player')} className="text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink">
                Player
              </button>
              .
            </p>
            <div>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Dieses Gerät ganz vergessen? Es verschwindet aus der Liste der anderen, und beim nächsten Verbinden ist es ein neues Gerät.')) {
                    void forgetThisDevice()
                  }
                }}
                className="press text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
              >
                Dieses Gerät ganz vergessen
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
