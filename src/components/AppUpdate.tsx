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
 *
 * The portable build cannot replace itself; when a newer version is out, the
 * control becomes the download of that version's portable file.
 */

import { useEffect, useState } from 'react'

import { ANDROID_APK, APP_BRIDGE, IN_ANDROID_APP, WINDOWS_SETUP, type UpdateState } from '../lib/desktop'
import { keepSession } from '../lib/sessionStore'
import { APP_VERSION } from '../lib/version'

const BASE = 'press flex items-center gap-[8px] rounded-nav px-[12px] py-[8px] text-small'


function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden>
      <path d="M8 2.5v7.5M4.8 6.8 8 10l3.2-3.2M3 13h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" aria-hidden>
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function newer(candidate: string, base: string): boolean {
  const a = candidate.split('.').map(Number)
  const b = base.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/**
 * An Android app before 1.1.20 has no updater and answers „rejected“. The page
 * is always the newest, so the app's version in the user agent says whether
 * there is one: then the APK, through the browser, is the only way.
 */
function known(state: UpdateState): UpdateState | null {
  if (state?.status) return state
  if (!IN_ANDROID_APP) return null
  const version = /\bSondraAndroid\/([\d.]+)/.exec(navigator.userAgent)?.[1]
  if (!version) return null
  return newer(APP_VERSION, version)
    ? { status: 'available', version, next: APP_VERSION, channel: 'apk', download: ANDROID_APK }
    : { status: 'off', version, channel: 'apk' }
}

export function AppUpdateButton() {
  const bridge = APP_BRIDGE
  const [state, setState] = useState<UpdateState | null>(null)
  /** „Aktuell“ is an answer to a click, shown for a moment, then gone. */
  const [asked, setAsked] = useState(false)
  /** An Android app without an updater of its own (before 1.1.20). */
  const [legacy, setLegacy] = useState(false)

  useEffect(() => {
    if (!bridge) return
    void bridge.updateState().then((answer) => {
      if (!answer?.status) setLegacy(true)
      setState(known(answer))
    })
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
      <span
        className="value text-small text-muted"
        title={
          state.channel === 'store'
            ? 'Updates kommen über den Microsoft Store.'
            : state.channel === 'apk'
              ? 'Sondra ist aktuell.'
              : 'Updates gibt es nur in der installierten Windows-App.'
        }
      >
        Version {state.version}
      </span>
    )
  }

  if (state.status === 'ready') {
    return (
      <button
        type="button"
        onClick={() => {
          // Android asks itself, in its installer; the list and the folder stay.
          if (state.channel === 'apk') {
            void bridge.installUpdate()
            return
          }
          const ok = window.confirm(
            keepSession()
              ? `Sondra startet neu und installiert ${state.next}. Die Dateien der Sitzung sind gespeichert und werden danach wieder angeboten. Jetzt aktualisieren?`
              : `Sondra startet neu und installiert ${state.next}. Die Sitzung wird nicht behalten — Dateien, die Sie nicht gespeichert haben, gehen verloren. Jetzt aktualisieren?`,
          )
          if (ok) void bridge.installUpdate()
        }}
        className={`${BASE} bg-ink font-semibold text-on-ink hover:bg-ink-hover`}
        title={`Version ${state.version} → ${state.next}`}
      >
        <RefreshIcon />
        <span className="hidden sm:inline">{state.channel === 'apk' ? `${state.next} installieren` : `Auf ${state.next} aktualisieren`}</span>
        <span className="sm:hidden">Update</span>
      </button>
    )
  }

  // The Android app fetches its update itself, with progress here, and opens
  // the installer when it is there.
  if (state.status === 'available' && state.channel === 'apk' && !legacy && bridge.downloadUpdate) {
    const download = bridge.downloadUpdate
    return (
      <button
        type="button"
        onClick={() => void download().then(setState)}
        className={`${BASE} bg-ink font-semibold text-on-ink hover:bg-ink-hover`}
        title={`Version ${state.version} → ${state.next}`}
      >
        <DownloadIcon />
        <span className="hidden sm:inline">Auf {state.next} aktualisieren</span>
        <span className="sm:hidden">Update</span>
      </button>
    )
  }

  if (state.status === 'available' && state.download) {
    return (
      <a
        href={state.download}
        target="_blank"
        rel="noreferrer"
        className={`${BASE} bg-ink font-semibold text-on-ink hover:bg-ink-hover`}
        title={
          state.channel === 'apk'
            ? `Version ${state.version} → ${state.next}. Lädt im Browser; dort „Trotzdem herunterladen“ bestätigen, dann die Datei öffnen.`
            : `Version ${state.version} → ${state.next}. Die neue Datei ersetzt diese; der Ordner „Sondra-Daten“ daneben bleibt.`
        }
      >
        <DownloadIcon />
        <span className="hidden sm:inline">{state.next} herunterladen</span>
        <span className="sm:hidden">Update</span>
      </a>
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
          href={state.download ?? (state.channel === 'apk' ? ANDROID_APK : WINDOWS_SETUP)}
          target="_blank"
          rel="noreferrer"
          className="press rounded-nav px-[8px] py-[8px] text-small text-ink underline underline-offset-4 hover:bg-panel-soft"
        >
          {state.channel === 'portable' ? 'Neueste laden' : state.channel === 'apk' ? 'APK laden' : 'Setup laden'}
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
      <span className="value hidden sm:inline text-muted">{state.version}</span>
    </button>
  )
}
