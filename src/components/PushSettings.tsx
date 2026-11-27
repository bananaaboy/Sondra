/**
 * „Meldungen aufs Handy“: choose ntfy, Telegram or Pushover, enter what that
 * service needs, say which events are worth a notice, send a test. Opens from
 * a plain line of text wherever it is useful (the Downloader's settings, the
 * Kalender); the dialog holds the one form.
 *
 * Messages leave the device, so the one sentence about that sits on
 * `panel-cool`, the tint kept for it. Nothing is prefilled: the services are
 * the person's own choice.
 */

import { useEffect, useState } from 'react'

import {
  configurePush,
  forgetPush,
  PUSH_KINDS,
  PUSH_SERVICES,
  PUSH_SUPPORTED,
  pushWanted,
  refreshPush,
  setPushWanted,
  testPush,
  usePush,
  type PushKind,
  type PushService,
} from '../lib/push'
import { ChoiceRow } from './editor/EditorShell'
import { Button, Dialog, Field, TextInput, Toggle } from './ui/primitives'

/** The one sentence that matters: this leaves the device. */
function NotLocal() {
  return (
    <div role="note" className="rounded-nav bg-panel-cool px-[12px] py-[8px] text-small leading-[1.5] text-ink ring-1 ring-inset ring-rule">
      <span className="font-semibold">Was Sie hier senden, verlässt dieses Gerät.</span>{' '}
      <span className="text-prose">Es geht an den Dienst, den Sie wählen. Token und Schlüssel bleiben verschlüsselt in diesem Windows-Konto.</span>
    </div>
  )
}

