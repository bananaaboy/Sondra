//! The messages a client sends the scrcpy server on its control stream (scrcpy 3.3.x), in the bytes the web
//! app's library sends. Every function returns one whole message.

/// Android's `KeyEvent` actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyAction {
    Down = 0,
    Up = 1,
}

/// Android's `MotionEvent` actions that a finger uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TouchAction {
    Down = 0,
    Up = 1,
    Move = 2,
}

/// The pointer id of a finger (`-2` in scrcpy's protocol).
const FINGER: i64 = -2;

mod kind {
    pub const KEY: u8 = 0;
    pub const TEXT: u8 = 1;
    pub const TOUCH: u8 = 2;
    pub const SCROLL: u8 = 3;
    pub const BACK_OR_SCREEN_ON: u8 = 4;
    pub const EXPAND_NOTIFICATIONS: u8 = 5;
    pub const EXPAND_SETTINGS: u8 = 6;
    pub const COLLAPSE_PANELS: u8 = 7;
    pub const ROTATE: u8 = 11;
    pub const UHID_CREATE: u8 = 12;
    pub const UHID_INPUT: u8 = 13;
    pub const UHID_DESTROY: u8 = 14;
}

/// Android key codes the page uses.
pub mod key_code {
    pub const HOME: u32 = 3;
    pub const BACK: u32 = 4;
    pub const VOLUME_UP: u32 = 24;
    pub const VOLUME_DOWN: u32 = 25;
    pub const POWER: u32 = 26;
    pub const DPAD_LEFT: u32 = 21;
    pub const DPAD_UP: u32 = 19;
    pub const DPAD_RIGHT: u32 = 22;
    pub const DPAD_DOWN: u32 = 20;
    pub const TAB: u32 = 61;
    pub const ENTER: u32 = 66;
    pub const DEL: u32 = 67;
    pub const FORWARD_DEL: u32 = 112;
    pub const ESCAPE: u32 = 111;
    pub const PAGE_UP: u32 = 92;
    pub const PAGE_DOWN: u32 = 93;
    pub const MOVE_HOME: u32 = 122;
    pub const MOVE_END: u32 = 123;
    pub const APP_SWITCH: u32 = 187;
}

pub fn inject_key(action: KeyAction, key_code: u32) -> Vec<u8> {
    let mut m = vec![kind::KEY, action as u8];
    m.extend(key_code.to_be_bytes());
    m.extend(0u32.to_be_bytes()); // repeat
    m.extend(0u32.to_be_bytes()); // meta state
    m
}

pub fn inject_text(text: &str) -> Vec<u8> {
    let mut m = vec![kind::TEXT];
    m.extend((text.len() as u32).to_be_bytes());
    m.extend(text.as_bytes());
    m
}

/// A place on the picture: where a pointer is, in the picture's own pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Place {
    pub x: u32,
    pub y: u32,
    pub width: u16,
    pub height: u16,
}

impl Place {
    /// A place from where the pointer is on the picture, as a share of its width and height (0 to 1; what is
    /// beyond is clamped to the edge).
    pub fn at(width: u32, height: u32, x: f64, y: f64) -> Place {
        let pixel = |share: f64, size: u32| (share.clamp(0.0, 1.0) * f64::from(size.saturating_sub(1)) + 0.5).floor() as u32;
        Place { x: pixel(x, width), y: pixel(y, height), width: width.min(u32::from(u16::MAX)) as u16, height: height.min(u32::from(u16::MAX)) as u16 }
    }

    fn put(self, m: &mut Vec<u8>) {
        m.extend(self.x.to_be_bytes());
        m.extend(self.y.to_be_bytes());
        m.extend(self.width.to_be_bytes());
        m.extend(self.height.to_be_bytes());
    }
}

/// `pressure` from 0 to 1.
pub fn inject_touch(action: TouchAction, place: Place, pressure: f64) -> Vec<u8> {
    let mut m = vec![kind::TOUCH, action as u8];
    m.extend(FINGER.to_be_bytes());
    place.put(&mut m);
    let pressure = pressure.clamp(-1.0, 1.0);
    let fixed: u16 = if pressure == 1.0 { 0xffff } else { (pressure * 65536.0) as u16 };
    m.extend(fixed.to_be_bytes());
    m.extend(0u32.to_be_bytes()); // action button
    m.extend(0u32.to_be_bytes()); // buttons
    m
}

/// A signed fixed-point number of 16 bits, as scrcpy reads one: from −1 to 1.
fn signed_fixed(value: f64) -> i16 {
    let v = value.clamp(-1.0, 1.0);
    if v == 1.0 {
        0x7fff
    } else {
        (v * 32768.0) as i16
    }
}

/// A scroll of the wheel: `x` and `y` in steps (16 steps is the most the protocol carries).
pub fn inject_scroll(place: Place, scroll_x: f64, scroll_y: f64) -> Vec<u8> {
    let mut m = vec![kind::SCROLL];
    place.put(&mut m);
    m.extend(signed_fixed(scroll_x / 16.0).to_be_bytes());
    m.extend(signed_fixed(scroll_y / 16.0).to_be_bytes());
    m.extend(0u32.to_be_bytes()); // buttons
    m
}

/// „Back“, or the screen on if it is off.
pub fn back_or_screen_on(action: KeyAction) -> Vec<u8> {
    vec![kind::BACK_OR_SCREEN_ON, action as u8]
}

pub fn expand_notification_panel() -> Vec<u8> {
    vec![kind::EXPAND_NOTIFICATIONS]
}

pub fn expand_settings_panel() -> Vec<u8> {
    vec![kind::EXPAND_SETTINGS]
}

pub fn collapse_panels() -> Vec<u8> {
    vec![kind::COLLAPSE_PANELS]
}

pub fn rotate_device() -> Vec<u8> {
    vec![kind::ROTATE]
}

/// Makes a virtual HID device on the phone. `name` is at most 255 bytes, the descriptor at most 65 535.
pub fn uhid_create(id: u16, vendor: u16, product: u16, name: &str, descriptor: &[u8]) -> Vec<u8> {
    let name = &name.as_bytes()[..name.len().min(255)];
    let mut m = vec![kind::UHID_CREATE];
    m.extend(id.to_be_bytes());
    m.extend(vendor.to_be_bytes());
    m.extend(product.to_be_bytes());
    m.push(name.len() as u8);
    m.extend(name);
    m.extend((descriptor.len() as u16).to_be_bytes());
    m.extend(descriptor);
    m
}

pub fn uhid_input(id: u16, data: &[u8]) -> Vec<u8> {
    let mut m = vec![kind::UHID_INPUT];
    m.extend(id.to_be_bytes());
    m.extend((data.len() as u16).to_be_bytes());
    m.extend(data);
    m
}

pub fn uhid_destroy(id: u16) -> Vec<u8> {
    let mut m = vec![kind::UHID_DESTROY];
    m.extend(id.to_be_bytes());
    m
}
