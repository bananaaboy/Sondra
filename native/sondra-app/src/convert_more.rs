//! The rest of „Umwandeln“ as on the website (`ConverterPanel.tsx`): for sound the bitrate or variable
//! quality, the bit depth of a WAV, the sample rate and the channels; for video the encoder preset, the frame
//! (as it is or 9:16), the height, the frame rate and the CRF; a cut („Zuschneiden“: start and end in
//! seconds); and the FFmpeg command that runs. Every value is a field of `sondra_media::convert::Settings`,
//! whose arguments are checked against the website's.

use gpui::{div, prelude::*, px, AnyElement, Context, Entity};
use sondra_media::convert::{find_format, rate_for, Frame, Kind, Pick, BITRATES};
use sondra_ui::{TextField, Ui};

use crate::shell::Shell;

pub const VIDEO_PRESETS: [&str; 7] = ["ultrafast", "veryfast", "faster", "fast", "medium", "slow", "veryslow"];
pub const SAMPLE_RATES: [u32; 5] = [22050, 32000, 44100, 48000, 96000];
const HEIGHTS: [u32; 6] = [2160, 1440, 1080, 720, 480, 360];

/// The fields for the cut.
pub struct Trim {
    pub from: Entity<TextField>,
    pub to: Entity<TextField>,
    pub on: bool,
    /// „Welcher Befehl dabei läuft“ is open.
    pub command: bool,
}

impl Trim {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> Trim {
        let from = cx.new(|cx| TextField::new(cx, colors, "Startzeit in Sekunden").value_face().placeholder("0").max_chars(12));
        let to = cx.new(|cx| TextField::new(cx, colors, "Endzeit in Sekunden").value_face().placeholder("Ende").max_chars(12));
        Trim { from, to, on: false, command: false }
    }
}

/// Seconds as typed: „90“, „1:30“, „1:02:03“ or „12,5“.
pub fn read_seconds(text: &str) -> Option<f64> {
    let t = text.trim().replace(',', ".");
    if t.is_empty() {
        return None;
    }
    let mut total = 0.0;
    for part in t.split(':') {
        total = total * 60.0 + part.trim().parse::<f64>().ok().filter(|v| *v >= 0.0)?;
    }
    Some(total)
}

impl Shell {
    /// For tests: the fields of the cut (start, end).
    pub fn convert_trim_fields(&self) -> (Entity<TextField>, Entity<TextField>) {
        (self.convert.trim.from.clone(), self.convert.trim.to.clone())
    }

    /// The cut's values into the settings, just before a run; a wrong value is said, not guessed.
    pub(crate) fn convert_read_trim(&mut self, cx: &Context<Self>) -> Result<(), String> {
        let t = &self.convert.trim;
        if !t.on {
            self.convert.settings.trim_start_seconds = None;
            self.convert.settings.trim_end_seconds = None;
            return Ok(());
        }
        let (from, to) = (t.from.read(cx).text().to_string(), t.to.read(cx).text().to_string());
        let start = if from.trim().is_empty() { None } else { Some(read_seconds(&from).ok_or("Die Startzeit ist keine Zeit (etwa 90 oder 1:30).")?) };
        let end = if to.trim().is_empty() { None } else { Some(read_seconds(&to).ok_or("Die Endzeit ist keine Zeit (etwa 120 oder 2:00).")?) };
        if let (Some(s), Some(e)) = (start, end) {
            if e <= s {
                return Err("Das Ende liegt vor dem Anfang.".into());
            }
        }
        self.convert.settings.trim_start_seconds = start;
        self.convert.settings.trim_end_seconds = end;
        Ok(())
    }

