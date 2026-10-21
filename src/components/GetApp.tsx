/**
 * „App herunterladen" — where the header's privacy chip used to be.
 *
 * The chip said „Lokal · 1 Ausnahme" on every screen. That Sondra is local
 * goes without saying by now, and the one exception is announced loudly where
 * it happens, in the downloader. The header's spot goes to the thing people
 * actually came looking for up there: the app.
 *
 * Four ways, weighted as asked: the setup and the Microsoft Store are the two
 * large tiles side by side; the website installed as an app and the portable
 * build are the two narrow ones underneath. The store tile links to the listing; without one it stays in
 * place and says „Bald verfügbar" on its face — on a tile this size a
 * hover-only hint reads as broken.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  IN_DESKTOP_APP,
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

function WindowIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 7.5h14" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.4" cy="5.8" r="0.7" fill="currentColor" />
    </svg>
  )
}

/** One of the two large tiles: what it is, what it does, and its action at the foot. */
function MainTile({
  icon,
  title,
  facts,
  children,
  action,
}: {
  icon: ReactNode
  title: string
  facts: string
  children: ReactNode
  action: ReactNode
}) {
  return (
    <>
      <span className="relative flex items-start justify-between gap-[12px]">
        {icon}
        <span className="value rounded-pill px-[12px] py-[4px] text-small ring-1 ring-inset ring-current/35">{facts}</span>
      </span>
      <span className="relative mt-[40px] flex max-w-[34ch] flex-col gap-[10px] sm:mt-[72px]">
        <span className="text-[40px] font-semibold leading-[1.02] tracking-[-0.03em] sm:text-[48px]">{title}</span>
        <span className="text-body">{children}</span>
      </span>
      <span className="relative mt-auto pt-[32px]">{action}</span>
    </>
  )
}

