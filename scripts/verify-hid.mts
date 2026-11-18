// The phone's keyboard: the descriptor is the standard boot keyboard, keys map by position, reports follow what is held.
import { HID_KEYBOARD_ID, HidKeyboard, KEYBOARD_REPORT_DESCRIPTOR, isHidKey } from '../src/lib/hidKeyboard'

let failed = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok   ' : 'FEHLT'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}
const hex = (report: Uint8Array | null) => (report ? [...report].map((byte) => byte.toString(16).padStart(2, '0')).join(' ') : 'null')

// USB HID 1.11, appendix B.1: 63 bytes, ending in End Collection.
check('Beschreibung: 63 Byte, Anfang Keyboard, Ende End Collection', KEYBOARD_REPORT_DESCRIPTOR.length === 63 && KEYBOARD_REPORT_DESCRIPTOR[0] === 0x05 && KEYBOARD_REPORT_DESCRIPTOR[3] === 0x06 && KEYBOARD_REPORT_DESCRIPTOR.at(-1) === 0xc0, String(KEYBOARD_REPORT_DESCRIPTOR.length))
check('Gerätenummer 1 wie bei scrcpy', HID_KEYBOARD_ID === 1)

const keyboard = new HidKeyboard()
check('A drücken: Usage 0x04 im ersten Platz', hex(keyboard.down('KeyA')) === '00 00 04 00 00 00 00 00')
check('A gehalten: der Wiederholungs-keydown ändert nichts', keyboard.down('KeyA') === null)
check('Z liegt auf der Position von Z (0x1d), Ziffer 1 auf 0x1e, 0 auf 0x27', hex(keyboard.down('KeyZ')).startsWith('00 00 04 1d') && isHidKey('Digit1') && isHidKey('Digit0'))
check('A loslassen: Z rückt auf den ersten Platz', hex(keyboard.up('KeyA')) === '00 00 1d 00 00 00 00 00')
check('Umschalt links dazu: Bit 0x02', hex(keyboard.down('ShiftLeft')) === '02 00 1d 00 00 00 00 00')
check('Strg links + Alt rechts (AltGr unter Windows): 0x01 | 0x40', hex(keyboard.down('ControlLeft')) === '03 00 1d 00 00 00 00 00' && hex(keyboard.down('AltRight')) === '43 00 1d 00 00 00 00 00')
check('Alles loslassen auf einmal (Fokus weg)', hex(keyboard.reset()) === '00 00 00 00 00 00 00 00' && keyboard.reset() === null)

const full = new HidKeyboard()
;['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF'].forEach((code) => full.down(code))
check('Sechs Tasten gleichzeitig: sechs Plätze', hex(full.report()) === '00 00 04 05 06 07 08 09')
check('Siebte Taste: ErrorRollOver in allen Plätzen', hex(full.down('KeyG')) === '00 00 01 01 01 01 01 01')
check('Siebte wieder los: die sechs sind zurück', hex(full.up('KeyG')) === '00 00 04 05 06 07 08 09')

const keys = new HidKeyboard()
check('Pfeiltasten, Enter, Entf, F1 und F12, Ziffernblock', ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Delete', 'F1', 'F12', 'Numpad5', 'NumpadEnter', 'Tab', 'Escape', 'Backspace'].every((code) => keys.down(code) !== null || isHidKey(code)))
check('F1 = 0x3a, F12 = 0x45, Ziffernblock 1 = 0x59, 0 = 0x62', hex(new HidKeyboard().down('F1')) === '00 00 3a 00 00 00 00 00' && hex(new HidKeyboard().down('F12')) === '00 00 45 00 00 00 00 00' && hex(new HidKeyboard().down('Numpad1')) === '00 00 59 00 00 00 00 00' && hex(new HidKeyboard().down('Numpad0')) === '00 00 62 00 00 00 00 00')
check('Eine unbekannte Taste (Medientaste) ändert nichts', new HidKeyboard().down('MediaPlayPause') === null && !isHidKey('MediaPlayPause'))
check('Loslassen einer nie gedrückten Taste ändert nichts', new HidKeyboard().up('KeyQ') === null)

process.exit(failed ? 1 : 0)
