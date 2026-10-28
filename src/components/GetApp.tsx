/**
 * „App herunterladen" — where the header's privacy chip used to be.
 *
 * The chip said „Lokal · 1 Ausnahme" on every screen. That Sondra is local
 * goes without saying by now, and the one exception is announced loudly where
 * it happens, in the downloader. The header's spot goes to the thing people
 * actually came looking for up there: the app.
 *
 * Two devices, two tabs, the one in hand first. Each has one way in ink —
 * the setup on Windows, the APK on Android — and beside it the second best:
 * the Microsoft Store, or how an APK gets installed. The rest of Windows
 * (the website as an app, the portable build, the setup for the other
 * processor) stands as rows between lines underneath. The earlier version
 * put six tiles of four sizes and a 76 px wordmark into one sheet, Android as
 * a footnote row — „nicht gut designed“.
 */

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'

import {
  ANDROID_APK,
  IN_ANDROID_APP,
  IN_DESKTOP_APP,
  ON_ANDROID,
  MICROSOFT_STORE,
  WINDOWS_PORTABLE,
  WINDOWS_PORTABLE_ARM64,
  WINDOWS_SETUP,
  WINDOWS_SETUP_ARM64,
  onWindowsArm,
} from '../lib/desktop'
import { useBrowserInstall } from '../lib/install'
import { Mark } from './AppShell'

function DownloadIcon({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`${className} shrink-0`} fill="none" aria-hidden>
      <path
        d="M8 2.5v7.5M4.8 6.8 8 10l3.2-3.2M3 13h10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StoreIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <path d="M3.5 6.5h13l-1 10h-11z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M7 6.5V5a3 3 0 0 1 6 0v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M7.5 9.5h2v2h-2zM10.5 9.5h2v2h-2zM7.5 12.5h2v2h-2zM10.5 12.5h2v2h-2z" fill="currentColor" />
    </svg>
  )
}

function SetupIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <path d="M4 3.5h8l4 4v9H4z M12 3.5v4h4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M10 9v5M7.8 11.8 10 14l2.2-2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A USB stick: the portable build runs from wherever the file lies. */
function StickIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <rect x="5.5" y="7.5" width="9" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7.5 7.5v-5h5v5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M9 4.6h.01M11 4.6h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** A phone: the Android robot would be Google's mark, not what the tile is about. */
function PhoneIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <rect x="5.5" y="2.5" width="9" height="15" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8.8 15h2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function WindowIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 7.5h14" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.4" cy="5.8" r="0.7" fill="currentColor" />
    </svg>
  )
}

/**
 * The mark's five bars, drawn large and faint across the main tile, sliding in
 * one after another when the dialog opens and leaning left on hover.
 */
function Bars() {
  const bars: [number, number, number][] = [
    [9, 5.35, 13.99],
    [7.73, 9.85, 20.95],
    [4.6, 14.35, 22.8],
    [3.33, 18.85, 20.95],
    [9, 23.35, 13.99],
  ]
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      className="pointer-events-none absolute -bottom-[10%] -right-[34%] h-[110%] w-auto fill-current opacity-[0.06] transition-transform duration-[420ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-x-[12px]"
    >
      {bars.map(([x, y, w], index) => (
        <rect key={y} x={x} y={y} width={w} height="3.3" rx="1.65" className="bar-in" style={{ ['--delay' as string]: `${120 + index * 70}ms` }} />
      ))}
    </svg>
  )
}

/**
 * The one way that fits this device, in ink: what it is, the facts as the
 * machine would write them, a sentence, and the action at the foot.
 */
function MainWay({
  href,
  onClick,
  icon,
  title,
  facts,
  children,
  action,
}: {
  href: string
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void
  icon: ReactNode
  title: string
  facts: string
  children: ReactNode
  action: string
}) {
  return (
    <a
      href={href}
      rel="noopener"
      onClick={onClick}
      className="press group relative flex min-h-[260px] flex-col overflow-hidden rounded-card bg-ink p-[24px] text-left text-on-ink sm:p-[28px]"
    >
      <Bars />
      <span className="relative flex items-center gap-[12px]">
        {icon}
        <span className="value text-small opacity-80">{facts}</span>
      </span>
      <span className="relative mt-[28px] flex max-w-[38ch] flex-col gap-[8px]">
        <span className="text-heading-sm font-semibold tracking-[-0.02em]">{title}</span>
        <span className="text-body">{children}</span>
      </span>
      <span className="relative mt-auto pt-[24px]">
        <span className="inline-flex items-center gap-[10px] rounded-nav bg-on-ink px-[20px] py-[12px] text-body font-semibold text-ink transition-transform duration-[130ms] group-hover:translate-x-[4px]">
          <DownloadIcon className="h-[18px] w-[18px]" />
          {action}
        </span>
      </span>
    </a>
  )
}

