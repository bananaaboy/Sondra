/**
 * The Windows app, as far as the website is concerned: where to get it, and
 * whether this page is already running inside it.
 */

import { ANDROID_BRIDGE } from './android'

/**
 * The installer of the newest GitHub release.
 *
 * `latest/download/<name>` always resolves to the newest release's asset of
 * that name, so the link never needs touching when a version ships — the
 * Desktop workflow uploads the installer under this fixed name as well as
 * under its versioned one.
 */
export const WINDOWS_SETUP = 'https://github.com/bananaaboy/Sondra/releases/latest/download/Sondra-Setup.exe'

/** The same for Windows on Arm (from 1.0.13 on). */
export const WINDOWS_SETUP_ARM64 = 'https://github.com/bananaaboy/Sondra/releases/latest/download/Sondra-Setup-arm64.exe'

/** The portable build: one .exe, no installation, its data beside it (from 1.1.9 on). */
export const WINDOWS_PORTABLE = 'https://github.com/bananaaboy/Sondra/releases/latest/download/Sondra-Portable.exe'
export const WINDOWS_PORTABLE_ARM64 = 'https://github.com/bananaaboy/Sondra/releases/latest/download/Sondra-Portable-arm64.exe'

/** The Android app (from 1.1.15 on in the release, signed with the app's own key). */
export const ANDROID_APK = 'https://github.com/bananaaboy/Sondra/releases/latest/download/Sondra-Android.apk'

/** A phone or tablet with Android, in its browser: the app it can install is that one. */
export const ON_ANDROID = typeof navigator !== 'undefined' && /\bAndroid\b/.test(navigator.userAgent)

/**
 * Nothing is fetched ahead here: a phone (Android, iPhone, iPad), or a
 * connection that asked to save data. On the desktop the FFmpeg core and
 * every tool are fetched once the page is idle; on a phone that was 32 MB
 * of WebAssembly compiled at every start of the Android app, with all forty
 * tools behind it — on mobile data, in a WebView Android may end for its
 * memory (28.10.2026: „die Android-App funktioniert mega schlecht“).
 * Each tool still fetches what it needs when it is opened.
 */
export const FETCH_LIGHT =
  typeof navigator !== 'undefined' &&
  (/\b(Android|iPhone|iPad|iPod)\b/.test(navigator.userAgent) ||
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true)

type ArchNavigator = Navigator & {
  userAgentData?: { platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> }
}

/**
 * True on Windows on Arm, as far as the browser says. Chromium browsers
 * answer through client hints; others leave it unknown, and the x64 setup
 * (which runs emulated there) stays the offer.
 */
export async function onWindowsArm(): Promise<boolean> {
  const data = (navigator as ArchNavigator).userAgentData
  if (!data?.getHighEntropyValues || data.platform !== 'Windows') return false
  try {
    const { architecture } = await data.getHighEntropyValues(['architecture'])
    return architecture === 'arm'
  } catch {
    return false
  }
}

/**
 * Sondra Studio's page in the Microsoft Store (Store-ID 9P0JXR5GNSMG). Without
 * language or tracking parameters: the page picks the visitor's language
 * itself. Set to null, the store tile says „Bald verfügbar“ instead.
 */
export const MICROSOFT_STORE: string | null = 'https://apps.microsoft.com/detail/9P0JXR5GNSMG'

/** True inside the desktop app, where offering the desktop app is circular. */
export const IN_DESKTOP_APP = typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent)

/**
 * True inside the Android app (`android/`): Sondra in the app's own WebView,
 * where offering the Windows app is beside the point. The app's bridge says
 * so, and its user agent as well, should a page load before the bridge.
 */
export const IN_ANDROID_APP =
  ANDROID_BRIDGE !== null || (typeof navigator !== 'undefined' && /\bSondraAndroid\//.test(navigator.userAgent))

/** Where the installed app's updater stands, as the app reports it. */
export interface UpdateState {
  status: 'off' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'available' | 'error'
  /** The running version. */
  version: string
  /** The version being fetched or ready to install. */
  next?: string
  percent?: number
  message?: string
  /**
   * `store`: installed from the Microsoft Store, which updates it.
   * `portable`: the portable build, which cannot replace itself; a newer
   * version is `available` as a file at `download`.
   */
  channel?: 'setup' | 'store' | 'portable' | 'apk'
  download?: string
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

export interface DiscordActivity {
  details?: string
  state?: string
  timestamps?: {
    start?: number
    end?: number
  }
  assets?: {
    large_image?: string
    large_text?: string
    small_image?: string
    small_text?: string
  }
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
  /** The Merkliste's link to Anytype (desktop/anytype.mjs); missing in apps older than 1.1.4. */
  anytype?: (action: string, ...args: unknown[]) => Promise<unknown>
  /** Google Drive's sign-in (desktop/googleDrive.mjs); missing in apps older than 1.1.11. */
  drive?: (action: string, ...args: unknown[]) => Promise<unknown>
  /** Discord Rich Presence controls (optional, user toggleable). */
  setDiscordPresence?: (activity: DiscordActivity | null) => Promise<boolean>
  setDiscordEnabled?: (enabled: boolean) => Promise<boolean>
  /** Always on top / floating mini-player mode. */
  setAlwaysOnTop?: (flag: boolean) => Promise<boolean>
  isAlwaysOnTop?: () => Promise<boolean>
  /** Brings the window forward — after a click on a notice; missing before 1.1.9. */
  focusWindow?: () => Promise<boolean>
  /** Shows a native Windows notification; clicking focuses Sondra. */
  notify?: (title: string, body: string) => Promise<boolean>
  /** Gets or picks the target folder for Zero-RAM Direct-to-Disk downloads. */
  getDownloadDir?: () => Promise<string>
  pickDownloadDir?: () => Promise<string | null>
  /** Sets progress bar in taskbar (0 to 1, or -1 to clear). */
  setProgressBar?: (progress: number) => Promise<boolean>
  /** Prevents OS sleep during long downloads. */
  setPowerSaveBlocker?: (active: boolean) => Promise<boolean>
  updateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  downloadUpdate?: () => Promise<UpdateState>
  installUpdate: () => Promise<boolean>
  onUpdate: (callback: (state: UpdateState) => void) => () => void
}

declare global {
  interface Window {
    sondraApp?: AppBridge
  }
}

export const APP_BRIDGE: AppBridge | null = typeof window !== 'undefined' ? (window.sondraApp ?? null) : null

const DISCORD_KEY = 'sondra:discord_rpc_enabled'

export function isDiscordRpcEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(DISCORD_KEY) === 'true'
}

export function setDiscordRpcEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(DISCORD_KEY, enabled ? 'true' : 'false')
  if (APP_BRIDGE?.setDiscordEnabled) {
    void APP_BRIDGE.setDiscordEnabled(enabled)
  }
}

export function updateDiscordPresence(activity: DiscordActivity | null): void {
  if (!isDiscordRpcEnabled()) return
  if (APP_BRIDGE?.setDiscordPresence) {
    void APP_BRIDGE.setDiscordPresence(activity)
  }
}

// Initialize Discord setting at boot
if (typeof window !== 'undefined' && APP_BRIDGE?.setDiscordEnabled) {
  void APP_BRIDGE.setDiscordEnabled(isDiscordRpcEnabled())
}
