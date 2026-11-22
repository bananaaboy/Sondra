//! „Vorspann am Ton“ in the player (the website's `introDetect`/`intro.worker`): two episodes of a series on the
//! Merkliste are compared — the first eight minutes as 8 kHz mono, a fingerprint, the longest stretch both share —
//! and that is the opening, kept on the series (up to four, `intros`, they travel with the list). In every episode
//! of the series it is then looked for in the background and kept per file (`sondra:abspielen:vorspann`); while it
//! plays, „Vorspann überspringen“ jumps to its end, after a cold open too. Not found: the fixed length as before.
//! „Für diese Folge ausblenden“ hides the button for the file that plays.

use std::path::{Path, PathBuf};

use gpui::Context;
use serde_json::{json, Map, Value};
use sondra_merk::folder_memory::Store;

use crate::shell::Shell;

const FOUND_KEY: &str = "sondra:abspielen:vorspann";
/// How much of an episode is listened to: an opening comes in its first minutes.
const LISTEN_SECONDS: u32 = 480;
const RATE: u32 = 8000;
/// At most this many openings per series (a new season often brings a new one).
const KEPT: usize = 4;

/// Where the opening of the file that plays is.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IntroHere {
    /// Not looked for (the series has none learned, or the file is no episode).
    Unknown,
    Finding,
    Found { start: f64, end: f64 },
    /// Looked for and not there: the fixed length counts.
    NotFound,
}

/// The first minutes of a file as 8 kHz mono, 16 bit.
fn listen(path: &Path) -> Result<Vec<i16>, String> {
    let ff = sondra_media::Ffmpeg::locate().ok_or("FFmpeg ist nicht da.")?;
    let out = std::process::Command::new(ff.program())
        .args(["-v", "error", "-nostdin", "-t", &LISTEN_SECONDS.to_string(), "-i"])
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", &RATE.to_string(), "-f", "s16le", "-"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() || out.stdout.len() < 2 * RATE as usize {
        return Err("Den Ton dieser Datei konnte Sondra nicht lesen.".into());
    }
    Ok(out.stdout.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
}

/// The key of a file in the memory: its name and size, as the website keeps it.
fn file_key(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    format!("{name}|{size}")
}

/// What the memory says of this file: `Some(Found/NotFound)` when it was looked for.
pub fn remembered(text: Option<&str>, key: &str) -> Option<IntroHere> {
    let map: Map<String, Value> = serde_json::from_str(text?).ok()?;
    let entry = map.get(key)?;
    match (entry["start"].as_f64(), entry["end"].as_f64()) {
        (Some(start), Some(end)) if end > start => Some(IntroHere::Found { start, end }),
        _ if entry.is_null() || entry["none"].as_bool() == Some(true) => Some(IntroHere::NotFound),
        _ => None,
    }
}

/// The memory with this file's answer in it (at most 400 files are kept, the oldest go).
pub fn remember(text: Option<&str>, key: &str, here: IntroHere) -> String {
    let mut map: Map<String, Value> = text.and_then(|t| serde_json::from_str(t).ok()).unwrap_or_default();
    map.remove(key);
    let value = match here {
        IntroHere::Found { start, end } => json!({ "start": start, "end": end }),
        _ => json!({ "none": true }),
    };
    map.insert(key.to_owned(), value);
    while map.len() > 400 {
        let first = map.keys().next().cloned();
        if let Some(first) = first {
            map.remove(&first);
        }
    }
    Value::Object(map).to_string()
}

impl Shell {
    /// The series on the list the file that plays belongs to: its id and title.
    pub(crate) fn intro_series(&self) -> Option<(String, String)> {
        let path = self.player.current_path()?;
        let name = path.file_name()?.to_string_lossy().into_owned();
        let found = sondra_merk::matching::match_episode(&name, &self.merk.items)?;
        let item = self.merk.items.iter().find(|i| i.id == found.item)?;
        Some((item.id.clone(), item.title.clone()))
    }

    /// Another episode of the same series in the list, to compare with.
    pub(crate) fn intro_partner(&self) -> Option<PathBuf> {
        let (id, _) = self.intro_series()?;
        let current = self.player.current_path()?.clone();
        self.player.queue.iter().find(|p| **p != current && p.file_name().and_then(|n| sondra_merk::matching::match_episode(&n.to_string_lossy(), &self.merk.items)).is_some_and(|m| m.item == id)).cloned()
    }

    /// For tests: where the opening of what plays is.
    pub fn player_intro_here(&self) -> IntroHere {
        self.player.intro_here
    }

    pub(crate) fn intro_learned(&self) -> usize {
        self.intro_series().and_then(|(id, _)| self.merk.items.iter().find(|i| i.id == id).and_then(|i| i.intros.as_ref().map(Vec::len))).unwrap_or(0)
    }

