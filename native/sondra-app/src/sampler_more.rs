//! The rest of the website's Zerschneiden: how pads are written („Blende an den Schnittkanten“, „Auf −0,3 dBFS
//! normalisieren“, „Länge beim Transponieren halten“) and heard the same way first; pads and beats into the
//! session; „Ganze Datei als Pad 1“ and „Am Zeiger teilen“; four pattern places A–D with „In den nächsten Platz
//! kopieren“ and a song chain that plays and is written one after the other (`StepSequencer.tsx`).

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_media::audio::{write_wav_f32, AudioData};
use sondra_media::pattern::{bounce_pattern, export_pad, Material, PadExport, Pattern, Slice};
use sondra_ui::{radius, Ui};

use crate::clip_player::ClipPlayer;
use crate::shell::Shell;

pub const SLOTS: [&str; 4] = ["A", "B", "C", "D"];

/// The beat as it is heard and written: the song chain one place after the other when it is on (and longer than
/// one), else the pattern `loops` times.
pub fn bounce_output(pads: &[Slice], patterns: &[Pattern], chain: &[usize], song: bool, active: &Pattern, loops: usize, audio: &AudioData, choke: bool) -> AudioData {
    let material = Material { audio };
    if song && chain.len() > 1 {
        let parts: Vec<AudioData> = chain.iter().filter_map(|i| patterns.get(*i)).map(|p| bounce_pattern(pads, p, &material, 1, choke)).collect();
        if let Ok(joined) = sondra_media::edit::concat_audio(&parts, 0.005) {
            return joined;
        }
    }
    bounce_pattern(pads, active, &material, loops.max(1), choke)
}

impl Shell {
    /// The four places with the one being edited filled in.
    pub fn sampler_patterns(&self) -> Vec<Pattern> {
        let s = &self.sampler;
        let mut all = s.slots.clone();
        if let Some(place) = all.get_mut(s.slot) {
            *place = s.pattern.clone();
        }
        all
    }

    pub fn sampler_slot(&self) -> usize {
        self.sampler.slot
    }

    pub fn sampler_chain(&self) -> &[usize] {
        &self.sampler.chain
    }

    /// Another place of A–D: the pattern edited so far stays in its place.
    pub fn sampler_switch_slot(&mut self, to: usize, cx: &mut Context<Self>) {
        let s = &mut self.sampler;
        if to >= SLOTS.len() || to == s.slot {
            return;
        }
        let now = s.pattern.clone();
        s.slots[s.slot] = now;
        s.pattern = s.slots[to].clone();
        s.slot = to;
        s.roll = None;
        cx.notify();
    }

    /// „Aktuelles Pattern in den nächsten Platz kopieren“, and go there.
    pub fn sampler_copy_to_next_slot(&mut self, cx: &mut Context<Self>) {
        let next = (self.sampler.slot + 1) % SLOTS.len();
        let copy = self.sampler.pattern.clone();
        self.sampler.slots[next] = copy;
        let s = &mut self.sampler;
        s.slots[s.slot] = s.pattern.clone();
        s.slot = next;
        s.roll = None;
        cx.notify();
    }

    /// „+A“ … „+D“: a place at the end of the chain; the song is then what plays.
    pub fn sampler_chain_add(&mut self, slot: usize, cx: &mut Context<Self>) {
        if slot < SLOTS.len() {
            self.sampler.chain.push(slot);
            self.sampler.song = true;
            cx.notify();
        }
    }

    /// A block of the chain away (never the last one).
    pub fn sampler_chain_remove(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.sampler.chain.len() > 1 && index < self.sampler.chain.len() {
            self.sampler.chain.remove(index);
            cx.notify();
        }
    }

    pub fn sampler_set_song(&mut self, on: bool, cx: &mut Context<Self>) {
        self.sampler.song = on;
        cx.notify();
    }