    /// The settings that depend on the format, for the settings column.
    pub(crate) fn convert_more_settings(&self, ui: &Ui, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let me = cx.entity();
        let s = &self.convert.settings;
        let Some(format) = find_format(&s.format_id) else { return Vec::new() };
        let mut out: Vec<AnyElement> = Vec::new();
        let chip = |id: String, label: String, on: bool, change: Box<dyn Fn(&mut sondra_media::convert::Settings)>| {
            let me = me.clone();
            ui.chip(id, label, on).on_click(move |_, app| {
                me.update(app, |shell, cx| {
                    change(&mut shell.convert.settings);
                    shell.convert.preset = None;
                    cx.notify();
                })
            })
        };
        let row = || div().flex().flex_wrap().gap(px(6.));
        let has_audio = format.kind != Kind::Image && format.id != "gif" && format.id != "webp";

        // Sound: variable quality where the encoder has it (MP3, Vorbis).
        if has_audio && matches!(format.id, "mp3" | "vorbis") {
            let mut r = row();
            for q in [0u32, 2, 4, 6] {
                r = r.child(chip(format!("vbr-{q}"), format!("VBR q{q}"), s.use_variable_bitrate && s.audio_quality == q, Box::new(move |st| {
                    st.use_variable_bitrate = true;
                    st.audio_quality = q;
                })));
            }
            if format.id == "mp3" {
                for kbps in BITRATES {
                    r = r.child(chip(format!("cbr-{kbps}"), format!("{kbps} kbit/s"), !s.use_variable_bitrate && s.audio_bitrate_kbps == kbps, Box::new(move |st| {
                        st.use_variable_bitrate = false;
                        st.audio_bitrate_kbps = kbps;
                    })));
                }
            }
            out.push(ui.setting("Qualität des Tons", r, Some(if s.use_variable_bitrate { "Variable Bitrate, 0 = beste." } else { "Konstante Bitrate." })));
        }
        if format.id == "wav" {
            let mut r = row();
            for (depth, label) in [(16u8, "16 Bit PCM"), (24, "24 Bit PCM"), (32, "32 Bit Float")] {
                r = r.child(chip(format!("bittiefe-{depth}"), label.into(), s.wav_bit_depth == depth, Box::new(move |st| st.wav_bit_depth = depth)));
            }
            out.push(ui.setting("Bittiefe", r, None));
        }
        if has_audio {
            let now = rate_for(format, s.sample_rate);
            let mut r = row().child(chip("rate-quelle".into(), "Wie Quelle".into(), now == Pick::Source, Box::new(|st| st.sample_rate = Pick::Source)));
            for rate in format.sample_rates.map(|r| r.to_vec()).unwrap_or_else(|| SAMPLE_RATES.to_vec()) {
                let label = format!("{} kHz", format!("{}", rate as f64 / 1000.0).replace('.', ","));
                r = r.child(chip(format!("abtastrate-{rate}"), label, now == Pick::Value(rate), Box::new(move |st| st.sample_rate = Pick::Value(rate))));
            }
            out.push(ui.setting("Abtastrate", r, None));
            let mut r = row();
            for (pick, id, label) in [(Pick::Source, "kanaele-quelle", "Wie Quelle"), (Pick::Value(1u8), "kanaele-mono", "Mono"), (Pick::Value(2u8), "kanaele-stereo", "Stereo")] {
                r = r.child(chip(id.into(), label.into(), s.channels == pick, Box::new(move |st| st.channels = pick)));
            }
            out.push(ui.setting("Kanäle", r, None));
        }

        // Video: what makes it smaller or sharper.
        let moving = format.kind == Kind::Video || format.id == "gif";
        if moving {
            if format.kind == Kind::Video {
                let mut r = row();
                for preset in VIDEO_PRESETS {
                    r = r.child(chip(format!("preset-{preset}"), preset.into(), s.video_preset == preset, Box::new(move |st| st.video_preset = preset.to_string())));
                }
                out.push(ui.setting("Encoder-Preset", r, Some("Langsamer heisst kleiner bei gleicher Qualität.")));
                let mut r = row();
                for (frame, id, label) in [(Frame::Source, "bildformat-quelle", "Wie Quelle"), (Frame::Vertical, "bildformat-hoch", "Hochformat 9:16 (Reels, Stories)")] {
                    r = r.child(chip(id.into(), label.into(), s.video_frame == frame, Box::new(move |st| st.video_frame = frame)));
                }
                out.push(ui.setting("Bildformat", r, None));
            }
            if !(format.kind == Kind::Video && s.video_frame == Frame::Vertical) {
                let mut r = row().child(chip("hoehe-quelle".into(), if format.id == "gif" { "Wie Quelle (480p)".into() } else { "Wie Quelle".into() }, s.video_height == Pick::Source, Box::new(|st| st.video_height = Pick::Source)));
                for h in HEIGHTS {
                    r = r.child(chip(format!("hoehe-{h}"), format!("{h}p"), s.video_height == Pick::Value(h), Box::new(move |st| st.video_height = Pick::Value(h))));
                }
                out.push(ui.setting("Höhe", r, None));
            }
            let rates: &[f64] = if format.id == "gif" { &[24.0, 20.0, 15.0, 12.0, 10.0, 8.0] } else { &[60.0, 50.0, 30.0, 25.0, 24.0] };
            let mut r = row().child(chip("fps-quelle".into(), if format.id == "gif" { "Wie Quelle (12 fps)".into() } else { "Wie Quelle".into() }, s.frame_rate == Pick::Source, Box::new(|st| st.frame_rate = Pick::Source)));
            for fps in rates.iter().copied() {
                r = r.child(chip(format!("fps-{fps}"), format!("{fps} fps"), s.frame_rate == Pick::Value(fps), Box::new(move |st| st.frame_rate = Pick::Value(fps))));
            }
            out.push(ui.setting("Bildrate", r, Some("Weniger Bilder heisst deutlich kleinere Datei.")));
            if format.kind == Kind::Video {
                let crf = s.video_crf;
                let (less, more) = (me.clone(), me.clone());
                let r = div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(ui.button("crf-weniger", "−").small().accessible_name("CRF kleiner (besser, grösser)").disabled(crf <= 14.0).on_click(move |_, app| less.update(app, |shell, cx| {
                        shell.convert.settings.video_crf = (shell.convert.settings.video_crf - 1.0).max(14.0);
                        shell.convert.preset = None;
                        cx.notify();
                    })))
                    .child(ui.value(format!("CRF {}", crf as i64)))
                    .child(ui.button("crf-mehr", "+").small().accessible_name("CRF grösser (kleiner, schlechter)").disabled(crf >= 40.0).on_click(move |_, app| more.update(app, |shell, cx| {
                        shell.convert.settings.video_crf = (shell.convert.settings.video_crf + 1.0).min(40.0);
                        shell.convert.preset = None;
                        cx.notify();
                    })));
                out.push(ui.setting("Qualität des Bildes", r, Some("Niedriger ist besser und grösser. 18 gilt als sichtbar verlustfrei, 23 als guter Kompromiss.")));
            }
        }

        // The cut.
        let t = &self.convert.trim;
        let mut cut = div().flex().flex_col().gap(px(8.)).child({
            let me = me.clone();
            let on = t.on;
            div().flex().child(ui.chip("zuschneiden", "Nur einen Ausschnitt umwandeln", on).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.convert.trim.on = !on;
                cx.notify();
            })))
        });
        if t.on {
            cut = cut.child(div().flex().gap(px(8.)).child(div().w(px(140.)).child(t.from.clone())).child(div().w(px(140.)).child(t.to.clone())));
        }
        out.push(ui.setting("Zuschneiden", cut, Some(if t.on { "Start und Ende in Sekunden oder als 1:30; leer heisst vom Anfang bzw. bis zum Ende." } else { "Bildgenau und verlustarm, nur der gewählte Teil." })));
        out
    }

    /// „Welcher Befehl dabei läuft“: the FFmpeg command for the first file, as it would run.
    pub(crate) fn convert_command(&self, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let me = cx.entity();
        let file = self.convert.files.first()?;
        let format = find_format(&self.convert.settings.format_id)?;
        let open = self.convert.trim.command;
        let mut block = div().flex().flex_col().gap(px(8.)).child(div().flex().child(ui.button("befehl-zeigen", if open { "Befehl verbergen" } else { "Welcher Befehl dabei läuft" }).small().ghost().on_click(move |_, app| me.update(app, |shell, cx| {
            shell.convert.trim.command = !shell.convert.trim.command;
            cx.notify();
        }))));
        if open {
            let output = file.with_extension(format.extension);
            if let Ok(args) = sondra_media::convert::build_args(&file.to_string_lossy(), &output.to_string_lossy(), &self.convert.settings) {
                block = block.child(div().w(px(560.)).child(ui.value(sondra_media::convert::preview_command(&args))));
            }
        }
        Some(block.into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_are_read_as_people_type_them() {
        assert_eq!(read_seconds("90"), Some(90.0));
        assert_eq!(read_seconds("1:30"), Some(90.0));
        assert_eq!(read_seconds("1:02:03"), Some(3723.0));
        assert_eq!(read_seconds("12,5"), Some(12.5));
        assert_eq!(read_seconds("eins"), None);
        assert_eq!(read_seconds(""), None);
    }
}