    /// Called as the window is drawn: a new episode of a series with learned openings is looked at once.
    pub(crate) fn player_intro_tick(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.player.current_path().cloned() else { return };
        if self.player.intro_file.as_ref() == Some(&path) {
            return;
        }
        self.player.intro_file = Some(path.clone());
        self.player.intro_here = IntroHere::Unknown;
        self.player.intro_step = None;
        let Some((id, _)) = self.intro_series() else { return };
        let prints: Vec<String> = self.merk.items.iter().find(|i| i.id == id).and_then(|i| i.intros.clone()).unwrap_or_default().into_iter().map(|i| i.print).collect();
        if prints.is_empty() {
            return;
        }
        let key = file_key(&path);
        if let Some(known) = remembered(self.player.memory.as_ref().and_then(|m| m.get_item(FOUND_KEY)).as_deref(), &key) {
            self.player.intro_here = known;
            return;
        }
        self.player.intro_here = IntroHere::Finding;
        Self::in_background(
            cx,
            move || listen(&path).map(|pcm| sondra_media::intro::find_intro(&prints, &pcm)),
            move |shell, answer, cx| {
                // Another file may play by now: only this one's answer is kept for it.
                let here = match answer {
                    Ok(Some(found)) => IntroHere::Found { start: found.start, end: found.end },
                    _ => IntroHere::NotFound,
                };
                if let Some(store) = shell.player.memory.as_mut() {
                    let next = remember(store.get_item(FOUND_KEY).as_deref(), &key, here);
                    store.set_item(FOUND_KEY, next);
                }
                if shell.player.current_path().is_some_and(|p| file_key(p) == key) {
                    shell.player.intro_here = here;
                }
                cx.notify();
            },
        );
    }

    /// „Vorspann erkennen“: this episode and another of the series in the list are compared; what they share is kept
    /// on the series, and looked for again in this one.
    pub fn player_learn_intro(&mut self, cx: &mut Context<Self>) {
        let (Some((id, title)), Some(partner), Some(path)) = (self.intro_series(), self.intro_partner(), self.player.current_path().cloned()) else { return };
        if self.player.intro_step.is_some() {
            return;
        }
        self.player.intro_step = Some(format!("Hört „{title}“ in zwei Folgen ab …"));
        cx.notify();
        Self::in_background(
            cx,
            move || -> Result<Option<sondra_media::intro::LearnedIntro>, String> { Ok(sondra_media::intro::learn_intro(&listen(&path)?, &listen(&partner)?)) },
            move |shell, answer, cx| {
                shell.player.intro_step = None;
                match answer {
                    Ok(Some(learned)) => {
                        let now = chrono::Utc::now().timestamp_millis();
                        shell.merk.change(&id, |item| {
                            let mut list = item.intros.take().unwrap_or_default();
                            list.insert(0, sondra_merk::Intro { print: learned.print.clone(), seconds: learned.seconds, learned_at: now });
                            list.truncate(KEPT);
                            item.intros = Some(list);
                        });
                        // Every file is looked at again with the new opening.
                        if let Some(store) = shell.player.memory.as_mut() {
                            store.set_item(FOUND_KEY, "{}".to_string());
                        }
                        shell.player.intro_file = None;
                        shell.player.intro_note = Some(format!("Vorspann erkannt: {} lang.", sondra_player::clock(learned.seconds)));
                        crate::protocol::note("abspielen", format!("Vorspann von „{title}“ erkannt ({})", sondra_player::clock(learned.seconds)));
                    }
                    Ok(None) => shell.player.intro_note = Some("Die beiden Folgen teilen keinen Vorspann, den Sondra hören kann.".into()),
                    Err(e) => shell.player.intro_note = Some(e),
                }
                cx.notify();
            },
        );
    }

    /// „Erkannten Vorspann vergessen“: the series has no learned opening any more; the fixed length counts again.
    pub fn player_forget_intros(&mut self, cx: &mut Context<Self>) {
        let Some((id, _)) = self.intro_series() else { return };
        self.merk.change(&id, |item| item.intros = None);
        if let Some(store) = self.player.memory.as_mut() {
            store.set_item(FOUND_KEY, "{}".to_string());
        }
        self.player.intro_here = IntroHere::Unknown;
        self.player.intro_note = None;
        cx.notify();
    }

    /// The words of the opening's state, for the window.
    pub(crate) fn intro_status(&self) -> String {
        let Some((_, title)) = self.intro_series() else {
            return "Geht für Serien auf der Merkliste: Sondra vergleicht zwei Folgen und findet den Vorspann danach in jeder weiteren, auch nach einem Cold Open.".into();
        };
        if let Some(step) = &self.player.intro_step {
            return step.clone();
        }
        match self.player.intro_here {
            IntroHere::Found { start, end } => format!("„{title}“: in dieser Folge von {} bis {}.", sondra_player::clock(start), sondra_player::clock(end)),
            IntroHere::Finding => "Sucht den Vorspann in dieser Folge …".into(),
            IntroHere::NotFound => "In dieser Folge nicht gefunden — es gilt die feste Länge.".into(),
            IntroHere::Unknown => format!("„{title}“: noch nicht erkannt. Sondra vergleicht dafür zwei Folgen und findet den Vorspann danach in jeder weiteren."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_was_found_is_kept_per_file_and_read_back() {
        let one = remember(None, "Folge 1.mkv|100", IntroHere::Found { start: 12.5, end: 101.0 });
        let both = remember(Some(&one), "Folge 2.mkv|200", IntroHere::NotFound);
        assert_eq!(remembered(Some(&both), "Folge 1.mkv|100"), Some(IntroHere::Found { start: 12.5, end: 101.0 }));
        assert_eq!(remembered(Some(&both), "Folge 2.mkv|200"), Some(IntroHere::NotFound));
        assert_eq!(remembered(Some(&both), "Folge 3.mkv|300"), None);
    }
}
