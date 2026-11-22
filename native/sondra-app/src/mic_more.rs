//! The rest of the website's Mikrofon page: where Sondra plays (headphones, say) with a test tone; a short sample
//! („Probe“, up to 15 seconds) to listen to, with the one-click speech enhancement (`sondra_media::speech_enhance`,
//! the website's `enhanceSpeechAudioData`) on by default; samples and the set-up take into the session; and
//! „Aufnahme mit 1 Klick verbessern“ for a recording that is already there. Nothing of it leaves this computer.

use std::path::{Path, PathBuf};

use gpui::{div, prelude::*, px, AnyElement, Context, PathPromptOptions};
use sondra_media::audio::{decode_file, write_wav_f32, AudioData};
use sondra_media::speech_enhance::{enhance_speech, SpeechEnhance};
use sondra_media::Ffmpeg;
use sondra_merk::folder::AssetKind;
use sondra_ui::{radius, Ui};

use crate::clip_player::ClipPlayer;
use crate::mic_page::Phase;
use crate::session::kind_of;
use crate::shell::Shell;

/// How long a sample runs at most.
pub const PROBE_SECONDS: f64 = 15.0;

/// What is playing on the page right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listening {
    Tone,
    ProbeEnhanced,
    ProbeRaw,
}

/// One second of 440 Hz at −14 dBFS, faded in and out over 20 ms and 100 ms (the website's `playTestTone`).
pub fn test_tone(rate: u32) -> AudioData {
    let n = rate as usize;
    let samples = (0..n)
        .map(|i| {
            let t = i as f32 / rate as f32;
            let ramp = (t / 0.02).min(1.0).min(((1.0 - t) / 0.1).max(0.0));
            0.2 * ramp * (2.0 * std::f32::consts::PI * 440.0 * t).sin()
        })
        .collect();
    AudioData { channels: vec![samples], sample_rate: rate }
}

/// Where a sample or a set-up take is written for the session: the session holds files, not bytes.
fn session_folder() -> PathBuf {
    crate::store::downloads_dir()
}

fn write_for_session(audio: &AudioData, name: &str) -> Result<PathBuf, String> {
    let dir = session_folder();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = sondra_media::run::unique_path(&dir, name, "wav");
    write_wav_f32(&path, audio).map_err(|e| e.to_string())?;
    Ok(path)
}

impl Shell {
    /// „Wiedergabe über“: every sound Sondra starts after this goes to that device; `None` is the system's default.
    pub fn mic_choose_output(&mut self, name: Option<String>, cx: &mut Context<Self>) {
        sondra_audio::set_output_device(name.clone());
        self.mic.output = name;
        self.mic.tone_said = None;
        cx.notify();
    }

    /// Another way to list the outputs (a test).
    pub fn mic_with_outputs(&mut self, list: crate::mic_page::ListMics) {
        self.mic.outputs = list;
    }

    pub fn mic_output(&self) -> Option<String> {
        self.mic.output.clone()
    }

    /// „Ausgang testen“: a tone of one second, and which device it went to.
    pub fn mic_test_tone(&mut self, cx: &mut Context<Self>) {
        let player = ClipPlayer::start(&test_tone(48_000), 0.0, 1.0);
        let device = self.mic.output.clone().unwrap_or_else(|| "Standardgerät".into());
        self.mic.tone_said = Some(format!("Testton 440 Hz über {device}"));
        self.mic.listening = Some((player, Listening::Tone));
        cx.notify();
    }

    pub fn mic_tone_said(&self) -> Option<String> {
        self.mic.tone_said.clone()
    }

    /// „Probe aufnehmen“ and, while it runs, „Probe beenden“.
    pub fn mic_probe(&mut self, cx: &mut Context<Self>) {
        let m = &mut self.mic;
        match m.phase {
            Phase::Probe => self.mic_probe_done(cx),
            Phase::Idle if m.capture.is_some() => {
                if let Some(capture) = m.capture.as_mut() {
                    let _ = capture.take();
                }
                m.take.clear();
                m.probe = None;
                m.error = None;
                m.phase = Phase::Probe;
                cx.notify();
            }
            _ => {}
        }
    }

    /// Ends the sample: under a third of a second is no sample.
    pub(crate) fn mic_probe_done(&mut self, cx: &mut Context<Self>) {
        let m = &mut self.mic;
        if let Some(capture) = m.capture.as_mut() {
            m.take.extend(capture.take());
        }
        let take = std::mem::take(&mut m.take);
        m.phase = Phase::Idle;
        if take.len() as f64 > f64::from(m.rate) * 0.3 {
            m.probe = Some(AudioData { channels: vec![take], sample_rate: m.rate });
        }
        cx.notify();
    }

    pub fn mic_probe_audio(&self) -> Option<&AudioData> {
        self.mic.probe.as_ref()
    }

    /// The sample as it would go into the session: enhanced when the switch is on.
    fn mic_probe_kept(&self) -> Option<AudioData> {
        let probe = self.mic.probe.as_ref()?;
        Some(if self.mic.enhance_probe { enhance_speech(probe, SpeechEnhance::default()) } else { probe.clone() })
    }

