/**
 * The app's update, in the header — the place the website uses to offer the
 * app, which inside the app has nothing to offer.
 *
 * It checks by itself (desktop/updater.mjs) and fetches in the background;
 * this control says where that stands and lets the person check now or
 * install what is ready. Outside the installed Windows app there are no
 * updates to run, and it says only the version.
 *
 * When the automatic way fails it says so in the header, not only in a
 * tooltip, and the setup of the newest version is one click away — an update
 * that silently falls back to „Nach Updates suchen“ reads as one that never
 * existed.
 */

import { useEffect, useState } from 'react'

import { APP_BRIDGE, type UpdateState } from '../lib/desktop'

const BASE = 'press flex items-center gap-[8px] rounded-nav px-[12px] py-[8px] text-small'

/** The newest setup, for when the updater cannot do it by itself. */
const LATEST_SETUP = 'https://github.com/bananaaboy/Sondra/releases/latest/download/Sondra-Setup.exe'

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden>
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function AppUpdateButton() {
  const bridge = APP_BRIDGE
  const [state, setState] = useState<UpdateState | null>(null)
  /** „Aktuell“ is an answer to a click, shown for a moment, then gone. */
  const [asked, setAsked] = useState(false)

  useEffect(() => {
    if (!bridge) return
    void bridge.updateState().then(setState)
    return bridge.onUpdate(setState)
  }, [bridge])

  useEffect(() => {
    if (!asked || state?.status !== 'current') return
    const timer = window.setTimeout(() => setAsked(false), 5000)
    return () => window.clearTimeout(timer)
  }, [asked, state?.status])

  if (!bridge || !state) return null

  if (state.status === 'off') {
    return (
      <span className="value text-small text-muted" title="Updates gibt es nur in der installierten Windows-App.">
        Version {state.version}
      </span>
    )
  }

  if (state.status === 'ready') {
    return (
      <button
        type="button"
        onClick={() => {
          const ok = window.confirm(
            `Sondra startet neu und installiert ${state.next}. Dateien der Sitzung, die Sie nicht gespeichert haben, gehen dabei verloren. Jetzt aktualisieren?`,
          )
          if (ok) void bridge.installUpdate()
        }}
        className={`${BASE} bg-ink font-semibold text-on-ink hover:bg-ink-hover`}
        title={`Version ${state.version} → ${state.next}`}
      >
        <RefreshIcon />
        <span className="hidden sm:inline">Auf {state.next} aktualisieren</span>
        <span className="sm:hidden">Update</span>
      </button>
    )
  }

  if (state.status === 'downloading') {
    return (
      <span role="status" className={`${BASE} bg-panel-soft text-prose`}>
        <span className="hidden sm:inline">Update {state.next} wird geladen</span>
        <span className="sm:hidden">Update</span>
        <span className="value">{state.percent ?? 0} %</span>
      </span>
    )
  }

  if (state.status === 'error') {
    return (
      <span className="flex items-center gap-[4px]" role="status" title={state.message ?? undefined}>
        <button
          type="button"
          onClick={() => {
            setAsked(true)
            void bridge.checkForUpdates().then(setState)
          }}
          className={`${BASE} bg-panel-soft text-ink hover:bg-panel-mid`}
          aria-label={`Update nicht möglich${state.message ? `: ${state.message}` : ''}. Erneut versuchen`}
        >
          <RefreshIcon />
          <span className="hidden sm:inline">Update nicht möglich · erneut</span>
          <span className="sm:hidden">Erneut</span>
        </button>
        <a
          href={LATEST_SETUP}
          target="_blank"
          rel="noreferrer"
          className="press rounded-nav px-[8px] py-[8px] text-small text-ink underline underline-offset-4 hover:bg-panel-soft"
        >
          Setup laden
        </a>
      </span>
    )
  }

  const label =
    state.status === 'checking' ? 'Suche Updates …' : asked && state.status === 'current' ? 'Sondra ist aktuell' : 'Nach Updates suchen'

  return (
    <button
      type="button"
      disabled={state.status === 'checking'}
      onClick={() => {
        setAsked(true)
        void bridge.checkForUpdates().then(setState)
      }}
      className={`${BASE} bg-panel-soft text-ink hover:bg-panel-mid disabled:cursor-wait`}
      title={`Version ${state.version}`}
      aria-live="polite"
    >
      <RefreshIcon />
      <span className="hidden sm:inline">{label}</span>
      <span className="value text-muted">{state.version}</span>
    </button>
  )
}
