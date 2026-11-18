/**
 * Mirroring an Android phone: its screen on this computer, clicks and keys
 * back to the phone. The idea and the server are scrcpy's (Genymobile,
 * Apache-2.0); the way to talk to a phone from a browser is Tango ADB
 * (@yume-chan, MIT): USB through WebUSB, no `adb` program, no install.
 *
 * Nothing leaves the computer: the picture travels over the cable, is decoded
 * here (WebCodecs) and drawn on a canvas. The scrcpy server — a 90 KB file
 * shipped with the app, never fetched from anywhere — is pushed to the phone's
 * temp folder when the connection starts and runs only while it lasts.
 *
 * Not in the Android app (a phone cannot be the host of another phone here),
 * not in Firefox or Safari (no WebUSB). This module is only imported by the
 * tool's own chunk.
 */

import { Adb, AdbDaemonTransport } from '@yume-chan/adb'
import AdbWebCredentialStore from '@yume-chan/adb-credential-web'
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb'
import { AdbScrcpyClient, AdbScrcpyExitedError, AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy'
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  DefaultServerPath,
  ScrcpyPointerId,
} from '@yume-chan/scrcpy'
import { WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs'

import { IN_ANDROID_APP } from './desktop'
import serverUrl from '../assets/scrcpy/scrcpy-server-v3.3.3.jar?url'

/** The server's version: it aborts at once if the client names another. */
export const SERVER_VERSION = '3.3.3'
/** The file's SHA-256, checked before it is pushed to a phone. */
export const SERVER_SHA256 = '7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0'

export type MirrorSupport = { ok: true } | { ok: false; why: 'android-app' | 'no-usb' | 'no-video' }

export function mirrorSupport(): MirrorSupport {
  if (IN_ANDROID_APP) return { ok: false, why: 'android-app' }
  if (!AdbDaemonWebUsbDeviceManager.BROWSER) return { ok: false, why: 'no-usb' }
  if (typeof VideoDecoder === 'undefined' || !WebCodecsVideoDecoder.isSupported) return { ok: false, why: 'no-video' }
  return { ok: true }
}

/** What went wrong, in a word the page can answer with a sentence. */
export type MirrorFailure =
  /** The picker was closed, or no phone was chosen. */
  | 'cancelled'
  /** Another program (adb, Android Studio, scrcpy) holds the phone, or Windows has no driver for it. */
  | 'busy'
  /** The phone refused the computer ("USB-Debugging zulassen" answered with Abbrechen). */
  | 'refused'
  /** The server on the phone quit — too old an Android, or the screen is protected. */
  | 'server'
  /** The file shipped with the app is not the one it should be. */
  | 'server-file'
  | 'unknown'

export class MirrorError extends Error {
  constructor(
    readonly failure: MirrorFailure,
    /** The technical text, behind a click on the page. */
    readonly detail: string,
  ) {
    super(detail)
  }
}

function classify(error: unknown, cancelled: boolean): MirrorError {
  if (error instanceof MirrorError) return error
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (cancelled) return new MirrorError('cancelled', text)
  if (error instanceof DOMException && error.name === 'NotFoundError') return new MirrorError('cancelled', text)
  if (error instanceof AdbDaemonWebUsbDevice.DeviceBusyError) return new MirrorError('busy', text)
  if (error instanceof AdbScrcpyExitedError) return new MirrorError('server', `${text}\n${error.output.join('\n')}`.trim())
  if (/claim|busy|access denied|SecurityError|NetworkError/i.test(text)) return new MirrorError('busy', text)
  if (/auth|reject|denied|unauthori[sz]ed/i.test(text)) return new MirrorError('refused', text)
  return new MirrorError('unknown', text)
}

async function serverBytes(): Promise<Uint8Array> {
  const response = await fetch(serverUrl)
  if (!response.ok) throw new MirrorError('server-file', `HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (hex !== SERVER_SHA256) throw new MirrorError('server-file', `SHA-256 ${hex}`)
  return bytes
}

export type MirrorStep = 'select' | 'connect' | 'allow' | 'push' | 'start'
export type MirrorQuality = 'smooth' | 'sharp'

export type PhoneKey = 'back' | 'home' | 'recents' | 'volumeUp' | 'volumeDown' | 'power'

const KEY_CODE: Record<Exclude<PhoneKey, 'back'>, number> = {
  home: AndroidKeyCode.AndroidHome,
  recents: AndroidKeyCode.AndroidAppSwitch,
  volumeUp: AndroidKeyCode.VolumeUp,
  volumeDown: AndroidKeyCode.VolumeDown,
  power: AndroidKeyCode.Power,
}

export interface MirrorSession {
  /** What the phone calls itself, for the page to say. */
  readonly deviceName: string
  readonly size: { width: number; height: number }
  /** Called when the phone turns and the picture changes its shape. */
  onSize(listener: (size: { width: number; height: number }) => void): void
  /** Resolves with a reason once the picture stops: unplugged, or the phone quit. */
  readonly closed: Promise<string>
  key(key: PhoneKey): Promise<void>
  openNotifications(): Promise<void>
  /** A position in the picture, 0 to 1 in each direction. */
  touch(kind: 'down' | 'move' | 'up', x: number, y: number): Promise<void>
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>
  screenshot(): Promise<Blob | undefined>
  stop(): Promise<void>
}

export interface MirrorStart {
  canvas: HTMLCanvasElement
  quality: MirrorQuality
  onStep: (step: MirrorStep) => void
  /** Told as soon as there is something to cancel with. */
  onAbort: (abort: () => void) => void
}

/**
 * Asks for a phone, connects, starts the server and begins to draw.
 *
 * Call it straight from a click: the browser lets a page open its device
 * picker only then, and the picker is the first thing this does.
 */
export async function startMirror({ canvas, quality, onStep, onAbort }: MirrorStart): Promise<MirrorSession> {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER
  if (!manager) throw new MirrorError('unknown', 'WebUSB fehlt')
  let cancelled = false
  let device: AdbDaemonWebUsbDevice | undefined
  let adb: Adb | undefined
  let client: AdbScrcpyClient<AdbScrcpyOptions3_3_3<true>> | undefined
  let decoder: WebCodecsVideoDecoder | undefined

  const release = async () => {
    try {
      decoder?.dispose()
    } catch {
      /* already gone */
    }
    try {
      await client?.close()
    } catch {
      /* the phone may be unplugged */
    }
    try {
      await adb?.close()
    } catch {
      /* same */
    }
    try {
      await device?.raw.close()
    } catch {
      /* same */
    }
  }

  try {
    onStep('select')
    device = await manager.requestDevice()
    if (!device) throw new MirrorError('cancelled', 'kein Gerät gewählt')
    onAbort(() => {
      cancelled = true
      void release()
    })

    onStep('connect')
    const connection = await device.connect()
    onStep('allow')
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial,
      connection,
      // Created here, kept in IndexedDB ("Tango") on this computer: it is what
      // makes "Immer von diesem Computer zulassen" on the phone stick.
      credentialStore: new AdbWebCredentialStore('Sondra'),
    })
    adb = new Adb(transport)

    onStep('push')
    const bytes = await serverBytes()
    await AdbScrcpyClient.pushServer(
      adb,
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }) as never,
    )

    onStep('start')
    client = await AdbScrcpyClient.start(
      adb,
      DefaultServerPath,
      new AdbScrcpyOptions3_3_3({
        audio: false,
        control: true,
        tunnelForward: true,
        // "Flüssig" caps the longer edge so the phone's encoder and this
        // computer's decoder have an easy time; "Scharf" is the phone's own size.
        maxSize: quality === 'smooth' ? 1280 : 0,
        maxFps: 60,
        videoBitRate: quality === 'smooth' ? 6_000_000 : 12_000_000,
        videoCodec: 'h264',
        clipboardAutosync: false,
      }),
    )
    const video = await client.videoStream
    decoder = new WebCodecsVideoDecoder({ codec: video.metadata.codec, renderer: new WebGLVideoFrameRenderer(canvas) })
  } catch (error) {
    const failure = classify(error, cancelled)
    await release()
    throw failure
  }

  const live = { client: client!, adb: adb!, decoder: decoder!, device: device! }
  const video = await live.client.videoStream
  let size = { width: video.width, height: video.height }
  const listeners = new Set<(size: { width: number; height: number }) => void>()
  video.sizeChanged((next) => {
    size = { width: next.width, height: next.height }
    for (const listener of listeners) listener(size)
  })

  const closed = new Promise<string>((resolve) => {
    let done = false
    const finish = (reason: string) => {
      if (done) return
      done = true
      resolve(reason)
    }
    video.stream.pipeTo(live.decoder.writable as never).then(
      () => finish('Das Handy hat die Übertragung beendet.'),
      () => finish('Die Verbindung zum Handy ist abgerissen.'),
    )
    live.adb.disconnected.then(
      () => finish('Das Handy wurde getrennt.'),
      () => finish('Das Handy wurde getrennt.'),
    )
    live.client.exited.then(
      () => finish('Das Handy hat die Übertragung beendet.'),
      () => finish('Das Handy hat die Übertragung beendet.'),
    )
  })

  const controller = live.client.controller
  const press = async (code: number) => {
    await controller?.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode: code as never, repeat: 0, metaState: 0 })
    await controller?.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode: code as never, repeat: 0, metaState: 0 })
  }
  const at = (x: number, y: number) => ({
    pointerX: Math.round(Math.min(Math.max(x, 0), 1) * (size.width - 1)),
    pointerY: Math.round(Math.min(Math.max(y, 0), 1) * (size.height - 1)),
    videoWidth: size.width,
    videoHeight: size.height,
  })

  return {
    deviceName: live.device.name,
    get size() {
      return size
    },
    onSize: (listener) => void listeners.add(listener),
    closed,
    async key(key) {
      if (key === 'back') {
        await controller?.backOrScreenOn(AndroidKeyEventAction.Down)
        await controller?.backOrScreenOn(AndroidKeyEventAction.Up)
        return
      }
      await press(KEY_CODE[key])
    },
    openNotifications: async () => void (await controller?.expandNotificationPanel()),
    async touch(kind, x, y) {
      await controller?.injectTouch({
        action: kind === 'down' ? AndroidMotionEventAction.Down : kind === 'move' ? AndroidMotionEventAction.Move : AndroidMotionEventAction.Up,
        pointerId: ScrcpyPointerId.Finger,
        ...at(x, y),
        pressure: kind === 'up' ? 0 : 1,
        actionButton: 0,
        buttons: 0,
      })
    },
    async scroll(x, y, deltaX, deltaY) {
      await controller?.injectScroll({ ...at(x, y), scrollX: deltaX, scrollY: deltaY, buttons: 0 })
    },
    screenshot: () => live.decoder.snapshot(),
    async stop() {
      cancelled = true
      await release()
    },
  }
}