    pub fn mic_set_enhance_probe(&mut self, on: bool, cx: &mut Context<Self>) {
        self.mic.enhance_probe = on;
        cx.notify();
    }

    /// Plays the sample, enhanced or as recorded; the same button again stops it.
    pub fn mic_probe_listen(&mut self, enhanced: bool, cx: &mut Context<Self>) {
        let what = if enhanced { Listening::ProbeEnhanced } else { Listening::ProbeRaw };
        if self.mic.listening.as_ref().is_some_and(|(_, l)| *l == what) {
            self.mic.listening = None;
            cx.notify();
            return;
        }
        let Some(probe) = self.mic.probe.as_ref() else { return };
        let audio = if enhanced { enhance_speech(probe, SpeechEnhance::default()) } else { probe.clone() };
        let length = audio.frames() as f64 / f64::from(audio.sample_rate.max(1));
        self.mic.listening = Some((ClipPlayer::start(&audio, 0.0, length), what));
        cx.notify();
    }

    pub fn mic_listening(&self) -> Option<Listening> {
        self.mic.listening.as_ref().map(|(_, l)| *l)
    }

    /// „(Verbesserte) Probe in die Sitzung“.
    pub fn mic_probe_to_session(&mut self, cx: &mut Context<Self>) {
        let Some(audio) = self.mic_probe_kept() else { return };
        let name = if self.mic.enhance_probe { "mikrofon-probe-verbessert" } else { "mikrofon-probe" };
        self.mic_put_in_session(&audio, name, cx);
    }

    /// „In die Sitzung“ under the set-up: the take as the chain left it.
    pub fn mic_processed_to_session(&mut self, cx: &mut Context<Self>) {
        let Some(result) = self.mic.result.clone() else { return };
        let name = format!("mikrofon-{}-gefiltert", sondra_media::mic::profile_for(self.mic.purpose).label.to_lowercase().replace([' ', '/'], "-"));
        self.mic_put_in_session(&result.processed, &name, cx);
    }

    fn mic_put_in_session(&mut self, audio: &AudioData, name: &str, cx: &mut Context<Self>) {
        match write_for_session(audio, name) {
            Ok(path) => {
                let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                self.session_add(vec![path], cx);
                self.mic.said = Some(format!("„{file}“ ist in der Sitzung."));
            }
            Err(e) => self.mic.error = Some(e),
        }
        cx.notify();
    }

    pub fn mic_said(&self) -> Option<String> {
        self.mic.said.clone()
    }