    pub fn sampler_set_loops(&mut self, loops: usize, cx: &mut Context<Self>) {
        self.sampler.loops = loops.clamp(1, 8);
        cx.notify();
    }

    pub(crate) fn sampler_output_audio(&self) -> Option<impl FnOnce() -> AudioData + Send + 'static> {
        let s = &self.sampler;
        let audio = s.audio.clone()?;
        let (pads, patterns, chain, song, active, loops, choke) = (s.pads.clone(), self.sampler_patterns(), s.chain.clone(), s.song, s.pattern.clone(), s.loops, s.choke);
        Some(move || bounce_output(&pads, &patterns, &chain, song, &active, loops, &audio, choke))
    }

    fn sampler_beat_name(&self) -> String {
        let s = &self.sampler;
        let bpm = s.pattern.bpm.round();
        if s.song && s.chain.len() > 1 {
            format!("{}-song-{bpm}bpm", self.sampler_stem())
        } else {
            format!("{}-pattern-{}-{bpm}bpm", self.sampler_stem(), SLOTS[s.slot])
        }
    }

    /// The beat (or song) as a WAV into the session.
    pub fn sampler_beat_to_session(&mut self, cx: &mut Context<Self>) {
        let Some(render) = self.sampler_output_audio() else { return };
        let (dir, name) = (self.sampler_folder(), self.sampler_beat_name());
        self.sampler_write_to_session(cx, move || {
            let audio = render();
            let path = sondra_media::run::unique_path(&dir, &name, "wav");
            write_wav_f32(&path, &audio).map_err(|e| e.to_string())?;
            Ok(vec![path])
        });
    }

    /// Writes away from the window, and what was written goes into the session.
    fn sampler_write_to_session(&mut self, cx: &mut Context<Self>, work: impl FnOnce() -> Result<Vec<PathBuf>, String> + Send + 'static) {
        self.sampler.busy = Some("Rendert …");
        self.sampler.error = None;
        Self::in_background(cx, work, |shell, answer, cx| {
            shell.sampler.busy = None;
            match answer {
                Ok(paths) => {
                    shell.sampler.said = Some(if paths.len() == 1 { "In der Sitzung.".to_string() } else { format!("{} Dateien in der Sitzung.", paths.len()) });
                    shell.session_add(paths.clone(), cx);
                    shell.sampler.made = paths;
                }
                Err(e) => shell.sampler.error = Some(e),
            }
            cx.notify();
        });
        cx.notify();
    }

    pub fn sampler_set_export(&mut self, change: impl FnOnce(&mut PadExport), cx: &mut Context<Self>) {
        change(&mut self.sampler.export);
        cx.notify();
    }

    pub fn sampler_export_options(&self) -> PadExport {
        self.sampler.export
    }

    /// „So hören, wie es exportiert wird“: the chosen pad rendered as it would be written, then played.
    pub fn sampler_hear_export(&mut self, cx: &mut Context<Self>) {
        if self.sampler_stop() {
            cx.notify();
            return;
        }
        let (Some(audio), Some(pad)) = (self.sampler.audio.clone(), self.sampler.pads.get(self.sampler.selected).cloned()) else { return };
        let options = self.sampler.export;
        self.sampler.busy = Some("Rendert …");
        Self::in_background(
            cx,
            move || export_pad(&audio, &pad, options),
            |shell, heard, cx| {
                shell.sampler.busy = None;
                shell.sampler.player = Some(ClipPlayer::start(&heard, 0.0, heard.seconds()));
                shell.sampler.heard_export = Some(Arc::new(heard));
                shell.sampler_ticker(cx);
                cx.notify();
            },
        );
        cx.notify();
    }

    /// What „So hören“ rendered last (for tests).
    pub fn sampler_heard_export(&self) -> Option<Arc<AudioData>> {
        self.sampler.heard_export.clone()
    }

    /// The chosen pad (or every pad) written as on export and put into the session.
    pub fn sampler_pads_to_session(&mut self, only_selected: bool, cx: &mut Context<Self>) {
        let Some(audio) = self.sampler.audio.clone() else { return };
        let s = &self.sampler;
        let chosen: Vec<(usize, Slice)> = s.pads.iter().cloned().enumerate().filter(|(i, _)| !only_selected || *i == s.selected).collect();
        let (dir, options) = (self.sampler_folder().join(format!("{} (Pads)", self.sampler_stem())), s.export);
        self.sampler_write_to_session(cx, move || {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            chosen
                .iter()
                .map(|(i, pad)| {
                    let path = sondra_media::run::unique_path(&dir, &format!("Pad {:02}", i + 1), "wav");
                    write_wav_f32(&path, &export_pad(&audio, pad, options)).map_err(|e| e.to_string())?;
                    Ok(path)
                })
                .collect()
        });
    }

    /// „Ganze Datei als Pad 1“: one pad over everything; steps and notes of pads that are gone go with them.
    pub fn sampler_whole_file_pad(&mut self, cx: &mut Context<Self>) {
        let Some(total) = self.sampler.audio.as_ref().map(|a| a.seconds()) else { return };
        if total <= 0.02 {
            return;
        }
        let id = self.sampler_new_id();
        let s = &mut self.sampler;
        let settings = s.pads.get(s.selected).cloned();
        let pad = match settings {
            Some(from) => Slice { id: id.clone(), start: 0.0, end: total, ..from },
            None => Slice::new(&id, 0.0, total),
        };
        s.pads = vec![pad];
        s.selected = 0;
        s.roll = None;
        for pattern in std::iter::once(&mut s.pattern).chain(s.slots.iter_mut()) {
            pattern.cells.retain(|k, _| *k == id);
            pattern.notes.retain(|k, _| *k == id);
            pattern.muted.retain(|k, _| *k == id);
        }
        s.said = Some("Ganze Datei als Pad 1 angelegt.".into());
        cx.notify();
    }

    /// Where the pointer is: the last place pressed on the waveform; while a pad plays, where it plays.
    pub fn sampler_cursor(&self) -> Option<f64> {
        let s = &self.sampler;
        if let Some((index, voice)) = s.voices.last() {
            if let Some(pad) = s.pads.get(*index) {
                let at = pad.start + voice.position();
                if at > pad.start && at < pad.end {
                    return Some(at);
                }
            }
        }
        s.cursor
    }

    pub fn sampler_set_cursor(&mut self, at: f64, cx: &mut Context<Self>) {
        self.sampler.cursor = Some(at);
        cx.notify();
    }

    /// „Am Zeiger teilen“: a cut where the pointer is (the middle of the file without one), on the zero crossing
    /// when cuts snap; the new pad keeps the settings of the one it was cut from.
    pub fn sampler_split_at_cursor(&mut self, cx: &mut Context<Self>) {
        let Some(audio) = self.sampler.audio.clone() else { return };
        let total = audio.seconds();
        if total <= 0.04 {
            return;
        }
        let wanted = self.sampler_cursor().filter(|t| *t > 0.02 && *t < total - 0.02).unwrap_or(total / 2.0);
        let at = if self.sampler.settings.snap { sondra_media::tempo::snap_to_zero_crossing(&audio, wanted, 12.0) } else { wanted };
        if at <= 0.015 || at >= total - 0.015 {
            return;
        }
        let id = self.sampler_new_id();
        let s = &mut self.sampler;
        if let Some(i) = s.pads.iter().position(|p| at > p.start + 0.015 && at < p.end - 0.015) {
            let pad = s.pads[i].clone();
            s.pads[i].end = at;
            s.pads.insert(i + 1, Slice { id, start: at, ..pad });
            s.selected = i + 1;
        } else if s.pads.is_empty() {
            s.pads = vec![Slice::new(&id, 0.0, at), Slice::new(&format!("{id}b"), at, total)];
            s.selected = 1;
        } else {
            // In a gap: a pad from the cut before to here.
            let before = s.pads.iter().filter(|p| p.end <= at).map(|p| p.end).fold(0.0, f64::max);
            if at - before < 0.015 {
                return;
            }
            let i = s.pads.iter().position(|p| p.start >= at).unwrap_or(s.pads.len());
            s.pads.insert(i, Slice::new(&id, before, at));
            s.selected = i;
        }
        s.said = Some(format!("Schnitt bei {} s gesetzt.", format!("{at:.2}").replace('.', ",")));
        cx.notify();
    }

    /// The pad export settings and what renders a pad.
    pub(crate) fn sampler_export_block(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let s = &self.sampler;
        let busy = s.busy.is_some();
        let e = s.export;
        let mut fades = div().flex().flex_wrap().gap(px(6.));
        for ms in [0.0, 4.0, 10.0, 20.0, 40.0, 60.0] {
            let me = me.clone();
            fades = fades.child(ui.chip(format!("blende-{ms}"), format!("{ms} ms"), (e.edge_fade_ms - ms).abs() < 1e-9).accessible_name(format!("Blende an den Schnittkanten {ms} ms")).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_set_export(|o| o.edge_fade_ms = ms, cx))));
        }
        let mut toggles = div().flex().flex_wrap().gap(px(6.));
        {
            let me = me.clone();
            toggles = toggles.child(ui.chip("laenge-halten", "Länge beim Transponieren halten", e.keep_length).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_set_export(|o| o.keep_length = !o.keep_length, cx))));
        }
        {
            let me = me.clone();
            toggles = toggles.child(ui.chip("normalisieren", "Auf −0,3 dBFS normalisieren", e.normalize).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_set_export(|o| o.normalize = !o.normalize, cx))));
        }
        let mut buttons = div().flex().flex_wrap().gap(px(8.));
        {
            let me = me.clone();
            buttons = buttons.child(ui.button("so-hoeren", if s.player.is_some() && s.heard_export.is_some() { "Anhalten" } else { "So hören, wie es exportiert wird" }).small().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_hear_export(cx))));
        }
        {
            let me = me.clone();
            buttons = buttons.child(ui.button("pad-in-sitzung", format!("Pad {} in die Sitzung", s.selected + 1)).small().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_pads_to_session(true, cx))));
        }
        {
            let me = me.clone();
            buttons = buttons.child(ui.button("pads-in-sitzung", format!("Alle {} Pads in die Sitzung", s.pads.len())).small().ghost().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_pads_to_session(false, cx))));
        }
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .p(px(16.))
            .rounded(px(radius::CARD))
            .bg(c.panel_soft)
            .child(ui.subheading("So werden Pads geschrieben"))
            .child(div().flex().flex_col().gap(px(6.)).child(ui.hint("Blende an den Schnittkanten")).child(fades))
            .child(toggles)
            .child(ui.hint("Gilt für „Pads als WAV-Dateien“ und „In die Sitzung“; die Blende verhindert Knackser an den Schnitten, der Phasenvocoder hält die Länge eines transponierten Pads."))
            .child(buttons)
            .into_any_element()
    }

    /// The places A–D, the chain and how often the pattern plays when written.
    pub(crate) fn sampler_arrangement(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let s = &self.sampler;
        let mut places = div().flex().flex_wrap().items_center().gap(px(6.));
        for (i, name) in SLOTS.iter().enumerate() {
            let me = me.clone();
            places = places.child(ui.chip(format!("platz-{name}"), format!("Pattern {name}"), s.slot == i).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_switch_slot(i, cx))));
        }
        {
            let me = me.clone();
            let next = SLOTS[(s.slot + 1) % SLOTS.len()];
            places = places.child(ui.button("in-naechsten-platz", format!("In Pattern {next} kopieren")).small().ghost().accessible_name("Aktuelles Pattern in den nächsten Platz kopieren").on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_copy_to_next_slot(cx))));
        }
        let mut mode = div().flex().flex_wrap().items_center().gap(px(6.));
        {
            let me = me.clone();
            mode = mode.child(ui.chip("einzelnes-pattern", format!("Einzelnes Pattern ({})", SLOTS[s.slot]), !s.song).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_set_song(false, cx))));
        }
        {
            let me = me.clone();
            let n = s.chain.len();
            mode = mode.child(ui.chip("song-kette", format!("Song-Kette ({n} {})", if n == 1 { "Takt" } else { "Takte" }), s.song).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_set_song(true, cx))));
        }
        let mut chain = div().flex().flex_wrap().items_center().gap(px(4.));
        for (index, slot) in s.chain.iter().enumerate() {
            let me = me.clone();
            let removable = s.chain.len() > 1;
            chain = chain.child(
                ui.button(format!("kette-{index}"), if removable { format!("{} ×", SLOTS[*slot]) } else { SLOTS[*slot].to_string() })
                    .small()
                    .ghost()
                    .accessible_name(format!("Block {}: Pattern {}{}", index + 1, SLOTS[*slot], if removable { " entfernen" } else { "" }))
                    .on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_chain_remove(index, cx))),
            );
        }
        chain = chain.child(ui.hint("Anhängen:"));
        for (i, name) in SLOTS.iter().enumerate() {
            let me = me.clone();
            chain = chain.child(ui.button(format!("kette-plus-{name}"), format!("+{name}")).small().accessible_name(format!("Pattern {name} an die Song-Kette anhängen")).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_chain_add(i, cx))));
        }
        let mut output = div().flex().flex_wrap().items_center().gap(px(6.));
        if s.song && s.chain.len() > 1 {
            output = output.child(ui.value(format!("Kette: {}", s.chain.iter().map(|i| SLOTS[*i]).collect::<Vec<_>>().join(" → "))));
        } else {
            output = output.child(ui.hint("Ausgabe"));
            for loops in [1usize, 2, 3, 4, 8] {
                let me = me.clone();
                output = output.child(ui.chip(format!("durchgaenge-{loops}"), format!("{loops}×"), s.loops == loops).accessible_name(format!("{loops}× durchspielen")).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_set_loops(loops, cx))));
            }
        }
        {
            let me = me.clone();
            output = output.child(ui.button("beat-in-sitzung", "In die Sitzung").small().disabled(s.busy.is_some()).accessible_name(if s.song && s.chain.len() > 1 { "Song in die Sitzung" } else { "Pattern in die Sitzung" }).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_beat_to_session(cx))));
        }
        div().flex().flex_col().gap(px(8.)).child(ui.title("Arrangement")).child(places).child(mode).child(chain).child(output).into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_song_is_its_places_one_after_the_other() {
        let rate = 8000;
        let audio = AudioData { channels: vec![vec![0.3; rate as usize]], sample_rate: rate };
        let pads = vec![Slice::new("p1", 0.0, 0.1)];
        let mut a = Pattern::new(16, 120.0);
        a.cells.insert("p1".into(), (0..16).map(|i| i % 4 == 0).collect());
        let b = Pattern::new(16, 120.0);
        let one = bounce_output(&pads, &[a.clone(), b.clone()], &[0], true, &a, 1, &audio, true);
        let song = bounce_output(&pads, &[a.clone(), b.clone()], &[0, 1, 0], true, &a, 1, &audio, true);
        assert!((song.seconds() - 3.0 * one.seconds()).abs() < 0.05, "{} against {}", song.seconds(), one.seconds());
        let twice = bounce_output(&pads, &[a.clone(), b], &[0, 1], false, &a, 2, &audio, true);
        assert!((twice.seconds() - 2.0 * one.seconds()).abs() < 0.05);
    }
}
