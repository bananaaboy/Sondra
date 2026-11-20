//! „Lizenzen“: whose work is in Sondra and under which licence (`public/lizenz.html`). Sondra is MIT; the parts
//! of others keep their own licences, and where a licence asks that its text travels along, the text is here
//! (GPL-2.0 for FFmpeg builds that have x264 in them, Apache-2.0 for the scrcpy server the phone mirror puts on
//! the phone). Opened from the window „Was ist neu“.

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_ui::Ui;

use crate::shell::Shell;

const GPL: &str = include_str!("../../../desktop/lizenzen/GPL-2.0.txt");
const SCRCPY: &str = include_str!("../../../desktop/lizenzen/scrcpy-Apache-2.0.txt");

const MIT: &str = "MIT License\n\nCopyright (c) 2026 Lizge Navajeetharan\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.";

/// Name, licence, where it comes from, and how it is used here.
pub const COMPONENTS: [(&str, &str, &str, &str); 9] = [
    ("FFmpeg", "LGPL-2.1 oder GPL-2.0 oder später, je nach Fassung", "https://ffmpeg.org", "Läuft als eigenes Programm: Umwandeln, Video, Ton, Vorschaubilder, Aufnahme. Eine Fassung mit x264 steht unter der GPL; deren Text steht unten, der Quelltext bei ffmpeg.org."),
    ("whisper.cpp", "MIT", "https://github.com/ggml-org/whisper.cpp", "Untertitel erzeugen und Sprache erkennen, auf diesem Computer."),
    ("Whisper-Modelle", "MIT, © 2022 OpenAI", "https://github.com/openai/whisper", "Nicht mitgeliefert: Sondra holt sie beim ersten Gebrauch von Untertitel von Hugging Face und merkt sie sich."),
    ("ONNX Runtime (Microsoft)", "MIT", "https://github.com/microsoft/onnxruntime", "Führt ein Modell aus, das Sie selbst mitbringen (Spuren trennen, eigenes .onnx-Modell), auf diesem Computer. Es werden keine Modelle mitgeliefert."),
    ("GPUI (Zed Industries)", "Apache-2.0", "https://github.com/zed-industries/zed", "Die Oberfläche."),
    ("scrcpy-Server 3.3.3 (Genymobile)", "Apache-2.0", "https://github.com/Genymobile/scrcpy", "Liegt unverändert bei und wird nur für die Dauer der Verbindung auf das Handy gelegt; der Text steht unten."),
    ("webrtc-rs", "MIT oder Apache-2.0", "https://github.com/webrtc-rs/webrtc", "Die direkte Verbindung zwischen Ihren Geräten."),
    ("yt-dlp", "Unlicense (gemeinfrei)", "https://github.com/yt-dlp/yt-dlp", "Nicht mitgeliefert: Sondra holt es nur auf Ihren Klick von yt-dlp selbst und prüft es gegen die veröffentlichte Prüfsumme."),
    ("Public Sans, Courier Prime, Cormorant", "SIL Open Font License 1.1", "https://fonts.google.com", "Die Schriften der Oberfläche."),
];

impl Shell {
    pub(crate) fn licenses_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.licenses_open {
            return None;
        }
        let c = ui.c;
        let mut body = div().flex().flex_col().gap(px(14.));
        body = body.child(ui.prose("Sondra ist freie Software unter der MIT-Lizenz: Sie dürfen es verwenden, kopieren, verändern und weitergeben, auch kommerziell, solange der Lizenzhinweis mitkommt. Der Quelltext liegt auf GitHub. Bausteine anderer Projekte behalten ihre eigenen Lizenzen."));
        let mut table = div().flex().flex_col();
        for (n, (name, licence, from, how)) in COMPONENTS.iter().enumerate() {
            table = table.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .py(px(10.))
                    .when(n > 0, |d| d.border_t_1().border_color(c.line))
                    .child(div().flex().flex_wrap().items_baseline().gap(px(10.)).child(ui.title(*name)).child(ui.hint(*licence)))
                    .child(ui.prose(*how))
                    .child(ui.value(*from)),
            );
        }
        body = body.child(table);
        for (heading, text) in [("MIT-Lizenz (Sondra)", MIT), ("Apache License 2.0 (scrcpy-Server)", SCRCPY), ("GNU General Public License 2 (FFmpeg-Fassungen mit x264)", GPL)] {
            body = body.child(div().flex().flex_col().gap(px(6.)).pt(px(14.)).border_t_1().border_color(c.line).child(ui.subheading(heading)).child(ui.value(text)));
        }
        let (close, away) = (cx.entity(), cx.entity());
        Some(
            ui.dialog("lizenzen-fenster", "Lizenzen")
                .width(720.)
                .child(body)
                .action(ui.button("lizenzen-datenschutz", "Datenschutzerklärung öffnen").on_click(|_, app| app.open_url("https://sondra.lizge.ch/datenschutz.html")))
                .action(ui.button("lizenzen-schliessen", "Schliessen").primary().on_click(move |_, app| close.update(app, |shell, cx| {
                    shell.licenses_open = false;
                    cx.notify();
                })))
                .on_close(move |_, app| away.update(app, |shell, cx| {
                    shell.licenses_open = false;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}
