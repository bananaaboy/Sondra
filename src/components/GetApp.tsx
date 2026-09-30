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
const ACTION = 'inline-flex items-center gap-[10px] rounded-nav px-[22px] py-[14px] text-body font-semibold'

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
        className="pop elevate-lift m-auto max-h-[calc(100dvh-32px)] w-[min(1120px,calc(100vw-32px))] overflow-y-auto overscroll-contain rounded-card bg-raised p-0 text-prose backdrop:bg-black/60 backdrop:backdrop-blur-[4px]"
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
                href={WINDOWS_SETUP}
                rel="noopener"
                onClick={() => setTimeout(close, 0)}
                className={`${MAIN} press bg-ink text-on-ink`}
              >
                <Bars />
                <MainTile
                  icon={<SetupIcon className="h-[52px] w-[52px]" />}
                  title="Setup"
                  facts=".exe · 130 MB"
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

            {/* The narrow one: no setup at all, and the one way that works
                with Smart App Control while the setup is unsigned. */}
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
          </div>

          <p className="max-w-[72ch] text-small leading-[1.5] text-muted">
            Das Setup ist noch nicht signiert. Warnt Windows, „Weitere Informationen“ und dann
            „Trotzdem ausführen“ wählen. Mit eingeschalteter intelligenter App-Steuerung startet es
            nicht — dann die Website als App nehmen; Videoportale lädt sie wie die Website, YouTube
            meist in 360p. <a href="./download.html" className="text-ink underline underline-offset-[3px] hover:no-underline">Download-Seite und Signatur</a>
          </p>
        </div>
      </dialog>
    </>
  )
}
