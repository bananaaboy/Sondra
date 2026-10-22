/**
 * Google Drive on the page: one dialog for all of it, and a button in the
 * header that signs in, opens the dialog and shows what is going there.
 *
 * The dialog is where Drive is connected, where the two switches live
 * (downloads, Merkliste), where a project comes back from Drive, and where
 * each upload says how it went. The buttons that send something stand where
 * the thing is — „In Drive" beside „Projekt speichern", a cloud on each file
 * of the session — and none of them shows before Drive is set up.
 *
 * It is the one place Sondra sends files away, so the dialog says that on
 * `panel-cool`, the tint kept for exactly that statement.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { formatBytes } from '../lib/format'
import {
  cancelDriveSignIn,
  clearDriveJobs,
  connectDrive,
  disconnectDrive,
  driveFolderUrl,
  DRIVE_IN_APP,
  driveLinked,
  driveWaitsForSignIn,
  DRIVE_PROBLEM,
  DriveError,
  folderPath,
  initDrive,
  listDriveProjects,
  openDriveDialog,
  openDriveProject,
  OPEN_DRIVE_EVENT,
  retryDriveJob,
  saveAssetsToDrive,
  saveProjectToDrive,
  setDriveSetting,
  syncMerklisteNow,
  useDrive,
  type DriveFile,
  type DriveJob,
  type MerkSync,
} from '../lib/googleDrive'
import { useMerkliste } from '../lib/merkliste'
import { useSession } from '../state/store'
import { Button, Dialog, Notice, Toggle } from './ui/primitives'

const linkClass =
  'press inline-flex items-center gap-[6px] rounded-nav text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink disabled:cursor-not-allowed disabled:opacity-40'

/** Drive's own shape would be its brand; this is a cloud with an arrow, which is what happens. */
export function DriveIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} fill="none" aria-hidden>
      <path
        d="M4.6 12.6H4a3 3 0 01-.4-6 4.2 4.2 0 018.1-.9 3.2 3.2 0 01.3 6.4h-.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 13.6V8.4M5.9 10.3L8 8.2l2.1 2.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })
}

function day(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? `heute ${clock(date.getTime())}`
    : date.toLocaleDateString('de-CH', { day: 'numeric', month: 'short', year: 'numeric' })
}

