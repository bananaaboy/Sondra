//! A USB keyboard for the phone, as scrcpy's `--keyboard=uhid` makes one (`src/lib/hidKeyboard.ts`). The phone
//! gets a virtual HID keyboard and every key press goes to it as a boot-keyboard report: modifiers, and up to
//! six keys held at once. To Android it is a real keyboard — shortcuts, held keys and the layout work as with a
//! cable-connected one. Keys are taken by `KeyboardEvent.code`, the place on the keyboard, not the letter.

/// The report descriptor of a standard boot keyboard (USB HID 1.11, appendix B.1).
pub const KEYBOARD_REPORT_DESCRIPTOR: [u8; 63] = [
    0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x95, 0x01, 0x75, 0x08, 0x81, 0x01, 0x95, 0x05, 0x75, 0x01, 0x05, 0x08, 0x19, 0x01, 0x29,
    0x05, 0x91, 0x02, 0x95, 0x01, 0x75, 0x03, 0x91, 0x01, 0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00, 0xc0,
];

/// The device id of the keyboard in scrcpy's control protocol.
pub const HID_KEYBOARD_ID: u16 = 1;

fn modifier_bit(code: &str) -> Option<u8> {
    Some(match code {
        "ControlLeft" => 0x01,
        "ShiftLeft" => 0x02,
        "AltLeft" => 0x04,
        "MetaLeft" => 0x08,
        "ControlRight" => 0x10,
        "ShiftRight" => 0x20,
        "AltRight" => 0x40,
        "MetaRight" => 0x80,
        _ => return None,
    })
}

/// The HID usage (page 0x07) of a key, by `KeyboardEvent.code`.
fn usage(code: &str) -> Option<u8> {
    let named = match code {
        "Enter" => 0x28,
        "Escape" => 0x29,
        "Backspace" => 0x2a,
        "Tab" => 0x2b,
        "Space" => 0x2c,
        "Minus" => 0x2d,
        "Equal" => 0x2e,
        "BracketLeft" => 0x2f,
        "BracketRight" => 0x30,
        "Backslash" => 0x31,
        "IntlHash" => 0x32,
        "Semicolon" => 0x33,
        "Quote" => 0x34,
        "Backquote" => 0x35,
        "Comma" => 0x36,
        "Period" => 0x37,
        "Slash" => 0x38,
        "CapsLock" => 0x39,
        "PrintScreen" => 0x46,
        "ScrollLock" => 0x47,
        "Pause" => 0x48,
        "Insert" => 0x49,
        "Home" => 0x4a,
        "PageUp" => 0x4b,
        "Delete" => 0x4c,
        "End" => 0x4d,
        "PageDown" => 0x4e,
        "ArrowRight" => 0x4f,
        "ArrowLeft" => 0x50,
        "ArrowDown" => 0x51,
        "ArrowUp" => 0x52,
        "NumLock" => 0x53,
        "NumpadDivide" => 0x54,
        "NumpadMultiply" => 0x55,
        "NumpadSubtract" => 0x56,
        "NumpadAdd" => 0x57,
        "NumpadEnter" => 0x58,
        "NumpadDecimal" => 0x63,
        "IntlBackslash" => 0x64,
        "ContextMenu" => 0x65,
        "Digit0" => 0x27,
        "Numpad0" => 0x62,
        _ => 0,
    };
    if named != 0 {
        return Some(named);
    }
    // KeyA…KeyZ, Digit1…Digit9, F1…F12, Numpad1…Numpad9: written as numbers without a leading zero.
    let number = |prefix: &str, most: u8| code.strip_prefix(prefix).filter(|d| !d.starts_with('0')).and_then(|d| d.parse::<u8>().ok()).filter(|n| (1..=most).contains(n));
    if let Some(letter) = code.strip_prefix("Key") {
        let mut chars = letter.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_uppercase() {
                return Some(0x04 + (c as u8 - b'A'));
            }
        }
    }
    if let Some(n) = number("Digit", 9) {
        return Some(0x1d + n);
    }
    if let Some(n) = number("F", 12) {
        return Some(0x39 + n);
    }
    number("Numpad", 9).map(|n| 0x58 + n)
}

/// True for a key the keyboard report can carry.
pub fn is_hid_key(code: &str) -> bool {
    usage(code).is_some() || modifier_bit(code).is_some()
}

/// The usage „ErrorRollOver“: more than six keys at once, reported in every slot.
const ROLL_OVER: u8 = 0x01;

/// What is held down, and the report that says so. `down` and `up` return the report to send — or none when
/// nothing changed (an unknown key, a key already down: the system repeats `keydown` while a key is held).
#[derive(Debug, Default)]
pub struct HidKeyboard {
    modifiers: u8,
    keys: Vec<u8>,
}

impl HidKeyboard {
    pub fn new() -> HidKeyboard {
        HidKeyboard::default()
    }

    /// The report for the current state: modifiers, reserved, six slots.
    pub fn report(&self) -> [u8; 8] {
        let mut report = [0u8; 8];
        report[0] = self.modifiers;
        if self.keys.len() > 6 {
            report[2..].fill(ROLL_OVER);
        } else {
            for (slot, usage) in self.keys.iter().enumerate() {
                report[2 + slot] = *usage;
            }
        }
        report
    }

    pub fn down(&mut self, code: &str) -> Option<[u8; 8]> {
        if let Some(bit) = modifier_bit(code) {
            if self.modifiers & bit != 0 {
                return None;
            }
            self.modifiers |= bit;
            return Some(self.report());
        }
        let usage = usage(code)?;
        if self.keys.contains(&usage) {
            return None;
        }
        self.keys.push(usage);
        Some(self.report())
    }

    pub fn up(&mut self, code: &str) -> Option<[u8; 8]> {
        if let Some(bit) = modifier_bit(code) {
            if self.modifiers & bit == 0 {
                return None;
            }
            self.modifiers &= !bit;
            return Some(self.report());
        }
        let at = self.keys.iter().position(|k| Some(*k) == usage(code))?;
        self.keys.remove(at);
        Some(self.report())
    }

    /// Everything let go — when the window loses the focus, a held key would stay held on the phone.
    pub fn reset(&mut self) -> Option<[u8; 8]> {
        if self.modifiers == 0 && self.keys.is_empty() {
            return None;
        }
        self.modifiers = 0;
        self.keys.clear();
        Some(self.report())
    }
}
