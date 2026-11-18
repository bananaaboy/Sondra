/**
 * A USB keyboard for the phone, as scrcpy's `--keyboard=uhid` makes one.
 *
 * The phone gets a virtual HID keyboard (Linux UHID) and every key press of
 * this computer's keyboard goes to it as a boot-keyboard report: modifiers,
 * and up to six keys held at once. To Android it is a real keyboard, so
 * letters, shortcuts, arrow keys and the layout work the way they do with a
 * cable-connected keyboard, and no on-screen keyboard has to be open. (What
 * the SDK way — injecting text — cannot do: key combinations, held keys, any
 * game or terminal that reads keys, not text.)
 *
 * Pure functions and one small state machine; nothing here touches the DOM, so
 * it is checked under Node (`npm run verify:hid`).
 */

/** The report descriptor of a standard boot keyboard (USB HID 1.11, appendix B.1). */
export const KEYBOARD_REPORT_DESCRIPTOR = new Uint8Array([
  0x05, 0x01, // Usage Page (Generic Desktop)
  0x09, 0x06, // Usage (Keyboard)
  0xa1, 0x01, // Collection (Application)
  0x05, 0x07, //   Usage Page (Keyboard/Keypad)
  0x19, 0xe0, //   Usage Minimum (Left Control)
  0x29, 0xe7, //   Usage Maximum (Right GUI)
  0x15, 0x00, //   Logical Minimum (0)
  0x25, 0x01, //   Logical Maximum (1)
  0x75, 0x01, //   Report Size (1)
  0x95, 0x08, //   Report Count (8)
  0x81, 0x02, //   Input (Data, Variable, Absolute): the modifier byte
  0x95, 0x01, //   Report Count (1)
  0x75, 0x08, //   Report Size (8)
  0x81, 0x01, //   Input (Constant): the reserved byte
  0x95, 0x05, //   Report Count (5)
  0x75, 0x01, //   Report Size (1)
  0x05, 0x08, //   Usage Page (LEDs)
  0x19, 0x01, //   Usage Minimum (Num Lock)
  0x29, 0x05, //   Usage Maximum (Kana)
  0x91, 0x02, //   Output (Data, Variable, Absolute): the LEDs
  0x95, 0x01, //   Report Count (1)
  0x75, 0x03, //   Report Size (3)
  0x91, 0x01, //   Output (Constant): padding of the LED byte
  0x95, 0x06, //   Report Count (6)
  0x75, 0x08, //   Report Size (8)
  0x15, 0x00, //   Logical Minimum (0)
  0x25, 0x65, //   Logical Maximum (101)
  0x05, 0x07, //   Usage Page (Keyboard/Keypad)
  0x19, 0x00, //   Usage Minimum (0)
  0x29, 0x65, //   Usage Maximum (101)
  0x81, 0x00, //   Input (Data, Array): the six key slots
  0xc0, // End Collection
])

/** The device id of the keyboard in scrcpy's control protocol (scrcpy's own is 1, too). */
export const HID_KEYBOARD_ID = 1

/** Modifier keys: a bit in the first byte of the report. */
const MODIFIER_BIT: Record<string, number> = {
  ControlLeft: 0x01,
  ShiftLeft: 0x02,
  AltLeft: 0x04,
  MetaLeft: 0x08,
  ControlRight: 0x10,
  ShiftRight: 0x20,
  AltRight: 0x40,
  MetaRight: 0x80,
}

/**
 * `KeyboardEvent.code` (the key's place on the keyboard, whatever the layout
 * says it types) to its HID usage on page 0x07. By position, not by letter:
 * the layout is the phone's to apply, as with any physical keyboard.
 */
const USAGE: Record<string, number> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  IntlHash: 0x32,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  CapsLock: 0x39,
  PrintScreen: 0x46,
  ScrollLock: 0x47,
  Pause: 0x48,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  NumLock: 0x53,
  NumpadDivide: 0x54,
  NumpadMultiply: 0x55,
  NumpadSubtract: 0x56,
  NumpadAdd: 0x57,
  NumpadEnter: 0x58,
  NumpadDecimal: 0x63,
  IntlBackslash: 0x64,
  ContextMenu: 0x65,
}
for (let index = 0; index < 26; index += 1) USAGE[`Key${String.fromCharCode(65 + index)}`] = 0x04 + index
for (let index = 1; index <= 9; index += 1) USAGE[`Digit${index}`] = 0x1d + index
USAGE.Digit0 = 0x27
for (let index = 1; index <= 12; index += 1) USAGE[`F${index}`] = 0x39 + index
for (let index = 1; index <= 9; index += 1) USAGE[`Numpad${index}`] = 0x58 + index
USAGE.Numpad0 = 0x62

/** True for a key the keyboard report can carry. */
export const isHidKey = (code: string): boolean => code in USAGE || code in MODIFIER_BIT

/** The usage "ErrorRollOver": more than six keys at once, reported in every slot. */
const ROLL_OVER = 0x01

/**
 * What is held down, and the report that says so.
 *
 * `down` and `up` return the report to send — or `null` when nothing changed
 * (an unknown key, a key already down: the browser repeats `keydown` while a
 * key is held, and the phone repeats on its own from the held key).
 */
export class HidKeyboard {
  #modifiers = 0
  #keys: number[] = []

  /** The report for the current state: modifiers, reserved, six slots. */
  report(): Uint8Array {
    const report = new Uint8Array(8)
    report[0] = this.#modifiers
    if (this.#keys.length > 6) report.fill(ROLL_OVER, 2)
    else this.#keys.forEach((usage, slot) => (report[2 + slot] = usage))
    return report
  }

  down(code: string): Uint8Array | null {
    const modifier = MODIFIER_BIT[code]
    if (modifier !== undefined) {
      if (this.#modifiers & modifier) return null
      this.#modifiers |= modifier
      return this.report()
    }
    const usage = USAGE[code]
    if (usage === undefined || this.#keys.includes(usage)) return null
    this.#keys.push(usage)
    return this.report()
  }

  up(code: string): Uint8Array | null {
    const modifier = MODIFIER_BIT[code]
    if (modifier !== undefined) {
      if (!(this.#modifiers & modifier)) return null
      this.#modifiers &= ~modifier
      return this.report()
    }
    const usage = USAGE[code]
    const at = usage === undefined ? -1 : this.#keys.indexOf(usage)
    if (at < 0) return null
    this.#keys.splice(at, 1)
    return this.report()
  }

  /** Everything let go — when the window loses the focus, a held key would stay held on the phone. */
  reset(): Uint8Array | null {
    if (!this.#modifiers && !this.#keys.length) return null
    this.#modifiers = 0
    this.#keys = []
    return this.report()
  }
}
