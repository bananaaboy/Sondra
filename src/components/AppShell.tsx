/**
 * The frame around the tools: a header bar and a footer, nothing else.
 *
 * There is no landing page. Someone who opens this has a file to deal with, and
 * making them scroll past a pitch first would be rude. What the header owes them
 * instead is the two things they need in the first three seconds: a way to open
 * a file, and the claim that the file is not going anywhere.
 */


import { useFilePicker } from '../hooks/useIngest'
import { IN_DESKTOP_APP, WINDOWS_SETUP } from '../lib/desktop'
import type { ThemeChoice } from '../lib/theme'
import { useSession } from '../state/store'
import { SessionMenu } from './AssetList'
import { AppUpdateButton } from './AppUpdate'
import { GetAppButton } from './GetApp'
import { PanelTabs } from './PanelTabs'
import { ThemeToggle } from './ThemeToggle'
import { Button } from './ui/primitives'

/**
 * The mark: one sound, sliced into layers that no longer line up.
 *
 * The bars follow the chords of a circle, so the silhouette is round, and the
 * middle ones are pushed sideways — the shape of something taken apart, which
 * is what every tool here does. Deliberately not a signal-strength fan or a
 * play triangle: this app never reaches for a network, and it is not a player.
 */
export function Mark({ className = 'h-[26px] w-[26px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`shrink-0 fill-current ${className}`} aria-hidden>
      <rect x="9" y="5.35" width="13.99" height="3.3" rx="1.65" />
      <rect x="7.73" y="9.85" width="20.95" height="3.3" rx="1.65" />
      <rect x="4.6" y="14.35" width="22.8" height="3.3" rx="1.65" />
      <rect x="3.33" y="18.85" width="20.95" height="3.3" rx="1.65" />
      <rect x="9" y="23.35" width="13.99" height="3.3" rx="1.65" />
    </svg>
  )
}

/**
 * The document's title, and therefore its `h1`.
 *
 * A world built as a printed record shipped with no document heading at all:
 * the heading hierarchy started at `h2` and the name of the thing was a span.
 * `as` exists because the footer and the loading screen show the same mark
 * where an `h1` would be a second one on the page.
 */
export function Logo({ as = 'h1' }: { as?: 'h1' | 'span' }) {
  const Tag = as
  return (
    <Tag className="m-0 flex items-center gap-[8px] text-ink">
      <Mark />
      <span className="font-wordmark text-[25px] font-light tracking-[-0.01em]">Sondra</span>
      <span className="sr-only"> — Ton, Video und Bilder bearbeiten</span>
    </Tag>
  )
}

/** Opens the system file picker. Rendered wherever a file can be started from. */
export function OpenFileButton({
  variant = 'primary',
  size = 'sm',
  label = 'Datei öffnen',
  /** Drops the label below `sm`, where the header has no room for it. */
  collapse = false,
  className = '',
}: {
  variant?: 'primary' | 'quiet' | 'ghost'
  size?: 'sm' | 'md'
  label?: string
  collapse?: boolean
  className?: string
}) {
  const { input, open, busy } = useFilePicker('geöffnet')
  return (
    <>
      {input}
      <Button
        variant={variant}
        size={size}
        onClick={open}
        disabled={busy}
        aria-label={label}
        className={className}
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
          <path
            d="M2 5.2c0-.9.7-1.6 1.6-1.6h2.2L7.2 5h5.2c.9 0 1.6.7 1.6 1.6v4.6c0 .9-.7 1.6-1.6 1.6H3.6c-.9 0-1.6-.7-1.6-1.6z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        <span className={collapse ? 'hidden sm:inline' : undefined}>
          {busy ? 'Wird gelesen…' : label}
        </span>
      </Button>
    </>
  )
}

