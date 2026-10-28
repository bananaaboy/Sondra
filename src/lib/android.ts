/**
 * The Android app (`android/`), as far as the page is concerned: Sondra in
 * the app's own WebView, and the app's parts a page cannot do itself.
 *
 * The app hands this page — and only https://sondra.lizge.ch — one object,
 * `SondraNative` (androidx.webkit's WebMessageListener). A message is JSON
 * with an `id` and a `type`; the answer comes back with the same `id`. What
 * goes through it:
 *
 *   sign-in  Google's sign-in for Drive, the website's own (`lib/googleDrive.ts`),
 *            opened by the app in the browser — Google refuses it in a
 *            WebView — and its answer handed back here; the code is
 *            exchanged by the website's function, as on the website
 *   opened   films and songs shared with Sondra or opened with it, as
 *            addresses on this site the app serves once
 *   save     a file into Downloads/Sondra, in pieces (a WebView cannot save
 *            a `blob:` address)
 *   theme    the theme the page shows, for the system bars
 *   update   in-app auto updater for Android APK releases
 *   wake-lock keeps the screen illuminated during playback and downloads
 */

import type { OpenedFile, UpdateState } from './desktop'

interface NativePort {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

declare global {
  interface Window {
    SondraNative?: NativePort
  }
}

type Answer = Record<string, unknown>

const port: NativePort | null = typeof window !== 'undefined' ? (window.SondraNative ?? null) : null
const waiting = new Map<string, (answer: unknown) => void>()
const openedListeners = new Set<() => void>()
const signInListeners = new Set<(closed: boolean) => void>()
const updateListeners = new Set<(state: UpdateState) => void>()
let ids = 0

if (port) {
  port.onmessage = (event) => {
    let message: { id?: string; answer?: unknown; event?: string; state?: UpdateState }
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.event === 'opened') {
      for (const listener of openedListeners) listener()
      return
    }
    if (message.event === 'sign-in' || message.event === 'sign-in-closed') {
      for (const listener of signInListeners) listener(message.event === 'sign-in-closed')
      return
    }
    if (message.event === 'update' && message.state) {
      for (const listener of updateListeners) listener(message.state)
      return
    }
    const done = message.id ? waiting.get(message.id) : undefined
    if (!done) return
    waiting.delete(message.id!)
    done(message.answer)
  }
}

function ask<T>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
  if (!port) return Promise.reject(new Error('Keine Android-App'))
  const id = `m${(ids += 1)}`
  return new Promise<T>((resolve) => {
    waiting.set(id, (answer) => resolve(answer as T))
    port.postMessage(JSON.stringify({ id, type, ...fields }))
  })
}

/** Pieces of a saved file: small enough for one message, big enough to be quick. */
const SAVE_PIECE = 1024 * 1024

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(text)
}

export interface AndroidBridge {
  /** Opens Google's sign-in in the browser; `rejected` from an app too old for it. */
  openSignIn: (url: string) => Promise<{ ok: boolean; error?: string }>
  /** Google's answer, once it is back in the app: the query of the address it came back with. */
  takeSignIn: () => Promise<string | null>
  /** The answer is there (false), or the browser was closed without one (true). */
  onSignIn: (callback: (closed: boolean) => void) => () => void
  takeOpenedFiles: () => Promise<OpenedFile[]>
  onOpenedFiles: (callback: () => void) => () => void
  /** Into Downloads/Sondra; resolves with where it went. */
  save: (blob: Blob, name: string, mime: string) => Promise<string>
  /** Direct-to-Disk background streaming download (0 MB RAM) */
  downloadDirect: (options: {
    url: string
    filename: string
    mime?: string
    subFolder?: string
  }) => Promise<{ ok: boolean; savedPath?: string; bytesWritten?: number; error?: string }>
  /** Auto-updater methods */
  updateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  downloadUpdate: () => Promise<UpdateState>
  installUpdate: () => Promise<boolean>
  onUpdate: (callback: (state: UpdateState) => void) => () => void
  /** Prevents screen dimming / device standby */
  setPowerSaveBlocker: (active: boolean) => Promise<boolean>
  setOrientation: (orientation: 'portrait' | 'landscape' | 'unspecified') => Promise<boolean>
}

