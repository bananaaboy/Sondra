//! The bytes the web app sends to the scrcpy server and the reports of its virtual keyboard, made by the very
//! libraries the web app uses; every one of them must come out the same here.

use sondra_mirror::control::*;
use sondra_mirror::hid::{HidKeyboard, HID_KEYBOARD_ID, KEYBOARD_REPORT_DESCRIPTOR};
use sondra_mirror::options::{server_args, Quality};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn table() -> serde_json::Value {
    serde_json::from_str(include_str!("golden/mirror.json")).unwrap()
}

fn list(value: &serde_json::Value) -> Vec<Option<String>> {
    value.as_array().unwrap().iter().map(|v| v.as_str().map(str::to_owned)).collect()
}

#[test]
fn the_server_gets_the_arguments_the_web_app_gives_it() {
    let t = table();
    assert_eq!(t["version"], sondra_mirror::options::SERVER_VERSION);
    for case in t["args"].as_array().unwrap() {
        let quality = if case["smooth"].as_bool().unwrap() { Quality::Smooth } else { Quality::Sharp };
        let want: Vec<String> = case["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect();
        assert_eq!(server_args(quality, case["audio"].as_bool().unwrap()), want, "{case}");
    }
}

#[test]
fn the_keyboard_has_the_web_apps_descriptor_and_reports() {
    let t = table();
    assert_eq!(hex(&KEYBOARD_REPORT_DESCRIPTOR), t["descriptor"].as_str().unwrap());
    let mut keyboard = HidKeyboard::new();
    let ops: Vec<&str> = t["keyboard"]["ops"].as_array().unwrap().iter().map(|o| o.as_str().unwrap()).collect();
    let want = list(&t["keyboard"]["reports"]);
    assert_eq!(ops.len(), want.len());
    for (op, want) in ops.iter().zip(want) {
        let got = match op.split_once(':') {
            None => keyboard.reset(),
            Some(("down", code)) => keyboard.down(code),
            Some((_, code)) => keyboard.up(code),
        };
        assert_eq!(got.map(|r| hex(&r)), want, "after {op}");
    }
}

#[test]
fn every_control_message_is_what_the_web_app_sends() {
    let c = &table()["control"];
    // Keys.
    let codes = [key_code::ENTER, key_code::DEL, key_code::DPAD_LEFT, key_code::MOVE_HOME, key_code::HOME, key_code::APP_SWITCH, key_code::VOLUME_UP, key_code::VOLUME_DOWN, key_code::POWER];
    let want = list(&c["keys"]);
    let mut got = Vec::new();
    for code in codes {
        got.push(Some(hex(&inject_key(KeyAction::Down, code))));
        got.push(Some(hex(&inject_key(KeyAction::Up, code))));
    }
    assert_eq!(got, want, "the named keys");
    // Text, through umlauts, other scripts and an emoji.
    let texts = ["a", "hallo", "äöü ß", "日本語 😀", ""];
    assert_eq!(texts.iter().map(|t| Some(hex(&inject_text(t)))).collect::<Vec<_>>(), list(&c["text"]));
    // Touch, in three sizes of picture, and with the pointer beyond the edge.
    let touch = |a, w, h, x, y, p| Some(hex(&inject_touch(a, Place::at(w, h, x, y), p)));
    assert_eq!(
        vec![
            touch(TouchAction::Down, 1080, 2400, 0.5, 0.5, 1.0),
            touch(TouchAction::Move, 1080, 2400, 0.25, 0.75, 1.0),
            touch(TouchAction::Up, 1080, 2400, 0.25, 0.75, 0.0),
            touch(TouchAction::Down, 720, 1280, 0.0, 0.0, 1.0),
            touch(TouchAction::Up, 720, 1280, 1.0, 1.0, 0.0),
            touch(TouchAction::Move, 1920, 1080, -0.2, 1.4, 1.0),
        ],
        list(&c["touch"])
    );
    // The wheel.
    assert_eq!(
        vec![
            Some(hex(&inject_scroll(Place::at(1080, 2400, 0.5, 0.5), 0.0, -1.0))),
            Some(hex(&inject_scroll(Place::at(1080, 2400, 0.1, 0.9), 1.0, 0.5))),
            Some(hex(&inject_scroll(Place::at(720, 1280, 0.5, 0.5), 0.0, 3.0))),
        ],
        list(&c["scroll"])
    );
    assert_eq!(vec![Some(hex(&back_or_screen_on(KeyAction::Down))), Some(hex(&back_or_screen_on(KeyAction::Up)))], list(&c["back"]));
    assert_eq!(
        vec![Some(hex(&expand_notification_panel())), Some(hex(&expand_settings_panel())), Some(hex(&collapse_panels())), Some(hex(&rotate_device()))],
        list(&c["panels"])
    );
    // The virtual keyboard: made, fed a report, taken away.
    assert_eq!(
        vec![
            Some(hex(&uhid_create(HID_KEYBOARD_ID, 0, 0, "Sondra Tastatur", &KEYBOARD_REPORT_DESCRIPTOR))),
            Some(hex(&uhid_input(HID_KEYBOARD_ID, &[0, 0, 4, 0, 0, 0, 0, 0]))),
            Some(hex(&uhid_destroy(HID_KEYBOARD_ID))),
        ],
        list(&c["uhid"])
    );
}
