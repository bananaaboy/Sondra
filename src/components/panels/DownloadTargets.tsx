/**
 * Where downloads go besides the session — set up in the Downloader, next to
 * the choice of delivery: how series folders are named (for a folder, a NAS
 * and WebDAV alike) and the WebDAV folder itself. Also the field to type a
 * network path into, which the folder picker does not list.
 *
 * WebDAV takes files off this device, so its one sentence sits on `panel-cool`,
 * the tint kept for that statement (as with Drive). The address and the folder
 * start empty: nothing is built in.
 */

import { useEffect, useState } from 'react'

import { APP_BRIDGE } from '../../lib/desktop'
import { FOLDER_SCHEMES, type FolderScheme } from '../../lib/storageLayout'
import {
  configureWebdav,
  forgetWebdav,
  refreshWebdav,
  testWebdav,
  useWebdav,
  WEBDAV_SUPPORTED,
} from '../../lib/webdav'
import { Button, Field, Select, TextInput } from '../ui/primitives'
import type { DownloadDeliveryMode } from './DownloaderPanel'

const needsLayout = (mode: DownloadDeliveryMode) =>
  mode === 'save_only' || mode === 'drive_and_save' || mode === 'webdav_only' || mode === 'drive_and_webdav'
const needsWebdav = (mode: DownloadDeliveryMode) => mode === 'webdav_only' || mode === 'drive_and_webdav'

/** The one sentence that matters: this leaves the device. */
function NotLocal() {
  return (
    <div role="note" className="rounded-nav bg-panel-cool px-[12px] py-[10px] text-small leading-[1.55] text-ink ring-1 ring-inset ring-rule">
      <span className="font-semibold">Was Sie an WebDAV senden, verlässt dieses Gerät und liegt auf dem Server, den Sie eintragen.</span>{' '}
      <span className="text-prose">
        Sondra kennt diesen Server nicht vorher, leitet nichts über eigene Server und speichert das Passwort nur verschlüsselt in diesem Windows-Konto.
      </span>
    </div>
  )
}

function WebdavCard() {
  const status = useWebdav((state) => state.status)
  const [url, setUrl] = useState('')
  const [basePath, setBasePath] = useState('/Sondra')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [answer, setAnswer] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    void refreshWebdav()
  }, [])
  // What the app holds fills the form once; typing is never overwritten after that.
  const [filled, setFilled] = useState(false)
  useEffect(() => {
    if (filled || !status) return
    setFilled(true)
    if (status.configured) {
      setUrl(status.url)
      setBasePath(status.basePath)
      setUsername(status.username)
    }
  }, [status, filled])

  const save = async () => {
    const saved = await configureWebdav({ url, username, basePath, password: password === '' ? undefined : password })
    if (saved.ok) setPassword('')
    return saved
  }

  const onSave = async () => {
    setBusy('save')
    setAnswer(null)
    try {
      const saved = await save()
      setAnswer(saved.ok ? { ok: true, message: 'Gespeichert.' } : saved)
    } finally {
      setBusy(null)
    }
  }

  const onTest = async () => {
    setBusy('test')
    setAnswer(null)
    try {
      const saved = await save()
      setAnswer(saved.ok ? await testWebdav() : saved)
    } finally {
      setBusy(null)
    }
  }

  const onForget = async () => {
    setBusy('save')
    try {
      await forgetWebdav()
      setUrl('')
      setBasePath('/Sondra')
      setUsername('')
      setPassword('')
      setAnswer({ ok: true, message: 'Adresse und Passwort sind von diesem Computer entfernt.' })
    } finally {
      setBusy(null)
    }
  }

  const insecure = /^http:\/\//i.test(url.trim())

  return (
    <div className="flex flex-col gap-[12px] rounded-card bg-panel-soft p-[14px]">
      <h4 className="m-0 text-body font-semibold text-ink">WebDAV-Ordner</h4>
      <NotLocal />
      <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
        <Field label="Adresse" hint={insecure ? 'Mit http:// geht das Passwort unverschlüsselt durchs Netz. Nehmen Sie, wenn der Server es kann, https://.' : undefined}>
          <TextInput
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://nas.example/remote.php/dav/files/name"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field label="Zielpfad auf dem Server" hint="Der Ordner, unter dem Serien und Staffeln angelegt werden.">
          <TextInput autoComplete="off" spellCheck={false} placeholder="/Sondra" value={basePath} onChange={(event) => setBasePath(event.target.value)} />
        </Field>
        <Field label="Benutzername">
          <TextInput autoComplete="off" spellCheck={false} value={username} onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <Field
          label="Passwort oder App-Passwort"
          hint={
            status?.hasPassword && password === ''
              ? status.remembered
                ? 'Gespeichert, verschlüsselt. Leer lassen, um es zu behalten.'
                : 'Gemerkt, bis Sondra geschlossen wird — dieses System hat keinen Schlüsselspeicher.'
              : undefined
          }
        >
          <TextInput
            type="password"
            autoComplete="new-password"
            placeholder={status?.hasPassword ? '••••••••' : ''}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-[10px]">
        <Button size="sm" variant="quiet" disabled={busy !== null || !url.trim()} onClick={() => void onSave()}>
          {busy === 'save' ? 'Speichert …' : 'Speichern'}
        </Button>
        <Button size="sm" disabled={busy !== null || !url.trim()} onClick={() => void onTest()}>
          {busy === 'test' ? 'Prüft …' : 'Speichern & Verbindung testen'}
        </Button>
        {status?.configured ? (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void onForget()}>
            Entfernen
          </Button>
        ) : null}
      </div>
      {answer ? (
        <p role="status" className={`m-0 text-small leading-[1.5] ${answer.ok ? 'text-ink' : 'text-prose'}`}>
          <span aria-hidden className={`mr-[8px] inline-block size-[8px] rounded-pill align-middle ${answer.ok ? 'bg-ink' : 'ring-2 ring-inset ring-ink'}`} />
          {answer.message}
        </p>
      ) : status?.configured ? null : (
        <p className="m-0 text-small leading-[1.5] text-muted">Bis hier etwas eingetragen ist, landen Downloads in der Sitzung.</p>
      )}
    </div>
  )
}