/** A further way, as a row between lines: icon, name, one sentence, its action. */
function OtherWay({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex max-w-none flex-col gap-[10px] border-t border-line py-[14px] text-ink sm:flex-row sm:items-center sm:gap-[16px]">
      <span className="flex min-w-0 flex-1 items-start gap-[14px]">
        <span className="mt-[2px] text-prose">{icon}</span>
        <span className="flex min-w-0 flex-col gap-[2px]">
          <span className="text-body font-semibold">{title}</span>
          <span className="text-small text-prose">{children}</span>
        </span>
      </span>
      {action ? <span className="shrink-0 self-start pl-[38px] sm:self-auto sm:pl-0">{action}</span> : null}
    </li>
  )
}

const SMALL_ACTION =
  'press inline-flex items-center gap-[8px] rounded-nav px-[14px] py-[8px] text-small font-semibold text-ink ring-1 ring-inset ring-rule hover:bg-panel-soft'

type Platform = 'windows' | 'android'

function DefenderDialog({
  open,
  downloadUrl,
  portable,
  onClose,
}: {
  open: boolean
  downloadUrl: string
  /** The portable build: nothing is installed, the file starts as it is. */
  portable: boolean
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  if (!open) return null

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
      className="pop m-auto max-h-[calc(100dvh-32px)] w-[min(580px,calc(100vw-32px))] overflow-y-auto rounded-[20px] shadow-2xl overflow-hidden bg-raised p-0 text-prose backdrop:bg-ink/60 backdrop:backdrop-blur-[3px] ring-1 ring-rule/40"
    >
      <div className="flex flex-col gap-[20px] p-[24px] sm:p-[32px]">
        <div className="flex items-start justify-between gap-[16px]">
          <h3 className="m-0 text-subheading font-semibold text-ink">
            Warum Windows warnt
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schliessen"
            className="press -mr-[8px] -mt-[4px] flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-pill text-muted hover:bg-panel-soft hover:text-ink"
          >
            <svg viewBox="0 0 16 16" className="h-[16px] w-[16px]" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* What Windows will say, quoted — in the page's own face. It was a
            box in Windows blue, a colour this palette does not have. */}
        <figure className="m-0 flex flex-col gap-[4px] rounded-card bg-panel-soft p-[16px]">
          <blockquote className="m-0 text-body font-semibold text-ink">„Der Computer wurde durch Windows geschützt“</blockquote>
          <figcaption className="text-small text-prose">
            Microsoft Defender SmartScreen hat den Start einer unbekannten App verhindert.
          </figcaption>
        </figure>

        <p className="m-0 text-small leading-[1.55] text-prose">
          Die Warnung sagt nichts über den Inhalt der Datei. Windows kennt den Herausgeber nicht, weil die Datei nicht
          signiert ist — eine Signatur setzt ein kostenpflichtiges Zertifikat voraus. Neue, selten geladene Programme
          stuft SmartScreen deshalb vorsorglich als „unbekannt“ ein.
        </p>

        <div className="flex flex-col gap-[8px] border-t border-line pt-[12px]">
          <p className="m-0 text-small font-semibold text-ink">{portable ? 'So starten Sie Sondra' : 'So starten Sie die Installation'}</p>
          <ol className="m-0 list-decimal space-y-[4px] pl-[20px] text-small text-prose">
            <li>
              Im blauen Fenster auf <strong className="font-semibold text-ink">„Weitere Informationen“</strong> klicken.
            </li>
            <li>
              Danach unten rechts auf <strong className="font-semibold text-ink">„Trotzdem ausführen“</strong>.
            </li>
          </ol>
          <p className="m-0 text-small leading-[1.55] text-muted">
            Ist die intelligente App-Steuerung eingeschaltet, blockiert Windows unsignierte Programme ganz.
            {MICROSOFT_STORE ? (
              <>
                {' '}
                Dann installieren Sie Sondra über den{' '}
                <a href={MICROSOFT_STORE} target="_blank" rel="noreferrer" className="text-ink underline underline-offset-2">
                  Microsoft Store
                </a>
                .
              </>
            ) : null}
          </p>
        </div>

        <div className="mt-[8px] flex flex-wrap items-center gap-[12px]">
          <a
            href={downloadUrl}
            onClick={() => {
              setTimeout(onClose, 100)
            }}
            className="press inline-flex items-center gap-[8px] rounded-nav bg-ink px-[20px] py-[12px] text-body font-semibold text-on-ink hover:bg-ink-hover"
          >
            <DownloadIcon />
            {portable ? 'Portable laden' : 'Setup laden'}
          </a>
          <button
            type="button"
            onClick={onClose}
            className="press rounded-nav px-[16px] py-[12px] text-body text-ink ring-1 ring-inset ring-rule hover:bg-panel-soft"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </dialog>
  )
}

