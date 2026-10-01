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

/**
 * Sondra Studio's page in the Microsoft Store, once the listing is live
 * (`https://apps.microsoft.com/detail/<Store-ID>`). Until then the store tile
 * says „Bald verfügbar“ instead of linking anywhere.
 */
export const MICROSOFT_STORE: string | null = null

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
  /** `store`: installed from the Microsoft Store, which updates it. */
  channel?: 'setup' | 'store'
}

/** A file Windows opened with Sondra, fetchable once from the app's server. */
export interface OpenedFile {
  name: string
  size: number | null
  url: string
}

/** A screen or window the app can record (desktop/electron.mjs). */
export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** A PNG data URL, or null when Windows gave no picture. */
  thumbnail: string | null
}

/** What the app's preload hands the page (desktop/preload.cjs); absent elsewhere. */
export interface AppBridge {
  /** Missing in apps older than 1.0.12. */
  takeOpenedFiles?: () => Promise<OpenedFile[]>
  onOpenedFiles?: (callback: (files: OpenedFile[]) => void) => () => void
  /** Missing in apps older than 1.0.13. */
  captureSources?: () => Promise<CaptureSource[]>
  /** Sets the source the next getDisplayMedia gets; `audio` adds the system's sound. */
  pickCaptureSource?: (id: string, audio: boolean) => Promise<boolean>
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