/** The folder scheme and, for WebDAV, its set-up. Nothing for modes that need neither. */
export function DownloadTargets({
  mode,
  scheme,
  onScheme,
}: {
  mode: DownloadDeliveryMode
  scheme: FolderScheme
  onScheme: (scheme: FolderScheme) => void
}) {
  return (
    <div className="flex flex-col gap-[12px]">
      {!WEBDAV_SUPPORTED ? (
        <p className="m-0 text-small leading-[1.45] text-muted">
          WebDAV (NAS, Nextcloud) gibt es in der Windows-App: Server dieser Art lassen Browser nicht an ihre Dateien.
        </p>
      ) : null}
      {needsLayout(mode) ? (
        <Field label="Ordnerstruktur" hint="Gilt für einen Ordner oder ein NAS und für WebDAV. Ohne Serie liegt die Datei direkt im Zielordner.">
          <Select value={scheme} onChange={(event) => onScheme(event.target.value as FolderScheme)}>
            {FOLDER_SCHEMES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label} ({entry.example})
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {needsWebdav(mode) && WEBDAV_SUPPORTED ? <WebdavCard /> : null}
    </div>
  )
}

/**
 * The target folder typed in — a network path such as \\NAS\Medien\Anime, which
 * the picker does not list. The app checks it is absolute and writable before
 * it takes it; nothing changes otherwise.
 */
export function DownloadDirField({ value, onChange }: { value: string; onChange: (dir: string) => void }) {
  const [text, setText] = useState(value)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setText(value), [value])
  if (!APP_BRIDGE?.setDownloadDir) return null

  const apply = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const answer = await APP_BRIDGE?.setDownloadDir?.(text.trim())
      if (answer?.ok && answer.dir) onChange(answer.dir)
      else if (answer?.reason === 'not-absolute') setProblem('Das ist kein vollständiger Pfad — etwa C:\\Filme oder \\\\NAS\\Medien.')
      else setProblem(`Dort lässt sich nicht schreiben${answer?.detail ? ` (${answer.detail})` : ''}.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex flex-wrap items-center gap-[8px]">
        <TextInput
          aria-label="Ordner oder NAS-Pfad"
          className="min-w-[220px] flex-1"
          autoComplete="off"
          spellCheck={false}
          placeholder="\\NAS\Medien\Anime"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button size="sm" variant="quiet" disabled={busy || !text.trim() || text.trim() === value} onClick={() => void apply()}>
          {busy ? 'Prüft …' : 'Übernehmen'}
        </Button>
      </div>
      {problem ? (
        <p role="status" className="m-0 text-small leading-[1.5] text-prose">
          {problem}
        </p>
      ) : null}
    </div>
  )
}
