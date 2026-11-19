/**
 * Writes the table the native phone mirror (`native/sondra-mirror`) is tested against: the bytes the
 * web app sends to the scrcpy server (control messages, the server's arguments) and the reports its virtual
 * keyboard sends, made by the very libraries the web app uses (Tango ADB's scrcpy part) and its own
 * `hidKeyboard.ts`. The Rust side must produce the same, byte for byte.
 *
 *   npm run native:golden
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { adbGeneratePublicKey, adbGetPublicKeySize, rsaSign } from '@yume-chan/adb'
import { AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy'
import { AndroidKeyCode, AndroidKeyEventAction, AndroidMotionEventAction, ScrcpyControlMessageSerializer, ScrcpyPointerId } from '@yume-chan/scrcpy'

import { HID_KEYBOARD_ID, HidKeyboard, KEYBOARD_REPORT_DESCRIPTOR } from '../src/lib/hidKeyboard'

const dir = 'native/sondra-mirror/tests/golden'
mkdirSync(dir, { recursive: true })
const hex = (bytes: Uint8Array | undefined | null) => (bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') : null)

// The server's arguments, for both qualities and with and without sound — as `startMirror` builds them.
const make = (smooth: boolean, audio: boolean) =>
  new AdbScrcpyOptions3_3_3({
    audio,
    audioCodec: 'opus',
    control: true,
    tunnelForward: true,
    maxSize: smooth ? 1280 : 0,
    maxFps: 60,
    videoBitRate: smooth ? 6_000_000 : 12_000_000,
    videoCodec: 'h264',
    clipboardAutosync: false,
  })
const args = [true, false].flatMap((smooth) => [true, false].map((audio) => ({ smooth, audio, args: make(smooth, audio).serialize() })))

// Control messages, from the serializer the library's own writer uses.
const options = make(true, true)
const serializer = new ScrcpyControlMessageSerializer(options as never)
const at = (width: number, height: number, x: number, y: number) => ({
  pointerX: Math.round(Math.min(Math.max(x, 0), 1) * (width - 1)),
  pointerY: Math.round(Math.min(Math.max(y, 0), 1) * (height - 1)),
  videoWidth: width,
  videoHeight: height,
})
const touch = (action: AndroidMotionEventAction, w: number, h: number, x: number, y: number, pressure: number) =>
  hex(serializer.injectTouch({ action, pointerId: ScrcpyPointerId.Finger, ...at(w, h, x, y), pressure, actionButton: 0, buttons: 0 } as never))
const control: Record<string, (string | null)[]> = {
  keys: [AndroidKeyCode.Enter, AndroidKeyCode.Backspace, AndroidKeyCode.ArrowLeft, AndroidKeyCode.Home, AndroidKeyCode.AndroidHome, AndroidKeyCode.AndroidAppSwitch, AndroidKeyCode.VolumeUp, AndroidKeyCode.VolumeDown, AndroidKeyCode.Power].flatMap((code) =>
    [AndroidKeyEventAction.Down, AndroidKeyEventAction.Up].map((action) => hex(serializer.injectKeyCode({ action, keyCode: code as never, repeat: 0, metaState: 0 } as never))),
  ),
  text: ['a', 'hallo', 'äöü ß', '日本語 😀', ''].map((t) => hex(serializer.injectText(t))),
  touch: [
    touch(AndroidMotionEventAction.Down, 1080, 2400, 0.5, 0.5, 1),
    touch(AndroidMotionEventAction.Move, 1080, 2400, 0.25, 0.75, 1),
    touch(AndroidMotionEventAction.Up, 1080, 2400, 0.25, 0.75, 0),
    touch(AndroidMotionEventAction.Down, 720, 1280, 0, 0, 1),
    touch(AndroidMotionEventAction.Up, 720, 1280, 1, 1, 0),
    touch(AndroidMotionEventAction.Move, 1920, 1080, -0.2, 1.4, 1),
  ],
  scroll: [
    hex(serializer.injectScroll({ ...at(1080, 2400, 0.5, 0.5), scrollX: 0, scrollY: -1, buttons: 0 } as never)),
    hex(serializer.injectScroll({ ...at(1080, 2400, 0.1, 0.9), scrollX: 1, scrollY: 0.5, buttons: 0 } as never)),
    hex(serializer.injectScroll({ ...at(720, 1280, 0.5, 0.5), scrollX: 0, scrollY: 3, buttons: 0 } as never)),
  ],
  back: [AndroidKeyEventAction.Down, AndroidKeyEventAction.Up].map((action) => hex(serializer.backOrScreenOn(action))),
  panels: [hex(serializer.expandNotificationPanel()), hex(serializer.expandSettingPanel()), hex(serializer.collapseNotificationPanel()), hex(serializer.rotateDevice())],
  uhid: [
    hex(serializer.uHidCreate({ id: HID_KEYBOARD_ID, vendorId: 0, productId: 0, name: 'Sondra Tastatur', data: KEYBOARD_REPORT_DESCRIPTOR } as never)),
    hex(serializer.uHidInput({ id: HID_KEYBOARD_ID, data: new Uint8Array([0, 0, 4, 0, 0, 0, 0, 0]) } as never)),
    hex(serializer.uHidDestroy(HID_KEYBOARD_ID)),
  ],
}

// The keyboard: a sequence of presses, and the report after each (null: nothing changed, nothing sent).
const ops = [
  'down:KeyA', 'down:KeyA', 'down:ShiftLeft', 'down:KeyB', 'up:KeyA', 'down:Foo', 'up:Foo', 'up:ShiftLeft',
  'down:Digit1', 'down:Digit2', 'down:Digit3', 'down:Digit4', 'down:Digit5', 'down:Digit6', 'down:Digit7',
  'up:Digit7', 'up:Digit1', 'down:ControlRight', 'down:F12', 'down:Numpad0', 'down:NumpadEnter', 'reset', 'reset',
  'down:Space', 'down:ArrowUp', 'up:Space', 'up:ArrowUp', 'up:ArrowUp', 'down:IntlBackslash', 'down:MetaLeft', 'reset',
]
const keyboard = new HidKeyboard()
const keyboardReports = ops.map((op) => {
  if (op === 'reset') return hex(keyboard.reset())
  const [kind, code] = op.split(':')
  return hex(kind === 'down' ? keyboard.down(code) : keyboard.up(code))
})

// The key: the same private key, the signature over a fixed token and the public key the library makes.
const der = new Uint8Array(readFileSync(`${dir}/../fixtures/adb-test-key.der`))
const tokens = [Uint8Array.from({ length: 20 }, (_, i) => i * 13 + 1), Uint8Array.from({ length: 20 }, () => 255), Uint8Array.from({ length: 20 }, () => 0)]
const publicKey = adbGeneratePublicKey(der)
if (publicKey.length !== adbGetPublicKeySize()) throw new Error('the public key has an unexpected size')
const key = { signatures: tokens.map((t) => ({ token: hex(t), signature: hex(rsaSign(der, t)) })), publicKey: hex(publicKey) }

writeFileSync(
  `${dir}/mirror.json`,
  `${JSON.stringify({ version: '3.3.3', descriptor: hex(KEYBOARD_REPORT_DESCRIPTOR), args, control, keyboard: { ops, reports: keyboardReports }, key }, null, 1)}\n`,
)
console.log('Handy: ' + args.length + ' Argumentlisten, ' + Object.values(control).flat().length + ' Steuernachrichten, ' + ops.length + ' Tastenberichte')