function problemText(error: unknown): string {
  return error instanceof DriveError ? DRIVE_PROBLEM[error.code] : error instanceof Error ? error.message : DRIVE_PROBLEM.failed
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

const TREE: { path: string; what: string }[] = [
  { path: 'Projekte', what: 'Projekte (.sondra)' },
  { path: 'Dateien/Ton · Video · Bilder · Andere', what: 'Dateien der Sitzung, nach Art' },
  { path: 'Heruntergeladen', what: 'Was Sie herunterladen, auf Wunsch von selbst' },
  { path: 'Merkliste', what: 'Die Merkliste als Sicherung' },
]

function FolderTree() {
  return (
    <div className="flex flex-col gap-[6px]">
      <p className="value text-small text-ink">Sondra/</p>
      <ul className="flex flex-col">
        {TREE.map((entry) => (
          <li
            key={entry.path}
            className="grid grid-cols-1 gap-x-[16px] border-t border-line py-[7px] pl-[16px] first:border-t-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
          >
            <span className="value min-w-0 break-words text-small text-ink">{entry.path}/</span>
            <span className="text-small text-prose">{entry.what}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The one sentence that matters: this leaves the device. */
function NotLocal() {
  return (
    <div role="note" className="rounded-nav bg-panel-cool px-[12px] py-[10px] text-small leading-[1.55] text-ink ring-1 ring-inset ring-rule">
      <span className="font-semibold">Was Sie in Drive speichern, verlässt dieses Gerät und liegt bei Google.</span>{' '}
      <span className="text-prose">Sondra sieht in Ihrem Drive nur, was es selbst dort abgelegt hat, und schickt nichts ohne Ihr Zutun.</span>
    </div>
  )
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-[10px] border-t border-line pt-[16px]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[4px]">
        <h3 className="m-0 text-body font-semibold text-ink">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function jobLine(job: DriveJob): ReactNode {
  if (job.status === 'running') {
    const percent = job.total > 0 ? Math.round((job.loaded / job.total) * 100) : 0
    return (
      <span className="value">
        {percent} % · {formatBytes(job.loaded)} von {formatBytes(job.total)}
      </span>
    )
  }
  if (job.status === 'waiting') return 'Wartet'
  if (job.status === 'skipped') return 'Lag schon dort'
  if (job.status === 'done') return `Gespeichert · ${clock(job.at)}`
  return DRIVE_PROBLEM[job.error ?? 'failed']
}

function JobRow({ job }: { job: DriveJob }) {
  const running = job.status === 'running'
  return (
    <li className="flex flex-col gap-[4px] border-t border-line py-[8px] first:border-t-0">
      <div className="flex items-baseline justify-between gap-[12px]">
        <span className="value min-w-0 truncate text-small text-ink" title={job.name}>
          {job.name}
        </span>
        {job.status === 'failed' ? (
          <button type="button" onClick={() => retryDriveJob(job.id)} className={`${linkClass} shrink-0 text-small`}>
            Erneut
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-[12px] text-micro">
        <span className="value text-muted">{folderPath(job.folder)}</span>
        <span className={job.status === 'failed' ? 'font-semibold text-ink' : 'text-prose'}>
          {job.status === 'failed' ? '! ' : null}
          {jobLine(job)}
        </span>
      </div>
      {running ? (
        <div className="h-[3px] overflow-hidden rounded-pill bg-panel-mid" aria-hidden>
          <div
            className="h-full bg-ink transition-[width] duration-200"
            style={{ width: `${job.total > 0 ? Math.max(2, (job.loaded / job.total) * 100) : 2}%` }}
          />
        </div>
      ) : null}
      {job.status === 'failed' && job.detail ? <span className="break-words text-micro text-muted">{job.detail}</span> : null}
    </li>
  )
}

/** Projects in Drive: listed when the dialog opens, one click to open one. */
function DriveProjects({ onOpened }: { onOpened: () => void }) {
  const connected = useDrive((state) => state.connected)
  const [files, setFiles] = useState<DriveFile[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const jobsDone = useDrive((state) => state.jobs.filter((job) => job.kind === 'project' && job.status === 'done').length)

  const load = async () => {
    setProblem(null)
    try {
      setFiles(await listDriveProjects())
    } catch (error) {
      setFiles(null)
      setProblem(problemText(error))
    }
  }

  useEffect(() => {
    if (connected) void load()
    // A project saved just now belongs in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, jobsDone])

  const open = async (file: DriveFile) => {
    setOpening(file.id)
    setProblem(null)
    try {
      await openDriveProject(file)
      onOpened()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setOpening(null)
    }
  }

  return (
    <Section
      title="Projekte in Drive"
      aside={
        connected ? (
          <button type="button" onClick={() => void load()} className={`${linkClass} text-small`}>
            Neu laden
          </button>
        ) : null
      }
    >
      {!connected ? (
        <p className="text-small text-prose">Nach dem Anmelden stehen hier die Projekte aus Ihrem Drive.</p>
      ) : problem ? (
        <Notice tone="warn" title="Liste nicht geladen">
          {problem}
        </Notice>
      ) : files === null ? (
        <p className="text-small text-prose">Sondra fragt Drive nach den Projekten …</p>
      ) : files.length === 0 ? (
        <p className="text-small text-prose">
          Noch keine. Ein Projekt kommt mit „Projekt in Drive“ hierher — im Dateimenü oder auf der Startseite.
        </p>
      ) : (
        <ul className="flex flex-col">
          {files.map((file) => (
            <li key={file.id} className="flex items-center justify-between gap-[12px] border-t border-line py-[8px] first:border-t-0">
              <span className="flex min-w-0 flex-col">
                <span className="value truncate text-small text-ink" title={file.name}>
                  {file.name}
                </span>
                <span className="value text-micro text-muted">
                  {day(file.modifiedTime)}
                  {file.size !== null ? ` · ${formatBytes(file.size)}` : ''}
                </span>
              </span>
              <Button type="button" size="sm" variant="quiet" disabled={opening !== null} onClick={() => void open(file)}>
                {opening === file.id ? 'Lädt …' : 'Öffnen'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

const MERK_SYNC_PROBLEM: Record<'unreadable', string> = {
  unreadable: 'In Drive liegt unter diesem Namen eine Datei, die Sondra nicht als Merkliste lesen kann. Sie wird nicht überschrieben.',
}

/** What a round with Drive said, in words. */
export function merkSyncProblemText(problem: NonNullable<MerkSync['problem']>): string {
  return problem.code === 'unreadable' ? MERK_SYNC_PROBLEM.unreadable : DRIVE_PROBLEM[problem.code]
}

/** Where the Merkliste stands with Drive: the last round, one running, or what stopped it. */
function MerkSyncLine({ sync, count, busy, onSync }: { sync: MerkSync; count: number; busy: boolean; onSync: () => void }) {
  return (
    // Under the switch's words, not under the switch.
    <div className="flex flex-col gap-[8px] pl-[40px]">
      <p role="status" className="flex flex-wrap items-baseline gap-x-[14px] gap-y-[4px] text-small text-prose">
        <span>
          {sync.running || busy
            ? 'Gleicht ab …'
            : sync.at
              ? `Abgeglichen um ${clock(sync.at)} · ${count} ${count === 1 ? 'Serie' : 'Serien'}${sync.received ? ` · ${sync.received} aus Drive` : ''}`
              : 'Noch nicht abgeglichen.'}
        </span>
        <button type="button" onClick={onSync} disabled={busy || sync.running} className={`${linkClass} text-small`}>
          Jetzt abgleichen
        </button>
      </p>
      {sync.problem && sync.problem.code !== 'expired' ? (
        <Notice tone="warn" title="Abgleich mit Drive">
          {merkSyncProblemText(sync.problem)}
          {sync.problem.detail ? <span className="mt-[4px] block break-words text-micro text-muted">{sync.problem.detail}</span> : null}
        </Notice>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* The dialog                                                                 */
/* -------------------------------------------------------------------------- */

function DriveDialog({ onClose }: { onClose: () => void }) {
  const drive = useDrive()
  const assets = useSession((state) => state.assets)
  const items = useMerkliste()
  const linked = driveLinked(drive)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const act = async (key: string, work: () => Promise<void>) => {
    setBusy(key)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy(null)
    }
  }

  const openFolder = () =>
    act('folder', async () => {
      // Opened before the wait, so the browser lets it through; filled in once
      // Drive named the folder.
      const tab = window.open('', '_blank')
      try {
        const url = await driveFolderUrl('root')
        if (tab) tab.location.href = url
        else window.open(url, '_blank', 'noopener')
      } catch (error) {
        tab?.close()
        throw error
      }
    })

  const syncList = () => act('merkliste', syncMerklisteNow)
  const [showConfig, setShowConfig] = useState(false)
  const [clientIdInput, setClientIdInput] = useState(drive.settings.clientId ?? '')
  const [savedClient, setSavedClient] = useState(false)

  const jobs = drive.jobs
  const finished = jobs.some((job) => job.status === 'done' || job.status === 'skipped' || job.status === 'failed')
  const waitsForSignIn = driveWaitsForSignIn(drive)
  const account = drive.account ?? (drive.settings.email ? { name: drive.settings.name, email: drive.settings.email } : null)

  let head: ReactNode
  if (!drive.ready) {
    head = <p className="text-small text-prose">Sondra fragt nach, ob Google Drive eingerichtet ist …</p>
  } else if (!drive.configured) {
    head = (
      <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
        Google Drive ist in dieser Fassung von Sondra nicht eingerichtet: es fehlt der Zugang, mit dem sich Sondra bei Google
        anmeldet.
      </p>
    )
  } else if (drive.signingIn) {
    head = (
      <div className="flex flex-col items-start gap-[12px]">
        <p className="max-w-[60ch] text-small leading-[1.55] text-prose">
          {DRIVE_IN_APP
            ? 'Die Anmeldung bei Google ist in Ihrem Browser offen. Danach geht es hier von selbst weiter.'
            : 'Die Anmeldung bei Google ist in einem eigenen Fenster offen. Danach geht es hier von selbst weiter.'}
        </p>
        <button type="button" onClick={cancelDriveSignIn} className={`${linkClass} text-small`}>
          Abbrechen
        </button>
        {/* Signed in from the header the first time: what Drive will hold. */}
        {!linked ? (
          <>
            <p className="max-w-[60ch] text-body leading-[1.55] text-prose">Sondra legt in Ihrem Google Drive einen Ordner an und hält ihn geordnet:</p>
            <div className="w-full">
              <FolderTree />
            </div>
            <NotLocal />
          </>
        ) : null}
      </div>
    )
  } else if (!linked) {
    head = (
      <div className="flex flex-col items-start gap-[16px]">
        <p className="max-w-[60ch] text-body leading-[1.55] text-prose">
          Sondra legt in Ihrem Google Drive einen Ordner an und hält ihn geordnet:
        </p>
        <div className="w-full">
          <FolderTree />
        </div>
        <NotLocal />
        <Button type="button" onClick={() => void connectDrive()}>
          <DriveIcon />
          Mit Google verbinden
        </Button>
        {!DRIVE_IN_APP ? (
          <div className="w-full border-t border-line/60 pt-[10px]">
            <button
              type="button"
              onClick={() => setShowConfig((open) => !open)}
              className={`${linkClass} text-micro text-muted`}
            >
              {showConfig ? 'Google Zugangsdaten verbergen' : 'Google Zugangsdaten anpassen (Client-ID)'}
            </button>
            {showConfig ? (
              <div className="mt-[8px] flex flex-col gap-[10px] rounded-card bg-panel-soft/60 p-[12px] ring-1 ring-rule/40">
                <label className="text-small font-medium text-ink">
                  OAuth Client-ID (Webanwendung):
                  <input
                    type="text"
                    value={clientIdInput}
                    onChange={(e) => setClientIdInput(e.target.value)}
                    placeholder="...apps.googleusercontent.com"
                    className="mt-[4px] w-full rounded-nav bg-panel px-[10px] py-[6px] text-small font-mono text-ink ring-1 ring-inset ring-line focus:ring-ink"
                  />
                </label>
                <p className="text-micro text-muted leading-relaxed">
                  Kann in Vercel als Umgebungsvariable <code className="font-mono text-ink">GOOGLE_CLIENT_ID</code> hinterlegt werden oder
                  direkt hier im Browser. Damit die Anmeldung bleibt, gehört das Secret als{' '}
                  <code className="font-mono text-ink">GOOGLE_CLIENT_SECRET</code> nach Vercel — nie hierher: nur der Server liest es, und es
                  gilt nur für die Client-ID aus Vercel.
                </p>
                <p className="text-micro text-muted leading-relaxed">
                  Autorisierter JavaScript-Ursprung:{' '}
                  <span className="font-mono text-ink">{typeof window !== 'undefined' ? window.location.origin : 'https://sondra.lizge.ch'}</span>{' '}
                  · Weiterleitungs-URI:{' '}
                  <span className="font-mono text-ink">
                    {typeof window !== 'undefined' ? `${window.location.origin}/google-drive.html` : 'https://sondra.lizge.ch/google-drive.html'}
                  </span>.
                </p>
                <div className="flex items-center gap-[10px]">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setDriveSetting({ clientId: clientIdInput.trim() })
                      setSavedClient(true)
                      setTimeout(() => setSavedClient(false), 2500)
                    }}
                  >
                    Speichern
                  </Button>
                  {savedClient ? <span className="text-micro text-ink font-medium">Gespeichert</span> : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  } else {
    head = (
      <div className="flex flex-col gap-[12px]">
        <p className="text-body text-prose">
          {account?.email ? (
            <>
              Verbunden als {account.name ? `${account.name} · ` : ''}
              <span className="value text-ink">{account.email}</span>
            </>
          ) : (
            'Mit Google Drive verbunden.'
          )}
        </p>
        {!drive.connected ? (
          <div className="flex flex-wrap items-center gap-x-[16px] gap-y-[8px]">
            <Button type="button" size="sm" onClick={() => void connectDrive()}>
              Anmelden
            </Button>
            <span className="text-small text-prose">
              {waitsForSignIn
                ? 'Die Anmeldung gilt jeweils eine Stunde. Danach geht es mit dem weiter, was wartet.'
                : 'Die Anmeldung gilt jeweils eine Stunde; danach fragt Sondra wieder.'}
            </span>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-[8px]">
          <button type="button" onClick={() => void openFolder()} disabled={busy !== null} className={`${linkClass} text-small`}>
            {busy === 'folder' ? 'Öffnet …' : 'Ordner in Drive öffnen'}
          </button>
          <button type="button" onClick={() => void act('disconnect', disconnectDrive)} disabled={busy !== null} className={`${linkClass} text-small`}>
            Trennen
          </button>
        </div>
        {DRIVE_IN_APP && !drive.lasting ? (
          <p className="text-small text-prose">
            Windows kann die Anmeldung hier nicht verschlüsselt ablegen; nach einem Neustart von Sondra fragt es wieder.
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <Dialog open onClose={onClose} title="Google Drive" size="md">
      <div className="flex flex-col gap-[18px]">
        {head}

        {drive.problem ? (
          <Notice tone="error" title="Anmeldung hat nicht geklappt">
            {DRIVE_PROBLEM[drive.problem.code]}
            {drive.problem.detail ? <span className="mt-[4px] block break-words text-micro text-muted">{drive.problem.detail}</span> : null}
            {!DRIVE_IN_APP && drive.problem.detail === 'redirect_uri_mismatch' ? (
              <span className="mt-[6px] block text-micro text-ink">
                In der Google Cloud Console muss für diesen Client als Weiterleitungs-URI{' '}
                <code className="rounded bg-panel-mid px-[4px] py-[1px] font-mono">
                  {typeof window !== 'undefined' ? `${window.location.origin}/google-drive.html` : 'https://sondra.lizge.ch/google-drive.html'}
                </code>{' '}
                eingetragen sein.
              </span>
            ) : null}
          </Notice>
        ) : null}

        {linked && !drive.signingIn ? (
          <>
            <Section title="Von selbst">
              <div className="flex flex-col gap-[12px]">
                <Toggle
                  label="Heruntergeladenes in Drive speichern"
                  checked={drive.settings.autoDownloads}
                  onChange={(next) => setDriveSetting({ autoDownloads: next })}
                  hint="Jeder fertige Download kommt auch nach Sondra/Heruntergeladen."
                />
                <Toggle
                  label="Merkliste über Drive abgleichen"
                  checked={drive.settings.merkliste}
                  onChange={(next) => setDriveSetting({ merkliste: next })}
                  hint="Jedes Gerät mit diesem Google-Konto hat dieselbe Liste, auch die Website — statt Anytype oder daneben. Sie liegt als Sondra-Merkliste.json im Ordner Merkliste; Drive behält die älteren Fassungen."
                />
                {drive.settings.merkliste ? (
                  <MerkSyncLine sync={drive.merkSync} count={items.length} busy={busy === 'merkliste'} onSync={() => void syncList()} />
                ) : null}
              </div>
            </Section>

            {assets.length > 0 ? (
              <Section title="Jetzt speichern">
                <div className="flex flex-wrap items-center gap-[8px]">
                  <Button type="button" size="sm" variant="quiet" onClick={() => saveProjectToDrive()}>
                    Projekt in Drive
                  </Button>
                  <Button type="button" size="sm" variant="quiet" onClick={() => saveAssetsToDrive(assets)}>
                    {assets.length === 1 ? 'Datei der Sitzung' : `Alle ${assets.length} Dateien der Sitzung`}
                  </Button>
                </div>
              </Section>
            ) : null}

            <DriveProjects onOpened={onClose} />

            {jobs.length > 0 ? (
              <Section
                title="Übertragungen"
                aside={
                  finished ? (
                    <button type="button" onClick={clearDriveJobs} className={`${linkClass} text-small`}>
                      Liste leeren
                    </button>
                  ) : null
                }
              >
                <ul className="flex flex-col" aria-live="polite">
                  {[...jobs].reverse().map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </ul>
              </Section>
            ) : null}
          </>
        ) : null}

        {problem ? (
          <Notice tone="error" title="Hat nicht geklappt">
            {problem}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* In the header                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Drive in the header, and the dialog's home. Before Drive is connected it
 * says „Drive anmelden" and signs in with the click — the dialog opens
 * beside it and says what happens; the website's hour runs out the same
 * way. Connected, it is a quiet „Drive" that opens the dialog, and while
 * something goes there the share sent so far, „Fehler" when one failed and
 * a short „fertig" when all arrived. Without a Google client it is not
 * there at all.
 */
export function DriveButton() {
  const configured = useDrive((state) => state.configured)
  const jobs = useDrive((state) => state.jobs)
  const connected = useDrive((state) => state.connected)
  const signingIn = useDrive((state) => state.signingIn)
  const [open, setOpen] = useState(false)
  const [settled, setSettled] = useState(false)
  const seenFailed = useRef(new Set<string>())
  const [, refresh] = useState(0)

  useEffect(() => initDrive(), [])
  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_DRIVE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_DRIVE_EVENT, onOpen)
  }, [])

  const active = jobs.filter((job) => job.status === 'waiting' || job.status === 'running')
  const failed = jobs.filter((job) => job.status === 'failed' && !seenFailed.current.has(job.id))

  // „fertig" stays a moment after the last upload, then goes.
  const lastActive = useRef(0)
  useEffect(() => {
    if (active.length > 0) {
      lastActive.current = active.length
      setSettled(false)
      return
    }
    if (lastActive.current === 0) return
    lastActive.current = 0
    setSettled(true)
    const timer = window.setTimeout(() => setSettled(false), 3000)
    return () => window.clearTimeout(timer)
  }, [active.length])

  if (!configured && DRIVE_IN_APP) return null

  const signIn = !connected && !signingIn
  const openDialog = () => {
    for (const job of failed) seenFailed.current.add(job.id)
    refresh((value) => value + 1)
    setOpen(true)
  }

  // Wide, then short for a phone — where an icon alone has to do.
  let label: ReactNode = 'Drive'
  let short = ''
  let title = 'Google Drive'
  if (signingIn) {
    label = 'Anmeldung offen …'
    title = 'Die Anmeldung bei Google ist offen'
  } else if (!connected) {
    label = 'Drive anmelden'
    title =
      active.length > 0 ? 'Bei Google anmelden, damit die Uploads weitergehen' : 'Bei Google anmelden, um in Ihrem Drive zu speichern'
  } else if (active.length > 0) {
    const total = active.reduce((sum, job) => sum + job.total, 0)
    const loaded = active.reduce((sum, job) => sum + (job.status === 'running' ? job.loaded : 0), 0)
    const percent = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0
    label = (
      <>
        Drive <span className="value">{percent} %</span>
      </>
    )
    short = `${percent} %`
  } else if (failed.length > 0) {
    label = 'Drive · Fehler'
    short = '!'
  } else if (settled) {
    label = 'Drive · fertig'
    short = '✓'
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          // The website's sign-in has to open within this click.
          if (signIn) void connectDrive()
          openDialog()
        }}
        aria-haspopup="dialog"
        title={title}
        className="press flex shrink-0 items-center gap-[8px] rounded-nav px-[8px] py-[8px] text-small text-ink ring-1 ring-inset ring-rule hover:bg-panel-soft min-[360px]:px-[10px] sm:px-[12px]"
      >
        <DriveIcon />
        <span className="sr-only sm:not-sr-only">{label}</span>
        {short ? (
          <span aria-hidden className="value sm:hidden">
            {short}
          </span>
        ) : null}
      </button>
      {open ? <DriveDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/**
 * „In Drive" beside „Projekt speichern": the project goes there, or — before
 * Drive is connected — the dialog opens that connects it.
 */
export function ProjectToDriveButton({ className, onDone }: { className: string; onDone?: () => void }) {
  const configured = useDrive((state) => state.configured)
  const linked = useDrive((state) => driveLinked(state))
  if (!configured && DRIVE_IN_APP) return null
  return (
    <button
      type="button"
      onClick={() => {
        if (linked) saveProjectToDrive()
        else openDriveDialog()
        onDone?.()
      }}
      className={className}
      aria-label={linked ? 'Projekt in Google Drive speichern' : 'Google Drive verbinden, um das Projekt dort zu speichern'}
      title={linked ? 'Speichert das Projekt in Google Drive, Ordner Sondra/Projekte' : 'Google Drive verbinden'}
    >
      <DriveIcon className="h-3.5 w-3.5" />
      <span>In Drive</span>
    </button>
  )
}