    /// „Aufnahme mit 1 Klick verbessern“: the enhancement on a recording of the session (or one chosen), written
    /// beside it as „… (verbessert).wav“ and put into the session.
    pub fn mic_one_click(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if self.mic.one_click {
            return;
        }
        self.mic.one_click = true;
        self.mic.error = None;
        self.mic.said = None;
        Self::in_background(
            cx,
            move || -> Result<PathBuf, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let audio = decode_file(&ff, &path, None).map_err(|e| e.to_string())?;
                let better = enhance_speech(&audio, SpeechEnhance::default());
                let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Aufnahme".into());
                let target = sondra_media::run::unique_path(path.parent().unwrap_or(Path::new(".")), &format!("{stem} (verbessert)"), "wav");
                write_wav_f32(&target, &better).map_err(|e| e.to_string())?;
                Ok(target)
            },
            |shell, answer, cx| {
                shell.mic.one_click = false;
                match answer {
                    Ok(path) => {
                        let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        shell.mic.made.push(path.clone());
                        shell.session_add(vec![path], cx);
                        shell.mic.said = Some(format!("„{file}“ ist verbessert und in der Sitzung."));
                    }
                    Err(e) => shell.mic.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    fn mic_one_click_choose(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.mic_one_click(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// „Wiedergabe über“ with „Ausgang testen“, for the settings column.
    pub(crate) fn mic_output_block(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let outputs = (self.mic.outputs)();
        let mut chips = div().flex().flex_wrap().gap(px(6.));
        {
            let me = me.clone();
            chips = chips.child(ui.chip("ausgang-standard", "Standardgerät", self.mic.output.is_none()).accessible_name("Wiedergabe über Standardgerät").on_click(move |_, app| me.update(app, |shell, cx| shell.mic_choose_output(None, cx))));
        }
        for name in outputs {
            let me = me.clone();
            let selected = self.mic.output.as_deref() == Some(name.as_str());
            let n = name.clone();
            chips = chips.child(ui.chip(format!("ausgang-{name}"), name.clone(), selected).accessible_name(format!("Wiedergabe über {name}")).on_click(move |_, app| {
                let n = n.clone();
                me.update(app, |shell, cx| shell.mic_choose_output(Some(n), cx))
            }));
        }
        let mut body = div().flex().flex_col().gap(px(8.)).child(chips);
        let mut row = div().flex().flex_wrap().items_center().gap(px(10.));
        {
            let me = me.clone();
            row = row.child(ui.button("ausgang-testen", "Ausgang testen").small().ghost().on_click(move |_, app| me.update(app, |shell, cx| shell.mic_test_tone(cx))));
        }
        if let Some(said) = &self.mic.tone_said {
            row = row.child(ui.value(said.clone()));
        }
        body = body.child(row);
        ui.setting("Wiedergabe über", body, Some("Gilt für alles, was Sondra danach abspielt — vorher und nachher hier, den Player, die Werkzeuge. Mit Kopfhörern hören Sie, was das Mikrofon wirklich aufnimmt."))
    }

    /// The sample: record, listen enhanced or as it was, into the session.
    pub(crate) fn mic_probe_block(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let m = &self.mic;
        let probing = m.phase == Phase::Probe;
        let mut block = div().flex().flex_col().gap(px(10.)).p(px(16.)).rounded(px(radius::CARD)).bg(c.panel_soft).child(ui.title("Probe"));
        let mut row = div().flex().flex_wrap().items_center().gap(px(8.));
        {
            let me = me.clone();
            let label = if probing { "Probe beenden" } else if m.probe.is_some() { "Neue Probe aufnehmen" } else { "Probe aufnehmen" };
            let busy = !probing && m.phase != Phase::Idle;
            row = row.child(ui.button("probe-aufnehmen", label).small().primary_when(probing).disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.mic_probe(cx))));
        }
        {
            let me = me.clone();
            let on = m.enhance_probe;
            row = row.child(ui.chip("probe-verbessern", "Ein-Klick-Sprachverbesserung (KI)", on).accessible_name("Ein-Klick-Sprachverbesserung").on_click(move |_, app| me.update(app, |shell, cx| shell.mic_set_enhance_probe(!on, cx))));
        }
        block = block.child(row).child(ui.hint(format!("bis {} Sekunden, zum Anhören. Die Verbesserung unterdrückt Rauschen, Tastaturklicken und Raumhall und hebt die Verständlichkeit an — auf diesem Computer gerechnet.", PROBE_SECONDS as u32)));
        if probing {
            let fraction = m.take.len() as f64 / f64::from(m.rate) / PROBE_SECONDS;
            block = block.child(ui.bar("probe-laeuft", Some(fraction as f32), "Nimmt auf"));
        }
        if m.probe.is_some() {
            let mut listen = div().flex().flex_wrap().gap(px(8.));
            let playing = self.mic_listening();
            if m.enhance_probe {
                let me = me.clone();
                let label = if playing == Some(Listening::ProbeEnhanced) { "Anhalten" } else { "Verbessert anhören" };
                listen = listen.child(ui.button("probe-verbessert-hoeren", label).small().primary().accessible_name("Probe verbessert anhören").on_click(move |_, app| me.update(app, |shell, cx| shell.mic_probe_listen(true, cx))));
            }
            {
                let me = me.clone();
                let label = if playing == Some(Listening::ProbeRaw) { "Anhalten" } else if m.enhance_probe { "Original anhören" } else { "Probe anhören" };
                listen = listen.child(ui.button("probe-original-hoeren", label).small().accessible_name("Probe im Original anhören").on_click(move |_, app| me.update(app, |shell, cx| shell.mic_probe_listen(false, cx))));
            }
            {
                let me = me.clone();
                let label = if m.enhance_probe { "Verbesserte Probe in die Sitzung" } else { "Probe in die Sitzung" };
                listen = listen.child(ui.button("probe-in-sitzung", label).small().on_click(move |_, app| me.update(app, |shell, cx| shell.mic_probe_to_session(cx))));
            }
            block = block.child(listen);
        }
        block.into_any_element()
    }

    /// „Aufnahme mit 1 Klick verbessern“: the recordings of the session as chips, or another file.
    pub(crate) fn mic_one_click_block(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let busy = self.mic.one_click;
        let recordings: Vec<PathBuf> = self.session_files().into_iter().filter(|p| matches!(kind_of(p), AssetKind::Audio | AssetKind::Video)).collect();
        let mut row = div().flex().flex_wrap().gap(px(6.));
        for path in recordings {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let me = me.clone();
            row = row.child(ui.button(format!("ein-klick-{name}"), name.clone()).small().disabled(busy).accessible_name(format!("{name} mit 1 Klick verbessern")).on_click(move |_, app| {
                let path = path.clone();
                me.update(app, |shell, cx| shell.mic_one_click(path, cx))
            }));
        }
        {
            let me = me.clone();
            row = row.child(ui.button("ein-klick-datei", if busy { "Verbessert …" } else { "Andere Aufnahme …" }).small().ghost().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.mic_one_click_choose(cx))));
        }
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(ui.subheading("Aufnahme mit 1 Klick verbessern"))
            .child(ui.prose("Dieselbe Sprachverbesserung auf einer Aufnahme, die schon da ist — ohne Einmessen. Die verbesserte Fassung liegt danach neben dem Original und in der Sitzung."))
            .child(row)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_test_tone_is_a_second_and_fades() {
        let tone = super::test_tone(48_000);
        assert_eq!(tone.frames(), 48_000);
        assert!(tone.channels[0][0].abs() < 1e-6);
        assert!(tone.channels[0][47_999].abs() < 0.01);
        let peak = tone.channels[0].iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!((peak - 0.2).abs() < 0.01);
    }
}
