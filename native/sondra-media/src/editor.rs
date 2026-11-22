//! A take being edited: the audio, what is selected, a history to go back through, a clipboard, and the
//! edits themselves (`edit.rs`, `effects.rs`). Every edit makes a new state and keeps the old one for
//! undo; nothing here touches the file the sound came from. What a page shows as „Verlauf“ is
//! [`Editor::history`].

use crate::audio::AudioData;
use crate::edit::{self, Trick};
use crate::effects::{self, CompressOptions, Fade};

/// How many states are kept: a long take is large, and the oldest goes first.
const KEPT: usize = 24;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op {
    /// Level in dB over the selection (or all).
    Gain(f64),
    /// The loudest sample to this value in dBFS.
    NormalizePeak(f64),
    FadeIn,
    FadeOut,
    Mute,
    Highpass(f64),
    Lowpass(f64),
    Tone { bass_db: f64, treble_db: f64 },
    Compress { threshold_db: f64, ratio: f64 },
    /// Takes the noise out, as far as `max_cut_db`, by the profile learned from a quiet part.
    RemoveNoise { max_cut_db: f64 },
    Echo { delay_ms: f64, feedback: f64, mix: f64 },
    Reverb { seconds: f64, mix: f64 },
    /// Removes the selection.
    Cut,
    /// The selection, once more right after itself.
    Duplicate,
    /// A pause of this many seconds at the start of the selection (or the beginning).
    InsertSilence(f64),
    Paste,
    RemoveSilence { threshold_db: f64 },
    RemoveDc,
    ToMono,
    ToStereo,
    Swap,
    Resample(u32),
    /// Moves the pitch by this many semitones and keeps the length (a phase vocoder).
    Pitch(f64),
    /// Plays this much faster (2 = twice as fast, half as long) and keeps the pitch.
    Tempo(f64),
    /// The whole file backwards.
    Reverse,
    /// Clicks and crackle out, over the whole file (`declick.ts`).
    RemoveClicks(crate::declick::ClickStrength),
    /// Only the selection stays („Ausschnitt behalten“).
    Keep,
    /// „Ein-Klick-Sprachverbesserung“: rumble, fan noise, clicks and room tail out, speech clearer (`speech_enhance`).
    EnhanceSpeech,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryEntry {
    pub label: String,
}

pub struct Editor {
    audio: AudioData,
    /// Before each edit, the state it was made from, with the edit's name.
    undo: Vec<(String, AudioData)>,
    redo: Vec<(String, AudioData)>,
    clipboard: Option<AudioData>,
    noise: Option<Vec<f32>>,
    /// The take as it was opened, for „Zurück zum Original“ however long the history is.
    original: AudioData,
}

fn seconds(s: f64) -> String {
    format!("{s:.2}").replace('.', ",")
}

fn db(v: f64) -> String {
    format!("{v:.1}").replace('.', ",").replacen('-', "−", 1)
}

impl Editor {
    pub fn new(audio: AudioData) -> Editor {
        Editor { original: audio.clone(), audio, undo: Vec::new(), redo: Vec::new(), clipboard: None, noise: None }
    }

    pub fn audio(&self) -> &AudioData {
        &self.audio
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn has_clipboard(&self) -> bool {
        self.clipboard.is_some()
    }

    pub fn has_noise_profile(&self) -> bool {
        self.noise.is_some()
    }

    /// What was done, oldest first.
    pub fn history(&self) -> Vec<HistoryEntry> {
        self.undo.iter().map(|(label, _)| HistoryEntry { label: label.clone() }).collect()
    }

    fn commit(&mut self, label: String, next: AudioData) {
        let before = std::mem::replace(&mut self.audio, next);
        self.undo.push((label, before));
        if self.undo.len() > KEPT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    /// Steps back; says what was undone.
    pub fn undo(&mut self) -> Option<String> {
        let (label, before) = self.undo.pop()?;
        let after = std::mem::replace(&mut self.audio, before);
        self.redo.push((label.clone(), after));
        Some(label)
    }

    pub fn redo(&mut self) -> Option<String> {
        let (label, after) = self.redo.pop()?;
        let before = std::mem::replace(&mut self.audio, after);
        self.undo.push((label.clone(), before));
        Some(label)
    }

    /// Copies the selection to the clipboard.
    pub fn copy(&mut self, range: Option<(f64, f64)>) -> Result<String, String> {
        let (from, to) = range.ok_or("Wählen Sie zuerst eine Stelle in der Welle.")?;
        self.clipboard = Some(effects::copy_range(&self.audio, from, to));
        Ok(format!("{} s kopiert", seconds(to - from)))
    }

    /// Learns what the quiet part sounds like, from the selection.
    pub fn learn_noise(&mut self, range: Option<(f64, f64)>) -> Result<String, String> {
        let (from, to) = range.ok_or("Wählen Sie eine Stelle, an der nur das Rauschen zu hören ist.")?;
        if to - from < 0.2 {
            return Err("Die Stelle ist zu kurz: mindestens eine Fünftelsekunde ohne Sprechen.".into());
        }
        let part = effects::copy_range(&self.audio, from, to);
        self.noise = Some(effects::learn_noise(&part));
        Ok(format!("Rauschprofil aus {} s gelernt", seconds(to - from)))
    }

    /// Learns the noise from the stretch of the take that is quietest and flattest, found by itself
    /// (`noise_floor`, the website's „Lokale KI“); says where it lay. A stretch shorter than the least a profile
    /// needs is taken longer, to the end of the take at most.
    pub fn learn_noise_auto(&mut self) -> Result<(String, (f64, f64)), String> {
        let total = edit::duration_of(&self.audio);
        let (from, mut to) = crate::noise_floor::detect_noise_floor_region(&self.audio);
        if to - from < 0.2 {
            to = (from + 0.2).min(total);
        }
        self.learn_noise(Some((from, to)))?;
        Ok((format!("Rauschprofil von selbst gefunden und gelernt: {} bis {} s", seconds(from), seconds(to)), (from, to)))
    }

    /// Does one edit. `range` is the selection in seconds, or none for the whole take. Says in a short
    /// phrase what was done (it is what the history shows).
    pub fn apply(&mut self, op: Op, range: Option<(f64, f64)>) -> Result<String, String> {
        let total = edit::duration_of(&self.audio);
        let (from, to) = range.filter(|(a, b)| b - a > 0.0).unwrap_or((0.0, total));
        let whole = range.is_none();
        let place = if whole { "ganze Datei".to_string() } else { format!("{} bis {} s", seconds(from), seconds(to)) };
        let (label, next) = match op {
            Op::Gain(g) => (format!("Pegel {} dB · {place}", db(g)), edit::apply_gain(&self.audio, g, from, to)),
            Op::NormalizePeak(target) => (format!("Auf {} dBFS normalisiert", db(target)), edit::normalize_peak(&self.audio, target)),
            Op::FadeIn => (format!("Eingeblendet · {place}"), effects::fade_range(&self.audio, from, to, Fade::In)),
            Op::FadeOut => (format!("Ausgeblendet · {place}"), effects::fade_range(&self.audio, from, to, Fade::Out)),
            Op::Mute => (format!("Stumm · {place}"), effects::mute_range(&self.audio, from, to)),
            Op::Highpass(hz) => (format!("Tiefen unter {hz:.0} Hz entfernt · {place}"), effects::process_range(&self.audio, from, to, |p| effects::highpass_filter(&p, hz))),
            Op::Lowpass(hz) => (format!("Höhen über {hz:.0} Hz entfernt · {place}"), effects::process_range(&self.audio, from, to, |p| effects::lowpass_filter(&p, hz))),
            Op::Tone { bass_db, treble_db } => (format!("Bässe {} dB, Höhen {} dB · {place}", db(bass_db), db(treble_db)), effects::process_range(&self.audio, from, to, |p| effects::shelf_eq(&p, bass_db, treble_db))),
            Op::Compress { threshold_db, ratio } => {
                let mut cut = 0.0;
                let next = effects::process_range(&self.audio, from, to, |p| {
                    let c = effects::compress_audio(&p, threshold_db, ratio, CompressOptions::default());
                    cut = c.max_reduction_db;
                    c.audio
                });
                (format!("Kompressor {ratio:.0}:1 ab {} dB, bis zu {} dB zurückgenommen · {place}", db(threshold_db), db(cut)), next)
            }
            Op::RemoveNoise { max_cut_db } => {
                let profile = self.noise.clone().ok_or("Das Rauschprofil fehlt: erst eine ruhige Stelle wählen und „Rauschen lernen“ drücken.")?;
                (format!("Rauschen um bis zu {} dB gesenkt · {place}", db(max_cut_db)), effects::process_range(&self.audio, from, to, |p| effects::remove_noise(&p, &profile, max_cut_db)))
            }
            Op::Echo { delay_ms, feedback, mix } => (format!("Echo {delay_ms:.0} ms · {place}"), effects::process_range(&self.audio, from, to, |p| effects::echo(&p, delay_ms, feedback, mix, true))),
            Op::Pitch(semitones) => {
                if semitones.abs() < 1e-6 {
                    return Err("Eine Verschiebung um null Halbtöne ändert nichts.".into());
                }
                let sign = if semitones > 0.0 { "+" } else { "−" };
                (format!("Tonhöhe {sign}{} Halbtöne · {place}", format!("{}", semitones.abs()).replace('.', ",")), effects::process_range(&self.audio, from, to, |p| crate::timestretch::pitch_shift(&p, semitones, true, 2048)))
            }
            Op::Tempo(tempo) => {
                if (tempo - 1.0).abs() < 1e-6 || tempo <= 0.0 {
                    return Err("Das Tempo bleibt, wie es ist.".into());
                }
                let label = format!("Tempo {}× · {place}", format!("{tempo:.2}").replace('.', ","));
                if whole {
                    (label, crate::timestretch::stretch_audio(&self.audio, 1.0 / tempo, 2048))
                } else {
                    // The stretch changes the length, so the stretched part takes the place of the part.
                    let part = crate::timestretch::stretch_audio(&effects::copy_range(&self.audio, from, to), 1.0 / tempo, 2048);
                    (label, effects::insert_at(&edit::cut_range(&self.audio, from, to), from, &part))
                }
            }
            Op::Reverse => ("Umgekehrt".to_string(), AudioData { channels: self.audio.channels.iter().map(|c| c.iter().rev().copied().collect()).collect(), sample_rate: self.audio.sample_rate }),
            Op::RemoveClicks(strength) => {
                let (fixed, repaired) = crate::declick::remove_clicks(&self.audio, strength);
                if repaired == 0 {
                    return Err("Nichts gefunden, was wie ein Klick aussieht.".into());
                }
                let how = match strength {
                    crate::declick::ClickStrength::Soft => "sanft",
                    crate::declick::ClickStrength::Medium => "mittel",
                    crate::declick::ClickStrength::Strong => "stark",
                };
                (format!("Klicks entfernt ({how}) · {repaired} {}", if repaired == 1 { "Stelle ausgebessert" } else { "Stellen ausgebessert" }), fixed)
            }
            Op::Reverb { seconds: s, mix } => (format!("Hall {} s · {place}", seconds(s)), effects::process_range(&self.audio, from, to, |p| effects::reverb(&p, s, mix, true))),
            Op::Cut => {
                if whole {
                    return Err("Wählen Sie zuerst die Stelle, die weg soll.".into());
                }
                self.clipboard = Some(effects::copy_range(&self.audio, from, to));
                (format!("{} s herausgeschnitten ({} bis {} s)", seconds(to - from), seconds(from), seconds(to)), edit::cut_range(&self.audio, from, to))
            }
            Op::Duplicate => {
                if whole {
                    return Err("Wählen Sie zuerst die Stelle, die doppelt klingen soll.".into());
                }
                (format!("Verdoppelt · {place}"), effects::duplicate_range(&self.audio, from, to))
            }
            Op::InsertSilence(length) => {
                let at = if whole { 0.0 } else { from };
                (format!("{} s Stille bei {} s eingefügt", seconds(length), seconds(at)), effects::insert_silence(&self.audio, at, length))
            }
            Op::Paste => {
                let clip = self.clipboard.clone().ok_or("Die Zwischenablage ist leer: erst kopieren oder ausschneiden.")?;
                let at = if whole { total } else { from };
                (format!("Eingefügt bei {} s", seconds(at)), effects::insert_at(&self.audio, at, &clip))
            }
            Op::RemoveSilence { threshold_db } => {
                let next = edit::remove_silence(&self.audio, threshold_db, 0.35, 0.05);
                if next.frames() == self.audio.frames() {
                    return Err("Keine Stille gefunden, die länger als eine Drittelsekunde dauert.".into());
                }
                (format!("{} s Stille entfernt", seconds(total - edit::duration_of(&next))), next)
            }
            Op::RemoveDc => ("Gleichspannung entfernt".into(), edit::remove_dc_offset(&self.audio)),
            Op::ToMono => ("Zu Mono gemischt".into(), effects::set_channels(&self.audio, 1)),
            Op::ToStereo => ("Zu Stereo verdoppelt".into(), effects::set_channels(&self.audio, 2)),
            Op::Swap => ("Links und rechts getauscht".into(), edit::channel_trick(&self.audio, Trick::Swap)),
            Op::Resample(rate) => (format!("Abtastrate {rate} Hz"), edit::resample_audio(&self.audio, rate)),
            Op::EnhanceSpeech => (
                format!("Sprache verbessert (Rauschen und Hall entfernt) · {place}"),
                effects::process_range(&self.audio, from, to, |p| crate::speech_enhance::enhance_speech(&p, crate::speech_enhance::SpeechEnhance::default())),
            ),
            Op::Keep => {
                if whole {
                    return Err("Wählen Sie zuerst den Ausschnitt, der bleiben soll.".into());
                }
                (format!("Ausschnitt behalten ({} bis {} s)", seconds(from), seconds(to)), effects::copy_range(&self.audio, from, to))
            }
        };
        self.commit(label.clone(), next);
        Ok(label)
    }

    /// „Datei zum Anhängen“: another take after this one, brought to its rate and channels, with a short
    /// crossfade (30 ms) where they meet.
    pub fn append(&mut self, other: &AudioData, name: &str) -> Result<String, String> {
        if other.frames() == 0 {
            return Err("In dieser Datei ist kein Ton.".into());
        }
        let rate = self.audio.sample_rate;
        let mut other = if other.sample_rate == rate { other.clone() } else { edit::resample_audio(other, rate) };
        let channels = self.audio.channels.len().max(1);
        if other.channels.len() != channels {
            other = effects::set_channels(&other, channels);
        }
        let fade = ((rate as f64 * 0.03) as usize).min(self.audio.frames()).min(other.frames());
        let mut next = self.audio.clone();
        for (c, channel) in next.channels.iter_mut().enumerate() {
            let incoming = &other.channels[c.min(other.channels.len() - 1)];
            let start = channel.len() - fade;
            for i in 0..fade {
                let t = (i as f32 + 0.5) / fade.max(1) as f32;
                channel[start + i] = channel[start + i] * (1.0 - t) + incoming[i] * t;
            }
            channel.extend_from_slice(&incoming[fade..]);
        }
        let label = format!("„{name}“ angehängt ({} s)", seconds(edit::duration_of(&other)));
        self.commit(label.clone(), next);
        Ok(label)
    }

    /// „Zurück zum Original“: the take as it was opened; the way back is an undo.
    pub fn reset(&mut self) -> Option<String> {
        if self.audio == self.original {
            return None;
        }
        let original = self.original.clone();
        self.commit("Zurück zum Original".into(), original);
        Some("Zurück zum Original".into())
    }

    /// The waveform of a stretch (`from` to `to` seconds) in `columns` columns — for a zoomed view.
    pub fn peaks_in(&self, from: f64, to: f64, columns: usize) -> Vec<(f32, f32)> {
        let rate = self.audio.sample_rate as f64;
        let n = self.audio.frames();
        let (a, b) = (((from.max(0.0) * rate) as usize).min(n), ((to * rate).ceil() as usize).min(n));
        if b <= a || columns == 0 {
            return vec![(0.0, 0.0); columns];
        }
        let span = b - a;
        (0..columns)
            .map(|c| {
                let (x, y) = (a + c * span / columns, (a + (c + 1) * span / columns).max(a + c * span / columns + 1).min(b));
                let (mut lo, mut hi) = (0f32, 0f32);
                for channel in &self.audio.channels {
                    for v in &channel[x..y] {
                        lo = lo.min(*v);
                        hi = hi.max(*v);
                    }
                }
                (lo, hi)
            })
            .collect()
    }

    /// The waveform in `columns` columns: the lowest and the highest value in each, over all channels.
    pub fn peaks(&self, columns: usize) -> Vec<(f32, f32)> {
        let n = self.audio.frames();
        if n == 0 || columns == 0 {
            return vec![(0.0, 0.0); columns];
        }
        (0..columns)
            .map(|c| {
                let (a, b) = (c * n / columns, ((c + 1) * n / columns).max(c * n / columns + 1).min(n));
                let (mut lo, mut hi) = (0f32, 0f32);
                for channel in &self.audio.channels {
                    for v in &channel[a..b] {
                        lo = lo.min(*v);
                        hi = hi.max(*v);
                    }
                }
                (lo, hi)
            })
            .collect()
    }
}

#[cfg(test)]
mod more_tests {
    use super::*;

    fn tone(seconds: f64, rate: u32, channels: usize) -> AudioData {
        let n = (seconds * rate as f64) as usize;
        AudioData { channels: (0..channels).map(|_| (0..n).map(|i| ((i as f32) * 0.05).sin() * 0.5).collect()).collect(), sample_rate: rate }
    }

    #[test]
    fn keep_append_and_reset_do_what_the_website_does() {
        let mut e = Editor::new(tone(2.0, 8000, 2));
        assert!(e.apply(Op::Keep, None).is_err(), "keeping needs a selection");
        e.apply(Op::Keep, Some((0.5, 1.0))).unwrap();
        assert_eq!(e.audio().frames(), 4000);
        // Another take, at another rate and in mono, comes after it in this one's shape.
        e.append(&tone(1.0, 16000, 1), "zwei.wav").unwrap();
        assert_eq!(e.audio().channels.len(), 2);
        let expected = 4000 + 8000 - (8000.0 * 0.03) as usize;
        assert!((e.audio().frames() as i64 - expected as i64).abs() <= 2, "{}", e.audio().frames());
        assert_eq!(e.reset().as_deref(), Some("Zurück zum Original"));
        assert_eq!(e.audio().frames(), 16000);
        assert!(e.reset().is_none(), "nothing to go back to");
        assert!(e.undo().is_some(), "the way back from the original is an undo");
        // A zoomed view has its columns over the stretch alone.
        assert_eq!(e.peaks_in(0.0, 0.5, 10).len(), 10);
    }
}
