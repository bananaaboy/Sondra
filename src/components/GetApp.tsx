/**
 * „App herunterladen" — where the header's privacy chip used to be.
 *
 * The chip said „Lokal · 1 Ausnahme" on every screen. That Sondra is local
 * goes without saying by now, and the one exception is announced loudly where
 * it happens, in the downloader. The header's spot goes to the thing people
 * actually came looking for up there: the app.
 *
 * It is Windows only for now, with two ways to get it. The Microsoft Store is
 * shown but not yet usable — the submission is still in review — and says so
 * on hover, on focus and on tap rather than disappearing, so nobody wonders
 * later where it went.
 */

import { useEffect, useRef, useState } from 'react'

import { IN_DESKTOP_APP, WINDOWS_SETUP } from '../lib/desktop'
import { useBrowserInstall } from '../lib/install'

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

function StoreIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0" fill="none" aria-hidden>
      <path d="M3.5 6.5h13l-1 10h-11z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7 6.5V5a3 3 0 0 1 6 0v1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M7.5 9.5h2v2h-2zM10.5 9.5h2v2h-2zM7.5 12.5h2v2h-2zM10.5 12.5h2v2h-2z" fill="currentColor" />
    </svg>
  )
}

function SetupIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0" fill="none" aria-hidden>
      <path d="M4 3.5h8l4 4v9H4z M12 3.5v4h4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M10 9v5M7.8 11.8 10 14l2.2-2.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function WindowIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0" fill="none" aria-hidden>
      <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 7.5h14" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.4" cy="5.8" r="0.7" fill="currentColor" />
    </svg>
  )
}

const OPTION =
  'flex w-full items-center gap-[16px] rounded-card px-[16px] py-[14px] text-left ring-1 ring-inset ring-line'

export function GetAppButton() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  /** A tap on a touch screen has no hover, so the store says it there. */
  const [storeTapped, setStoreTapped] = useState(false)
  const browser = useBrowserInstall()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  if (IN_DESKTOP_APP) return null

  const close = () => {
    setOpen(false)
    setStoreTapped(false)
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
        className="pop elevate-lift m-auto w-[min(440px,calc(100vw-32px))] rounded-card bg-raised p-0 text-prose backdrop:bg-black/45 backdrop:backdrop-blur-[2px]"
      >
        <div className="flex flex-col gap-[16px] p-[20px] sm:p-[24px]">
          <div className="flex items-start justify-between gap-[12px]">
            <div className="flex flex-col gap-[4px]">
              <h2 id="get-app-title" className="text-[1.25rem] font-semibold leading-[1.3] text-ink">
                Wo möchten Sie Sondra herunterladen?
              </h2>
              <p className="text-small text-muted">Zurzeit gibt es die App für Windows 10 und 11.</p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Schliessen"
              className="press -mr-[8px] -mt-[4px] flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-nav text-muted hover:text-ink"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="flex flex-col gap-[8px]">
            {/* First, because it is the one way that works on every Windows
                today: Smart App Control refuses the unsigned setup outright,
                and the browser's own install is the signed browser. */}
            <div className={`${OPTION} bg-raised text-ink`}>
              <WindowIcon />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-semibold">Als App aus dem Browser</span>
                <span className="text-small text-prose">
                  {browser.installed
                    ? 'Ist installiert — Sondra steht im Startmenü.'
                    : browser.available
                      ? 'Eigenes Fenster und Eintrag im Startmenü, ohne Setup. Läuft auch mit der intelligenten App-Steuerung.'
                      : 'In Edge oder Chrome: Menü ⋯ → Apps → „Sondra installieren“. Läuft auch mit der intelligenten App-Steuerung.'}
                </span>
              </span>
              {browser.available && !browser.installed ? (
                <button
                  type="button"
                  onClick={() => void browser.install().then((done) => done && close())}
                  className="press shrink-0 rounded-nav bg-ink px-[12px] py-[8px] text-small font-semibold text-on-ink hover:bg-ink-hover"
                >
                  Installieren
                </button>
              ) : null}
            </div>

            {/* Not `disabled`: a disabled button gets no hover and no focus in
                several browsers, and then the one thing it has to say — soon —
                could never be read. */}
            <div className="group relative">
              <button
                type="button"
                aria-disabled="true"
                aria-describedby="store-soon"
                onClick={() => setStoreTapped(true)}
                className={`${OPTION} cursor-not-allowed bg-panel-soft text-muted opacity-60`}
              >
                <StoreIcon />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body font-semibold">Microsoft Store</span>
                  <span className="text-small">Installiert und aktualisiert sich über den Store.</span>
                </span>
              </button>
              <span
                id="store-soon"
                role="status"
                className={`pointer-events-none absolute right-[12px] top-[-10px] rounded-pill bg-ink px-[10px] py-[3px] text-micro font-semibold text-on-ink transition-opacity ${
                  storeTapped ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                }`}
              >
                Bald verfügbar
              </span>
            </div>

            <a
              href={WINDOWS_SETUP}
              rel="noopener"
              onClick={() => setTimeout(close, 0)}
              className={`${OPTION} press bg-raised text-ink hover:bg-panel-soft`}
            >
              <SetupIcon />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-semibold">Setup (.exe)</span>
                <span className="text-small text-prose">
                  Rund 130 MB. Lädt Videoportale mit yt-dlp in voller Auflösung und aktualisiert
                  sich selbst.
                </span>
              </span>
              <DownloadIcon className="h-4 w-4" />
            </a>
          </div>

          <p className="text-small leading-[1.5] text-muted">
            Das Setup ist noch nicht signiert. Warnt Windows beim Start, „Weitere Informationen“ und
            dann „Trotzdem ausführen“ wählen. Ist die intelligente App-Steuerung eingeschaltet,
            startet es gar nicht — dann die App aus dem Browser nehmen; Videoportale lädt sie wie
            die Website, YouTube meist in 360p.
          </p>
        </div>
      </dialog>
    </>
  )
}
