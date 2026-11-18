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

import { HID_KEYBOARD_ID, HidKeyboard, KEYBOARD_REPORT_DESCRIPTOR } from './hidKeyboard'
import { IN_ANDROID_APP } from './desktop'
import { PhoneAudio, canPlayPhoneAudio } from './phoneAudio'
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
  /**
   * How this computer's keyboard reaches the phone: `uhid` is a virtual USB
   * keyboard on the phone (scrcpy's `--keyboard=uhid`), `sdk` injects text and
   * key codes instead — the way when the phone refuses the virtual keyboard.
   */
  readonly keyboard: 'uhid' | 'sdk'
  /** The phone's sound: playing here, off by the user's choice, or not available (before Android 11). */
  readonly audio: 'on' | 'off' | 'unavailable'
  onAudio(listener: (state: 'on' | 'off' | 'unavailable') => void): void
  setMuted(muted: boolean): void
  onKeyboard(listener: (mode: 'uhid' | 'sdk') => void): void
  /** A key of this computer's keyboard, as the browser reports it. */
  sendKey(event: { code: string; key: string; down: boolean; ctrl: boolean; alt: boolean; meta: boolean }): Promise<void>
  /** Lets go of every held key — the window lost the focus. */
  releaseKeys(): Promise<void>
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
  /** Whether to bring the phone's sound along. */
  sound: boolean
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
export async function startMirror({ canvas, quality, sound, onStep, onAbort }: MirrorStart): Promise<MirrorSession> {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER
  if (!manager) throw new MirrorError('unknown', 'WebUSB fehlt')
  // Sound: the AudioContext has to be made from the click, i.e. before the
  // first await; it is let go again if the phone has no sound to give.
  let player: PhoneAudio | null = null
  if (sound && canPlayPhoneAudio()) {
    try {
      player = new PhoneAudio()
    } catch {
      player = null
    }
  }
  let cancelled = false
  let device: AdbDaemonWebUsbDevice | undefined
  let adb: Adb | undefined
  let client: AdbScrcpyClient<AdbScrcpyOptions3_3_3<true>> | undefined
  let decoder: WebCodecsVideoDecoder | undefined
  let options: AdbScrcpyOptions3_3_3<true> | undefined

  const release = async () => {
    player?.close()
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
    options = new AdbScrcpyOptions3_3_3({
      audio: Boolean(player),
      audioCodec: 'opus',
      control: true,
      tunnelForward: true,
      // "Flüssig" caps the longer edge so the phone's encoder and this
      // computer's decoder have an easy time; "Scharf" is the phone's own size.
      maxSize: quality === 'smooth' ? 1280 : 0,
      maxFps: 60,
      videoBitRate: quality === 'smooth' ? 6_000_000 : 12_000_000,
      videoCodec: 'h264',
      clipboardAutosync: false,
    })
    client = await AdbScrcpyClient.start(adb, DefaultServerPath, options)
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

  // The phone's sound: Android 11 and newer give it; older ones answer that
  // there is none, and the page says so. The stream has to be read either way.
  let audio: 'on' | 'off' | 'unavailable' = player ? 'on' : 'off'
  const audioListeners = new Set<(state: 'on' | 'off' | 'unavailable') => void>()
  const setAudio = (state: 'on' | 'off' | 'unavailable') => {
    audio = state
    for (const listener of audioListeners) listener(state)
  }
  void live.client.audioStream?.then(
    (metadata) => {
      if (metadata.type === 'success' && player) {
        void player.play(metadata.codec.webCodecId, metadata.stream as never).catch(() => setAudio('unavailable'))
      } else {
        player?.close()
        player = null
        setAudio(metadata.type === 'errored' ? 'unavailable' : 'off')
      }
    },
    () => setAudio('unavailable'),
  )

  // `--keyboard=uhid`: a virtual USB keyboard on the phone. Created once, when
  // the picture starts, like scrcpy does; if the phone refuses (the server
  // says so in its output), keys fall back to injected text and key codes.
  const hid = new HidKeyboard()
  let keyboard: 'uhid' | 'sdk' = 'uhid'
  const keyboardListeners = new Set<(mode: 'uhid' | 'sdk') => void>()
  const fallBack = () => {
    if (keyboard === 'sdk') return
    keyboard = 'sdk'
    for (const listener of keyboardListeners) listener(keyboard)
  }
  try {
    await controller?.uHidCreate({
      id: HID_KEYBOARD_ID,
      vendorId: 0,
      productId: 0,
      name: 'Sondra Tastatur',
      data: KEYBOARD_REPORT_DESCRIPTOR,
    })
  } catch {
    keyboard = 'sdk'
  }
  // What the phone's keyboard says back (the LEDs) is read and dropped: left
  // unread it would stop the next message from the phone.
  void options?.uHidOutput?.pipeTo(new WritableStream({ write() {} }) as never).catch(() => undefined)
  // The server's own words: a refused UHID device is named there.
  void live.client.output
    .pipeTo(
      new WritableStream<string>({
        write(line) {
          if (/uhid/i.test(line) && /(fail|error|could not|exception|denied|permission)/i.test(line)) fallBack()
        },
      }) as never,
    )
    .catch(() => undefined)

  const sdkKeys: Record<string, number> = {
    Enter: AndroidKeyCode.Enter,
    NumpadEnter: AndroidKeyCode.Enter,
    Backspace: AndroidKeyCode.Backspace,
    Delete: AndroidKeyCode.Delete,
    Tab: AndroidKeyCode.Tab,
    Escape: AndroidKeyCode.Escape,
    ArrowUp: AndroidKeyCode.ArrowUp,
    ArrowDown: AndroidKeyCode.ArrowDown,
    ArrowLeft: AndroidKeyCode.ArrowLeft,
    ArrowRight: AndroidKeyCode.ArrowRight,
    PageUp: AndroidKeyCode.PageUp,
    PageDown: AndroidKeyCode.PageDown,
    Home: AndroidKeyCode.Home,
    End: AndroidKeyCode.End,
  }
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
    get audio() {
      return audio
    },
    onAudio: (listener) => void audioListeners.add(listener),
    setMuted: (muted) => player?.setMuted(muted),
    get keyboard() {
      return keyboard
    },
    onKeyboard: (listener) => void keyboardListeners.add(listener),
    async sendKey({ code, key, down, ctrl, alt, meta }) {
      if (keyboard === 'uhid') {
        const report = down ? hid.down(code) : hid.up(code)
        if (report) await controller?.uHidInput({ id: HID_KEYBOARD_ID, data: report })
        return
      }
      // The SDK way: only what a key press can mean without a virtual keyboard.
      if (!down) return
      const named = sdkKeys[code]
      if (named !== undefined) await press(named)
      else if (key.length === 1 && !ctrl && !alt && !meta) await controller?.injectText(key)
    },
    async releaseKeys() {
      const report = hid.reset()
      if (report && keyboard === 'uhid') await controller?.uHidInput({ id: HID_KEYBOARD_ID, data: report })
    },
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
      try {
        if (keyboard === 'uhid') await controller?.uHidDestroy(HID_KEYBOARD_ID)
      } catch {
        /* the phone may be unplugged */
      }
      await release()
    },
  }
}