export const OPEN_GET_APP_EVENT = 'sondra:get-app'

export function openGetAppDialog() {
  window.dispatchEvent(new Event(OPEN_GET_APP_EVENT))
}

export function GetAppButton() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [defender, setDefender] = useState<{ url: string; portable: boolean } | null>(null)
  // The device in hand comes first; the other is one click away.
  const [platform, setPlatform] = useState<Platform>(ON_ANDROID ? 'android' : 'windows')
  const browser = useBrowserInstall()
  /** Windows on Arm gets its own build as the main offer, the other one as a row. */
  const [arm, setArm] = useState(false)
  useEffect(() => {
    void onWindowsArm().then(setArm)
  }, [])

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_GET_APP_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_GET_APP_EVENT, onOpen)
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  if (IN_DESKTOP_APP || IN_ANDROID_APP) return null

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const setup = arm ? WINDOWS_SETUP_ARM64 : WINDOWS_SETUP
  const otherSetup = arm ? WINDOWS_SETUP : WINDOWS_SETUP_ARM64
  const platforms: { id: Platform; label: string; icon: ReactNode }[] = [
    { id: 'windows', label: 'Windows', icon: <WindowIcon className="h-[16px] w-[16px]" /> },
    { id: 'android', label: 'Android', icon: <PhoneIcon className="h-[16px] w-[16px]" /> },
  ]
  if (ON_ANDROID) platforms.reverse()

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="press flex shrink-0 items-center gap-[8px] rounded-nav bg-panel-soft px-[12px] py-[8px] text-small text-ink hover:bg-panel-mid"
      >
        <DownloadIcon />
        {/* Below a desk the label shortens, the button stays; on the
            narrowest phone only the arrow is seen, the name is still read out. */}
        <span className="hidden lg:inline">App herunterladen</span>
        <span className="lg:hidden max-[359px]:sr-only">App</span>
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="get-app-title"
        onClose={close}
        onClick={(event) => {
          // A click on the backdrop lands on the dialog element itself.
          if (event.target === dialogRef.current) close()
        }}
        className="pop m-auto max-h-[calc(100dvh-32px)] w-[min(860px,calc(100vw-32px))] overflow-y-auto overscroll-contain rounded-[20px] bg-raised p-0 text-prose shadow-2xl ring-1 ring-rule/40 backdrop:bg-ink/60 backdrop:backdrop-blur-[3px]"
      >
        <div className="flex flex-col gap-[22px] p-[20px] sm:p-[32px]">
          <div className="flex items-start justify-between gap-[16px]">
            <div className="flex items-center gap-[14px]">
              <Mark className="h-[36px] w-[36px] text-ink sm:h-[44px] sm:w-[44px]" />
              <div className="flex flex-col">
                <h2 id="get-app-title" className="m-0 text-subheading font-semibold text-ink sm:text-heading-sm">
                  Sondra als App
                </h2>
                <p className="text-small text-prose sm:text-body">Alle Werkzeuge im eigenen Fenster, ohne Browser drumherum.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Schliessen"
              className="press -mr-[8px] -mt-[4px] flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-pill text-prose hover:bg-panel-soft hover:text-ink"
            >
              <svg viewBox="0 0 16 16" className="h-[16px] w-[16px]" fill="none" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div role="tablist" aria-label="Gerät" className="flex gap-[6px]">
            {platforms.map((entry) => {
              const on = platform === entry.id
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  id={`get-app-tab-${entry.id}`}
                  aria-selected={on}
                  aria-controls="get-app-ways"
                  onClick={() => setPlatform(entry.id)}
                  className={`press inline-flex items-center gap-[8px] rounded-pill px-[14px] py-[7px] text-small font-semibold ${
                    on ? 'bg-ink text-on-ink' : 'text-prose ring-1 ring-inset ring-line hover:text-ink hover:ring-rule'
                  }`}
                >
                  {entry.icon}
                  {entry.label}
                </button>
              )
            })}
          </div>

          <div id="get-app-ways" role="tabpanel" aria-labelledby={`get-app-tab-${platform}`} className="flex flex-col gap-[18px]">
            {platform === 'windows' ? (
              <>
                <div className="grid grid-cols-1 gap-[12px] md:grid-cols-[1.35fr_1fr]">
                  <MainWay
                    href={setup}
                    onClick={(event) => {
                      event.preventDefault()
                      setDefender({ url: setup, portable: false })
                    }}
                    icon={<SetupIcon className="h-[28px] w-[28px]" />}
                    title="Setup für Windows"
                    facts={arm ? '.exe · Arm64 · Windows 10 und 11' : '.exe · 130 MB · Windows 10 und 11'}
                    action="Herunterladen"
                  >
                    Lädt Videoportale mit yt-dlp in voller Auflösung, öffnet Dateien aus dem Explorer und aktualisiert sich
                    selbst.
                  </MainWay>

                  {MICROSOFT_STORE ? (
                    <a
                      href={MICROSOFT_STORE}
                      target="_blank"
                      rel="noopener"
                      onClick={() => setTimeout(close, 0)}
                      className="press group flex flex-col rounded-card bg-panel-soft p-[24px] text-left text-ink hover:bg-panel-mid sm:p-[28px]"
                    >
                      <span className="flex items-center gap-[12px]">
                        <StoreIcon className="h-[28px] w-[28px]" />
                        <span className="value text-small text-prose">.msix</span>
                      </span>
                      <span className="mt-[28px] flex flex-col gap-[8px]">
                        <span className="text-heading-sm font-semibold tracking-[-0.02em]">Microsoft Store</span>
                        <span className="text-body text-prose">Installiert sich ohne Warnung von Windows, Updates kommen über den Store.</span>
                      </span>
                      <span className="mt-auto pt-[24px]">
                        <span className="inline-flex items-center gap-[10px] rounded-nav bg-ink px-[20px] py-[12px] text-body font-semibold text-on-ink group-hover:bg-ink-hover">
                          Im Store öffnen
                        </span>
                      </span>
                    </a>
                  ) : (
                    <div aria-disabled="true" className="flex flex-col rounded-card bg-panel-soft p-[24px] text-ink sm:p-[28px]">
                      <StoreIcon className="h-[28px] w-[28px] opacity-60" />
                      <span className="mt-[28px] text-heading-sm font-semibold tracking-[-0.02em]">Microsoft Store</span>
                      <span className="mt-auto pt-[24px] text-body font-semibold text-prose">Bald verfügbar</span>
                    </div>
                  )}
                </div>

                <ul className="flex flex-col border-b border-line">
                  {/* The website as an app: no setup at all, and the one way
                      that works with Smart App Control while the setup is
                      unsigned. */}
                  <OtherWay
                    icon={<WindowIcon className="h-[24px] w-[24px]" />}
                    title="Website als App"
                    action={
                      browser.available && !browser.installed ? (
                        <button type="button" onClick={() => void browser.install().then((done) => done && close())} className={SMALL_ACTION}>
                          Installieren
                        </button>
                      ) : undefined
                    }
                  >
                    {browser.installed
                      ? 'Ist installiert — Sondra steht im Startmenü.'
                      : browser.available
                        ? 'Ohne Setup, aus Edge oder Chrome. Läuft auch mit der intelligenten App-Steuerung.'
                        : 'In Edge oder Chrome: Menü ⋯ → Apps → „Sondra installieren“. Läuft auch mit der intelligenten App-Steuerung.'}
                  </OtherWay>
                  {/* One .exe, nothing installed, its data in „Sondra-Daten“
                      beside it — for a USB stick or a computer without rights
                      to install. */}
                  <OtherWay
                    icon={<StickIcon className="h-[24px] w-[24px]" />}
                    title="Portabel"
                    action={
                      <a
                        href={arm ? WINDOWS_PORTABLE_ARM64 : WINDOWS_PORTABLE}
                        rel="noopener"
                        onClick={(event) => {
                          event.preventDefault()
                          setDefender({ url: arm ? WINDOWS_PORTABLE_ARM64 : WINDOWS_PORTABLE, portable: true })
                        }}
                        className={SMALL_ACTION}
                      >
                        <DownloadIcon />
                        Herunterladen
                      </a>
                    }
                  >
                    Eine .exe ohne Installation, auch vom USB-Stick. Die Daten liegen daneben im Ordner „Sondra-Daten“.
                  </OtherWay>
                  <OtherWay
                    icon={<SetupIcon className="h-[24px] w-[24px]" />}
                    title={arm ? 'Setup für x64-Prozessoren' : 'Setup für Arm-Prozessoren'}
                    action={
                      <a
                        href={otherSetup}
                        rel="noopener"
                        onClick={(event) => {
                          event.preventDefault()
                          setDefender({ url: otherSetup, portable: false })
                        }}
                        className={SMALL_ACTION}
                      >
                        <DownloadIcon />
                        Herunterladen
                      </a>
                    }
                  >
                    {arm ? 'Für Rechner mit Intel- oder AMD-Prozessor.' : 'Für Rechner mit Snapdragon oder einem anderen Arm-Prozessor.'}
                  </OtherWay>
                </ul>

                <p className="max-w-[72ch] text-small leading-[1.5] text-prose">
                  Setup und portable Fassung sind noch nicht signiert: Windows warnt beim ersten Start — „Weitere
                  Informationen“, dann „Trotzdem ausführen“. Mit der intelligenten App-Steuerung starten sie gar nicht; dann
                  den Store oder die Website als App nehmen.
                </p>
              </>
            ) : (
              <div className="grid grid-cols-1 gap-[12px] md:grid-cols-[1.35fr_1fr]">
                <MainWay
                  href={ANDROID_APK}
                  onClick={() => setTimeout(close, 100)}
                  icon={<PhoneIcon className="h-[28px] w-[28px]" />}
                  title="App für Android"
                  facts=".apk · ab Android 7"
                  action={ON_ANDROID ? 'Herunterladen' : 'APK herunterladen'}
                >
                  Lädt Videoportale mit yt-dlp direkt auf das Telefon, in voller Auflösung. Merkliste und Ordner kommen über
                  Google Drive von den anderen Geräten mit.
                </MainWay>

                <div className="flex flex-col gap-[12px] rounded-card bg-panel-soft p-[24px] text-ink sm:p-[28px]">
                  <h3 className="m-0 text-body font-semibold">So installieren Sie sie</h3>
                  <ol className="m-0 flex list-decimal flex-col gap-[8px] pl-[20px] text-small text-prose marker:text-ink">
                    {ON_ANDROID ? null : (
                      <li>
                        Auf dem Telefon <span className="value text-ink">sondra.lizge.ch</span> öffnen und hier „Android“
                        wählen.
                      </li>
                    )}
                    <li>Die heruntergeladene Datei öffnen.</li>
                    <li>Android fragt einmal, ob der Browser Apps installieren darf — erlauben.</li>
                    <li>Eine neue Fassung meldet die App selbst und installiert sich über die alte.</li>
                  </ol>
                </div>
              </div>
            )}
          </div>
        </div>
      </dialog>

      <DefenderDialog
        open={Boolean(defender)}
        downloadUrl={defender?.url ?? ''}
        portable={defender?.portable ?? false}
        onClose={() => setDefender(null)}
      />
    </>
  )
}
