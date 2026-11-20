//! The three faces, embedded (`fonts/LIZENZ.md`: SIL Open Font License 1.1).

use std::borrow::Cow;

use gpui::App;

const FILES: [&[u8]; 7] = [
    include_bytes!("../fonts/Barlow-Regular.ttf"),
    include_bytes!("../fonts/Barlow-Medium.ttf"),
    include_bytes!("../fonts/Barlow-SemiBold.ttf"),
    include_bytes!("../fonts/Barlow-Bold.ttf"),
    include_bytes!("../fonts/CourierPrime-Regular.ttf"),
    include_bytes!("../fonts/CourierPrime-Bold.ttf"),
    include_bytes!("../fonts/CormorantGaramond-Light.ttf"),
];

/// Makes Barlow, Courier Prime and Cormorant Garamond known to the text system. Call once, before
/// the first window.
pub fn load(cx: &App) {
    let fonts: Vec<Cow<'static, [u8]>> = FILES.iter().map(|bytes| Cow::Borrowed(*bytes)).collect();
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        eprintln!("Schriften konnten nicht geladen werden: {error}");
    }
}