/** The app's side of the page, or null on the website and in the Windows app. */
export const ANDROID_BRIDGE: AndroidBridge | null = port
  ? {
      openSignIn: (url) => ask<{ ok: boolean; error?: string }>('sign-in', { url }),
      takeSignIn: () => ask<string | null>('sign-in-result'),
      onSignIn: (callback) => {
        signInListeners.add(callback)
        return () => signInListeners.delete(callback)
      },
      takeOpenedFiles: () => ask<OpenedFile[]>('opened'),
      onOpenedFiles: (callback) => {
        openedListeners.add(callback)
        return () => openedListeners.delete(callback)
      },
      async save(blob, name, mime) {
        const begun = await ask<Answer>('save-begin', { name, mime })
        if (!begun.ok) throw new Error(String(begun.error ?? 'nicht gespeichert'))
        const handle = begun.handle
        try {
          for (let at = 0; at < blob.size; at += SAVE_PIECE) {
            const piece = new Uint8Array(await blob.slice(at, at + SAVE_PIECE).arrayBuffer())
            const written = await ask<Answer>('save-chunk', { handle, data: base64(piece) })
            if (!written.ok) throw new Error(String(written.error ?? 'nicht gespeichert'))
          }
        } catch (error) {
          port!.postMessage(JSON.stringify({ type: 'save-abort', handle }))
          throw error
        }
        const ended = await ask<Answer>('save-end', { handle })
        if (!ended.ok) throw new Error(String(ended.error ?? 'nicht gespeichert'))
        return String(ended.where ?? '')
      },
      downloadDirect: (options) =>
        ask<{ ok: boolean; savedPath?: string; bytesWritten?: number; error?: string }>('direct-download', options),
      updateState: () => ask<UpdateState>('update-state'),
      checkForUpdates: () => ask<UpdateState>('update-check'),
      downloadUpdate: () => ask<UpdateState>('update-download'),
      installUpdate: () => ask<{ ok: boolean }>('update-install').then((r) => r.ok),
      onUpdate: (callback) => {
        updateListeners.add(callback)
        return () => updateListeners.delete(callback)
      },
      setPowerSaveBlocker: (active) => ask<{ ok: boolean }>('power-save-blocker', { active }).then((r) => r.ok),
      setOrientation: (orientation) => ask<{ ok: boolean }>('fullscreen-orientation', { orientation }).then((r) => r.ok),
    }
  : null

// Provide unified desktop/app bridge for AppUpdate component and power save blocker on Android
if (port && typeof window !== 'undefined' && !window.sondraApp) {
  window.sondraApp = {
    updateState: () => ask<UpdateState>('update-state'),
    checkForUpdates: () => ask<UpdateState>('update-check'),
    installUpdate: () => ask<{ ok: boolean }>('update-install').then((r) => r.ok),
    onUpdate: (callback) => {
      updateListeners.add(callback)
      return () => updateListeners.delete(callback)
    },
    setPowerSaveBlocker: (active) => ask<{ ok: boolean }>('power-save-blocker', { active }).then((r) => r.ok),
  }
}

/** Tells the app which theme the page shows, now and whenever it changes. */
function followTheme(): void {
  if (!port || typeof document === 'undefined') return
  const root = document.documentElement
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  let last: boolean | null = null
  const send = () => {
    const chosen = root.getAttribute('data-theme')
    const dark = chosen ? chosen === 'dark' : media.matches
    if (dark === last) return
    last = dark
    port.postMessage(JSON.stringify({ type: 'theme', dark }))
  }
  send()
  new MutationObserver(send).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  media.addEventListener('change', send)
}

followTheme()