/**
 * The one band of chrome above a tool.
 *
 * It was three: this header with five controls, a tinted session strip under
 * it, and a boxed tab bar under that — measured on a laptop, 176px of frame
 * before a tool said anything, most of it saying the same things twice. Now
 * the controls are one quiet row, the file being worked on is named in it (the
 * session lives behind that name), and the tabs are its second line, resting
 * on its bottom rule. On the start screen of a phone the tabs stay away: the
 * tiles right below are the same menu, and there it would be a cut-off copy.
 *
 * „Installieren" and the search button are gone from here on request. The
 * browser still offers installation in its own menu; the search lives on the
 * start page, and Strg/Cmd + K still opens the command palette anywhere.
 *
 * The privacy chip („Lokal · 1 Ausnahme") went the same way: that everything is
 * local is the premise by now, and the exception is said where it happens. Its
 * place is the app download, which inside the app itself is not shown.
 */
export function Header({
  themeChoice,
  onThemeChange,
}: {
  themeChoice: ThemeChoice
  onThemeChange: (choice: ThemeChoice) => void
}) {
  const panel = useSession((state) => state.panel)
  return (
    <header className="sticky top-0 z-30 border-b-2 border-rule bg-canvas/95 backdrop-blur-md">
      <div className="shell flex items-center justify-between gap-[12px] pt-[10px] sm:gap-[24px] sm:pt-[12px]">
        <Logo />
        <div className="flex min-w-0 items-center gap-[4px] sm:gap-[8px]">
          <SessionMenu />
          <GetAppButton />
          <AppUpdateButton />
          <ThemeToggle choice={themeChoice} onChange={onThemeChange} />
        </div>
      </div>
      <nav
        aria-label="Werkzeuge"
        className={`shell mt-[8px] sm:mt-[12px] ${panel === 'start' ? 'hidden sm:block' : ''}`}
      >
        <PanelTabs />
      </nav>
      {/* Without the tabs the row still needs its bottom air on a phone. */}
      <div className={panel === 'start' ? 'h-[10px] sm:hidden' : 'hidden'} aria-hidden />
    </header>
  )
}

/** Shown while a file is being dragged over the window. */
export function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-canvas/85 backdrop-blur-sm"
    >
      <div className="pop elevate-lift rounded-card bg-raised px-[48px] py-[40px] text-center ring-2 ring-inset ring-ink">
        <Mark className="mx-auto mb-[16px] h-[36px] w-[36px] text-ink" />
        <p className="display-sm">Loslassen zum Öffnen</p>
        <p className="mt-[8px] text-small text-muted">Die Datei bleibt auf diesem Gerät.</p>
      </div>
    </div>
  )
}

/** Live reminder of what is currently held in memory, with a way to drop it. */

const footerLink = 'text-ink underline underline-offset-[3px] hover:no-underline'

export function Footer() {
  return (
    <footer className="shell mt-[36px] flex flex-col gap-[12px] border-t border-line py-[24px] text-small text-muted">
      <div className="flex flex-wrap items-center justify-between gap-[16px]">
        <p className="max-w-[60ch] leading-[1.6]">
          Statisch ausgeliefert, lokal gerechnet. Quelloffene Bausteine: FFmpeg (WebAssembly), ONNX
          Runtime Web, Wavesurfer, Tone.js.
        </p>
        <p>Keine Uploads · keine Cookies · kein Tracking</p>
      </div>
      <p className="flex flex-wrap gap-x-[16px] gap-y-[4px]">
        {IN_DESKTOP_APP ? null : (
          <a className={footerLink} href={WINDOWS_SETUP} rel="noopener">
            Sondra für Windows herunterladen
          </a>
        )}
        <a className={footerLink} href="./datenschutz.html">
          Datenschutz
        </a>
        <a className={footerLink} href="./lizenz.html">
          Lizenz
        </a>
        <button type="button" className={footerLink} onClick={() => window.dispatchEvent(new Event('sondra:tastenkuerzel'))}>
          Tastenkürzel <span className="value">?</span>
        </button>
      </p>
    </footer>
  )
}
