/**
 * „App herunterladen" — where the header's privacy chip used to be.
 *
 * The chip said „Lokal · 1 Ausnahme" on every screen. That Sondra is local
 * goes without saying by now, and the one exception is announced loudly where
 * it happens, in the downloader. The header's spot goes to the thing people
 * actually came looking for up there: the app.
 *
 * Three ways, weighted as asked: the setup and the Microsoft Store are the two
 * large tiles side by side, the website installed as an app is the narrow one
 * underneath. The store tile stays in place while the listing is not live and
 * says „Bald verfügbar" on its face — on a tile this size a hover-only hint
 * reads as broken.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { IN_DESKTOP_APP, MICROSOFT_STORE, WINDOWS_SETUP } from '../lib/desktop'
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

function WindowIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" aria-hidden>
      <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 7.5h14" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.4" cy="5.8" r="0.7" fill="currentColor" />
    </svg>
  )
}

/** One of the two large tiles: icon, name, what it does, and its action at the foot. */
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
      <span className="flex items-start justify-between gap-[12px]">
        {icon}
        <span className="value pt-[6px] text-small text-prose">{facts}</span>
      </span>
      <span className="mt-[28px] flex flex-col gap-[6px] sm:mt-[40px]">
        <span className="text-heading-sm font-semibold tracking-[-0.01em]">{title}</span>
        <span className="text-small text-prose">{children}</span>
      </span>
      <span className="mt-auto pt-[24px]">{action}</span>
    </>
  )
}

const MAIN = 'flex min-h-[240px] flex-col rounded-card p-[20px] text-left sm:min-h-[300px] sm:p-[24px]'
const ACTION = 'inline-flex items-center gap-[8px] rounded-nav px-[16px] py-[10px] text-small font-semibold'

export function GetAppButton() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
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
        className="pop elevate-lift m-auto max-h-[calc(100dvh-32px)] w-[min(760px,calc(100vw-32px))] overflow-y-auto overscroll-contain rounded-card bg-raised p-0 text-prose backdrop:bg-black/55 backdrop:backdrop-blur-[3px]"
      >
        <div className="flex flex-col gap-[24px] p-[20px] sm:gap-[28px] sm:p-[32px]">
          <div className="flex items-start justify-between gap-[16px]">
            <div className="flex items-center gap-[16px]">
              <span className="flex h-[56px] w-[56px] shrink-0 items-center justify-center rounded-card bg-ink text-on-ink">
                <Mark className="h-[32px] w-[32px]" />
              </span>
              <div className="flex flex-col gap-[2px]">
                <h2 id="get-app-title" className="text-heading-sm font-semibold tracking-[-0.01em] text-ink sm:text-[32px] sm:leading-[1.15]">
                  Sondra Studio für Windows
                </h2>
                <p className="text-small text-prose">Die ganze Werkstatt im eigenen Fenster. Windows 10 und 11.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Schliessen"
              className="press -mr-[8px] -mt-[4px] flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-nav text-muted hover:bg-panel-soft hover:text-ink"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="flex flex-col gap-[12px]">
            <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
              <a
                href={WINDOWS_SETUP}
                rel="noopener"
                onClick={() => setTimeout(close, 0)}
                className={`${MAIN} press group bg-panel-soft text-ink hover:bg-panel-mid`}
              >
                <MainTile
                  icon={<SetupIcon className="h-[44px] w-[44px]" />}
                  title="Setup"
                  facts=".exe · rund 130 MB"
                  action={
                    <span className={`${ACTION} bg-ink text-on-ink group-hover:bg-ink-hover`}>
                      <DownloadIcon className="h-4 w-4" />
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
                  className={`${MAIN} press group bg-panel-soft text-ink hover:bg-panel-mid`}
                >
                  <MainTile
                    icon={<StoreIcon className="h-[44px] w-[44px]" />}
                    title="Microsoft Store"
                    facts=".msix"
                    action={<span className={`${ACTION} bg-ink text-on-ink group-hover:bg-ink-hover`}>Im Store öffnen</span>}
                  >
                    Installiert sich ohne Warnung und bekommt Updates über den Store.
                  </MainTile>
                </a>
              ) : (
                <div aria-disabled="true" className={`${MAIN} cursor-not-allowed bg-panel-soft text-prose`}>
                  <MainTile
                    icon={<StoreIcon className="h-[44px] w-[44px] opacity-50" />}
                    title="Microsoft Store"
                    facts=".msix"
                    action={
                      <span className="inline-flex items-center gap-[8px] rounded-pill px-[16px] py-[10px] text-small font-semibold text-prose ring-1 ring-inset ring-rule">
                        <span className="h-[6px] w-[6px] rounded-pill bg-muted" aria-hidden />
                        Bald verfügbar
                      </span>
                    }
                  >
                    Installiert sich ohne Warnung und bekommt Updates über den Store.
                  </MainTile>
                </div>
              )}
            </div>

            {/* The narrow one: no setup at all, and the one way that works
                with Smart App Control while the setup is unsigned. */}
            <div className="flex flex-col gap-[12px] rounded-card bg-panel-soft px-[20px] py-[14px] text-ink sm:flex-row sm:items-center sm:gap-[16px]">
              <span className="flex min-w-0 flex-1 items-center gap-[14px]">
                <WindowIcon className="h-[24px] w-[24px]" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-body font-semibold">Website als App</span>
                  <span className="text-small text-prose">
                    {browser.installed
                      ? 'Ist installiert — Sondra steht im Startmenü.'
                      : browser.available
                        ? 'Ohne Setup, aus Edge oder Chrome. Läuft auch mit der intelligenten App-Steuerung.'
                        : 'In Edge oder Chrome: Menü ⋯ → Apps → „Sondra installieren“.'}
                  </span>
                </span>
              </span>
              {browser.available && !browser.installed ? (
                <button
                  type="button"
                  onClick={() => void browser.install().then((done) => done && close())}
                  className="press shrink-0 self-start rounded-nav px-[14px] py-[8px] text-small font-semibold text-ink ring-1 ring-inset ring-rule hover:bg-panel-mid sm:self-auto"
                >
                  Installieren
                </button>
              ) : null}
            </div>
          </div>

          <p className="max-w-[62ch] text-small leading-[1.5] text-muted">
            Das Setup ist noch nicht signiert. Warnt Windows, „Weitere Informationen“ und dann
            „Trotzdem ausführen“ wählen. Mit eingeschalteter intelligenter App-Steuerung startet es
            nicht — dann die Website als App nehmen; Videoportale lädt sie wie die Website, YouTube
            meist in 360p.
          </p>
        </div>
      </dialog>
    </>
  )
}