/**
 * The mark's five bars, drawn huge and faint across the setup tile, sliding in
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
      className="pointer-events-none absolute -bottom-[8%] -right-[16%] h-[92%] w-auto fill-current opacity-[0.07] transition-transform duration-[420ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-x-[14px]"
    >
      {bars.map(([x, y, w], index) => (
        <rect key={y} x={x} y={y} width={w} height="3.3" rx="1.65" className="bar-in" style={{ ['--delay' as string]: `${120 + index * 70}ms` }} />
      ))}
    </svg>
  )
}

const MAIN = 'group relative flex min-h-[300px] flex-col overflow-hidden rounded-card p-[24px] text-left sm:min-h-[420px] sm:p-[36px]'
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

const ACTION = 'inline-flex items-center gap-[10px] rounded-nav px-[22px] py-[14px] text-body font-semibold'

export const OPEN_GET_APP_EVENT = 'sondra:get-app'

export function openGetAppDialog() {
  window.dispatchEvent(new Event(OPEN_GET_APP_EVENT))
}

export function GetAppButton() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [defender, setDefender] = useState<{ url: string; portable: boolean } | null>(null)
  const browser = useBrowserInstall()
  /** Windows on Arm gets its own build as the main offer, the other one beside it. */
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

  if (IN_DESKTOP_APP) return null

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="press flex items-center gap-[8px] rounded-nav bg-panel-soft px-[12px] py-[8px] text-small text-ink hover:bg-panel-mid"
      >
        <DownloadIcon />
        {/* On a phone the label shortens, the button stays. */}
        <span className="hidden sm:inline">App herunterladen</span>
        <span className="sm:hidden">App</span>
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="get-app-title"
        onClose={close}
        onClick={(event) => {
          // A click on the backdrop lands on the dialog element itself.
          if (event.target === dialogRef.current) close()
        }}
        className="pop m-auto max-h-[calc(100dvh-32px)] w-[min(1120px,calc(100vw-32px))] overflow-y-auto overscroll-contain rounded-[20px] shadow-2xl overflow-hidden bg-raised p-0 text-prose backdrop:bg-ink/60 backdrop:backdrop-blur-[3px] ring-1 ring-rule/40"
      >
        <div className="flex flex-col gap-[28px] p-[20px] sm:gap-[36px] sm:p-[40px]">
          <div className="flex items-start justify-between gap-[16px]">
            <div className="flex flex-col gap-[10px]">
              <h2 id="get-app-title" className="m-0 flex flex-wrap items-center gap-x-[10px] gap-y-[4px] text-ink sm:gap-x-[14px]">
                <Mark className="h-[28px] w-[28px] sm:h-[56px] sm:w-[56px]" />
                <span className="font-wordmark text-[38px] font-light leading-none tracking-[-0.01em] sm:text-[76px]">Sondra</span>
                <span className="text-[28px] font-light leading-none tracking-[-0.03em] sm:text-[60px]">Studio</span>
              </h2>
              <p className="text-body text-prose sm:text-subheading">
                Die ganze Werkstatt im eigenen Fenster — für Windows 10 und 11.
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Schliessen"
              className="press -mr-[8px] -mt-[4px] flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-pill text-muted hover:bg-panel-soft hover:text-ink"
            >
              <svg viewBox="0 0 16 16" className="h-[18px] w-[18px]" fill="none" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="flex flex-col gap-[14px]">
            <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2">
              <a
                href={arm ? WINDOWS_SETUP_ARM64 : WINDOWS_SETUP}
                rel="noopener"
                onClick={(e) => {
                  e.preventDefault()
                  setDefender({ url: arm ? WINDOWS_SETUP_ARM64 : WINDOWS_SETUP, portable: false })
                }}
                className={`${MAIN} press bg-ink text-on-ink`}
              >
                <Bars />
                <MainTile
                  icon={<SetupIcon className="h-[52px] w-[52px]" />}
                  title="Setup"
                  facts={arm ? '.exe · Arm64' : '.exe · 130 MB'}
                  action={
                    <span className={`${ACTION} bg-on-ink text-ink transition-transform duration-[130ms] group-hover:translate-x-[4px]`}>
                      <DownloadIcon className="h-[18px] w-[18px]" />
                      Herunterladen
                    </span>
                  }
                >
                  Lädt Videoportale mit yt-dlp in voller Auflösung und aktualisiert sich selbst.
                </MainTile>
              </a>

              {MICROSOFT_STORE ? (
                <a
                  href={MICROSOFT_STORE}
                  target="_blank"
                  rel="noopener"
                  onClick={() => setTimeout(close, 0)}
                  className={`${MAIN} press bg-panel-strong text-ink hover:bg-panel-mid`}
                >
                  <MainTile
                    icon={<StoreIcon className="h-[52px] w-[52px]" />}
                    title="Microsoft Store"
                    facts=".msix"
                    action={<span className={`${ACTION} bg-ink text-on-ink group-hover:bg-ink-hover`}>Im Store öffnen</span>}
                  >
                    Installiert sich ohne Warnung und bekommt Updates über den Store.
                  </MainTile>
                </a>
              ) : (
                <div aria-disabled="true" className={`${MAIN} cursor-not-allowed bg-panel-strong text-ink`}>
                  <MainTile
                    icon={<StoreIcon className="h-[52px] w-[52px] opacity-60" />}
                    title="Microsoft Store"
                    facts=".msix"
                    action={
                      <span className="inline-flex items-center gap-[10px] rounded-pill px-[20px] py-[12px] text-body font-semibold text-prose ring-1 ring-inset ring-rule">
                        <span className="h-[8px] w-[8px] animate-pulse rounded-pill bg-ink" aria-hidden />
                        Bald verfügbar
                      </span>
                    }
                  >
                    <span className="text-prose">Installiert sich ohne Warnung und bekommt Updates über den Store.</span>
                  </MainTile>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2">
              {/* The narrow ones. The website as an app: no setup at all, and
                  the one way that works with Smart App Control while the setup
                  is unsigned. */}
              <div className="flex flex-col gap-[12px] rounded-card bg-panel-soft px-[20px] py-[16px] text-ink sm:flex-row sm:items-center sm:gap-[18px] sm:px-[28px]">
                <span className="flex min-w-0 flex-1 items-center gap-[16px]">
                  <WindowIcon className="h-[28px] w-[28px]" />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-body font-semibold">Website als App</span>
                    <span className="text-small text-prose">
                      {browser.installed
                        ? 'Ist installiert — Sondra steht im Startmenü.'
                        : browser.available
                          ? 'Ohne Setup, aus Edge oder Chrome. Läuft auch mit der intelligenten App-Steuerung.'
                          : 'In Edge oder Chrome: Menü ⋯ → Apps → „Sondra installieren“. Läuft auch mit der intelligenten App-Steuerung.'}
                    </span>
                  </span>
                </span>
                {browser.available && !browser.installed ? (
                  <button
                    type="button"
                    onClick={() => void browser.install().then((done) => done && close())}
                    className="press shrink-0 self-start rounded-nav px-[16px] py-[9px] text-small font-semibold text-ink ring-1 ring-inset ring-rule hover:bg-panel-mid sm:self-auto"
                  >
                    Installieren
                  </button>
                ) : null}
              </div>

              {/* The portable build: one .exe, nothing installed, its data in
                  „Sondra-Daten“ beside it — for a USB stick or a computer
                  without rights to install. */}
              <div className="flex flex-col gap-[12px] rounded-card bg-panel-soft px-[20px] py-[16px] text-ink sm:flex-row sm:items-center sm:gap-[18px] sm:px-[28px]">
                <span className="flex min-w-0 flex-1 items-center gap-[16px]">
                  <StickIcon className="h-[28px] w-[28px]" />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-body font-semibold">Portabel</span>
                    <span className="text-small text-prose">
                      Eine .exe ohne Installation, auch vom USB-Stick. Die Daten liegen daneben im Ordner „Sondra-Daten“.
                    </span>
                  </span>
                </span>
                <a
                  href={arm ? WINDOWS_PORTABLE_ARM64 : WINDOWS_PORTABLE}
                  rel="noopener"
                  onClick={(e) => {
                    e.preventDefault()
                    setDefender({ url: arm ? WINDOWS_PORTABLE_ARM64 : WINDOWS_PORTABLE, portable: true })
                  }}
                  className="press shrink-0 self-start rounded-nav px-[16px] py-[9px] text-small font-semibold text-ink ring-1 ring-inset ring-rule hover:bg-panel-mid sm:self-auto"
                >
                  Herunterladen
                </a>
              </div>
            </div>
          </div>

          <p className="max-w-[72ch] text-small leading-[1.5] text-muted">
            Setup und portable Fassung sind noch nicht signiert. Warnt Windows, „Weitere Informationen“ und dann
            „Trotzdem ausführen“ wählen. Mit eingeschalteter intelligenter App-Steuerung startet es
            nicht — dann die Website als App nehmen; Videoportale lädt sie wie die Website, YouTube
            meist in 360p.{' '}
            <button
              type="button"
              onClick={() => setDefender({ url: arm ? WINDOWS_SETUP : WINDOWS_SETUP_ARM64, portable: false })}
              className="text-ink underline underline-offset-[3px] hover:no-underline"
            >
              {arm ? 'Setup für x64-Prozessoren' : 'Setup für Arm-Prozessoren'}
            </button>
          </p>
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