function PushForm({ onDone }: { onDone: () => void }) {
  const status = usePush((state) => state.status)
  const [service, setService] = useState<PushService>('ntfy')
  const [ntfyServer, setNtfyServer] = useState('')
  const [ntfyTopic, setNtfyTopic] = useState('')
  const [ntfyToken, setNtfyToken] = useState('')
  const [telegramChat, setTelegramChat] = useState('')
  const [telegramToken, setTelegramToken] = useState('')
  const [pushoverToken, setPushoverToken] = useState('')
  const [pushoverUser, setPushoverUser] = useState('')
  const [wanted, setWanted] = useState(pushWanted)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [answer, setAnswer] = useState<{ ok: boolean; message: string } | null>(null)
  const [filled, setFilled] = useState(false)

  useEffect(() => {
    void refreshPush()
  }, [])
  // What the app holds fills the form once; typing is never overwritten after that.
  useEffect(() => {
    if (filled || !status) return
    setFilled(true)
    if (status.service) setService(status.service)
    setNtfyServer(status.ntfyServer)
    setNtfyTopic(status.ntfyTopic)
    setTelegramChat(status.telegramChat)
  }, [status, filled])

  const input = () => ({
    service,
    ntfyServer,
    ntfyTopic,
    telegramChat,
    // Empty keeps what is saved; only typing replaces it.
    ntfyToken: ntfyToken || undefined,
    telegramToken: telegramToken || undefined,
    pushoverToken: pushoverToken || undefined,
    pushoverUser: pushoverUser || undefined,
  })

  const save = async () => {
    const saved = await configurePush(input())
    if (saved.ok) {
      setNtfyToken('')
      setTelegramToken('')
      setPushoverToken('')
      setPushoverUser('')
    }
    return saved
  }

  const run = async (kind: 'save' | 'test') => {
    setBusy(kind)
    setAnswer(null)
    try {
      const saved = await save()
      setAnswer(!saved.ok ? saved : kind === 'test' ? await testPush() : { ok: true, message: 'Gespeichert.' })
    } finally {
      setBusy(null)
    }
  }

  const keep = (has: boolean | undefined) => (has ? '••••••••' : '')
  const kept = (has: boolean | undefined, typed: string) => (has && typed === '' ? 'Gespeichert. Leer lassen, um es zu behalten.' : undefined)
  const insecure = service === 'ntfy' && /^http:\/\//i.test(ntfyServer.trim())

  return (
    <div className="flex flex-col gap-[16px]">
      <p className="m-0 text-small leading-[1.5] text-prose">Sondra schickt Ihnen eine Meldung aufs Handy, wenn etwas fertig ist oder ansteht — über den Dienst, den Sie schon nutzen.</p>
      <div className="flex flex-col gap-[8px]">
        <span className="text-small text-prose">Dienst</span>
        <ChoiceRow
          value={service}
          options={PUSH_SERVICES.map((entry) => ({ value: entry.id, label: entry.label }))}
          onChange={(value) => {
            setService(value as PushService)
            setAnswer(null)
          }}
        />
      </div>

      {service === 'ntfy' ? (
        <div className="grid grid-cols-1 gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
          <Field label="Server" hint={insecure ? 'Mit http:// geht die Meldung unverschlüsselt durchs Netz.' : 'Ihr eigener Server oder der, den Sie nutzen.'}>
            <TextInput inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://ntfy.example.org" value={ntfyServer} onChange={(event) => setNtfyServer(event.target.value)} />
          </Field>
          <Field label="Thema" hint="Das Thema, das Sie in der ntfy-App abonniert haben.">
            <TextInput autoComplete="off" spellCheck={false} value={ntfyTopic} onChange={(event) => setNtfyTopic(event.target.value)} />
          </Field>
          <Field label="Zugangstoken (wenn der Server einen verlangt)" hint={kept(status?.hasNtfyToken, ntfyToken)} className="sm:col-span-2">
            <TextInput type="password" autoComplete="new-password" placeholder={keep(status?.hasNtfyToken)} value={ntfyToken} onChange={(event) => setNtfyToken(event.target.value)} />
          </Field>
        </div>
      ) : null}

      {service === 'telegram' ? (
        <div className="grid grid-cols-1 gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
          <Field label="Token Ihres Bots" hint={kept(status?.hasTelegramToken, telegramToken) ?? 'Ihr Bot entsteht bei @BotFather in Telegram.'}>
            <TextInput type="password" autoComplete="new-password" placeholder={keep(status?.hasTelegramToken)} value={telegramToken} onChange={(event) => setTelegramToken(event.target.value)} />
          </Field>
          <Field label="Chat-ID" hint="Ihre Zahl, etwa von @userinfobot. Schreiben Sie dem Bot vorher einmal.">
            <TextInput inputMode="numeric" autoComplete="off" spellCheck={false} value={telegramChat} onChange={(event) => setTelegramChat(event.target.value)} />
          </Field>
        </div>
      ) : null}

      {service === 'pushover' ? (
        <div className="grid grid-cols-1 gap-x-[32px] gap-y-[4px] sm:grid-cols-2">
          <Field label="App-Token" hint={kept(status?.hasPushoverToken, pushoverToken) ?? 'Aus Ihrer Anwendung bei pushover.net.'}>
            <TextInput type="password" autoComplete="new-password" placeholder={keep(status?.hasPushoverToken)} value={pushoverToken} onChange={(event) => setPushoverToken(event.target.value)} />
          </Field>
          <Field label="User-Key" hint={kept(status?.hasPushoverUser, pushoverUser) ?? 'Steht auf Ihrer Pushover-Startseite.'}>
            <TextInput type="password" autoComplete="new-password" placeholder={keep(status?.hasPushoverUser)} value={pushoverUser} onChange={(event) => setPushoverUser(event.target.value)} />
          </Field>
        </div>
      ) : null}

      <div className="flex flex-col gap-[8px] border-t border-line pt-[10px]">
        <span className="text-small text-prose">Wann</span>
        {PUSH_KINDS.map((entry) => (
          <Toggle
            key={entry.id}
            label={entry.label}
            checked={wanted[entry.id]}
            onChange={(on) => setWanted(setPushWanted(entry.id as PushKind, on))}
          />
        ))}
      </div>

      <NotLocal />

      <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
        <Button size="sm" disabled={busy !== null} onClick={() => void run('test')}>
          {busy === 'test' ? 'Sendet …' : 'Test senden'}
        </Button>
        <Button size="sm" variant="quiet" disabled={busy !== null} onClick={() => void run('save')}>
          {busy === 'save' ? 'Speichert …' : 'Speichern'}
        </Button>
        {status?.configured ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={async () => {
              await forgetPush()
              onDone()
            }}
          >
            Entfernen
          </Button>
        ) : null}
        {answer ? (
          <p role="status" className={`m-0 min-w-0 flex-1 basis-[240px] text-small leading-[1.5] ${answer.ok ? 'text-prose' : 'font-medium text-ink'}`}>
            <span aria-hidden className={`mr-[8px] inline-block size-[8px] rounded-pill align-middle ${answer.ok ? 'bg-ink' : 'ring-2 ring-inset ring-ink'}`} />
            {answer.message}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The line that opens it: what is set up, as a sentence with an action — or,
 * outside the Windows app, why there is nothing to set up.
 */
export function PushSettingsLink({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const status = usePush((state) => state.status)
  useEffect(() => {
    if (PUSH_SUPPORTED) void refreshPush()
  }, [])

  if (!PUSH_SUPPORTED) {
    return <p className={`m-0 text-small leading-[1.45] text-muted ${className}`}>Meldungen aufs Handy (ntfy, Telegram, Pushover) gibt es in der Windows-App.</p>
  }
  const name = PUSH_SERVICES.find((entry) => entry.id === status?.service)?.label
  return (
    <>
      <p className={`m-0 flex flex-wrap items-baseline gap-x-[10px] text-small text-prose ${className}`}>
        <span>{status?.configured ? `Meldungen aufs Handy über ${name}.` : 'Meldungen aufs Handy sind aus.'}</span>
        <button type="button" onClick={() => setOpen(true)} className="press rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink">
          {status?.configured ? 'Ändern' : 'Einrichten'}
        </button>
      </p>
      <Dialog open={open} onClose={() => setOpen(false)} title="Meldungen aufs Handy" size="md">
        {open ? <PushForm onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </>
  )
}
