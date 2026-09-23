/**
 * The Windows app, as far as the website is concerned: where to get it, and
 * whether this page is already running inside it.
 */

/**
 * The installer of the newest GitHub release.
 *
 * `latest/download/<name>` always resolves to the newest release's asset of
 * that name, so the link never needs touching when a version ships — the
 * Desktop workflow uploads the installer under this fixed name as well as
 * under its versioned one.
 */
export const WINDOWS_SETUP = 'https://github.com/bananaaboy/Lizge/releases/latest/download/Sondra-Setup.exe'

/** True inside the desktop app, where offering the desktop app is circular. */
export const IN_DESKTOP_APP = typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent)

/** Where the installed app's updater stands, as the app reports it. */
export interface UpdateState {
  status: 'off' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error'
  /** The running version. */
  version: string
  /** The version being fetched or ready to install. */
  next?: string
  percent?: number
  message?: string
}

/** What the app's preload hands the page (desktop/preload.cjs); absent elsewhere. */
export interface AppBridge {
  updateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  installUpdate: () => Promise<boolean>
  onUpdate: (callback: (state: UpdateState) => void) => () => void
}

declare global {
  interface Window {
    sondraApp?: AppBridge
  }
}

export const APP_BRIDGE: AppBridge | null = typeof window !== 'undefined' ? (window.sondraApp ?? null) : null
