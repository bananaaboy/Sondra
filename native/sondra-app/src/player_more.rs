//! The rest of the website's player: a subtitle file chosen by hand; the time shown as elapsed or remaining (a click
//! on it); the list edited — „Als Nächstes“, „Aus der Liste nehmen“; the picture that is shown as the cover of its
//! series on the Merkliste („Als Cover festlegen“); and the file opened in the sound or video editor.

use std::path::PathBuf;

use gpui::{Context, PathPromptOptions};

use crate::nav::Panel;
use crate::player_page::{PlayerState, Subtitle};
use crate::shell::Shell;

impl PlayerState {
    /// A subtitle file (.srt/.vtt) chosen by hand becomes the subtitle of what plays.
    pub fn take_subtitle_file(&mut self, path: &std::path::Path) -> Result<(), String> {
        let bytes = std::fs::read(path).map_err(|e| format!("Die Datei liess sich nicht lesen: {e}"))?;
        let cues = sondra_player::cues::parse_cues(&String::from_utf8_lossy(&bytes));
        if cues.is_empty() {
            return Err("In dieser Datei steht kein Untertitel, den Sondra lesen kann (.srt oder .vtt).".into());
        }
        self.external_cues = cues;
        self.subtitle_name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        self.choose_subtitle(Subtitle::File);
        Ok(())
    }

    /// „Als Nächstes“: the file at `n` plays right after the one that plays now.
    pub fn queue_next(&mut self, n: usize) {
        play_next(&mut self.queue, &mut self.index, n);
    }

    /// „Aus der Liste nehmen“: never the one that plays.
    pub fn queue_remove(&mut self, n: usize) {
        take_out(&mut self.queue, &mut self.index, n);
    }

    pub fn queue(&self) -> &[PathBuf] {
        &self.queue
    }

    pub fn queue_index(&self) -> usize {
        self.index
    }

    /// The clock under the picture: „1:23 / 45:00“ or, after a click on it, „−43:37 / 45:00“.
    pub fn time_text(&self, position: f64, duration: f64) -> String {
        time_text(self.show_remaining, position, duration)
    }
}

pub fn play_next<T>(queue: &mut Vec<T>, index: &mut usize, n: usize) {
    if n >= queue.len() || n == *index {
        return;
    }
    let item = queue.remove(n);
    if n < *index {
        *index -= 1;
    }
    let at = (*index + 1).min(queue.len());
    queue.insert(at, item);
}

pub fn take_out<T>(queue: &mut Vec<T>, index: &mut usize, n: usize) {
    if n >= queue.len() || n == *index {
        return;
    }
    queue.remove(n);
    if n < *index {
        *index -= 1;
    }
}

pub fn time_text(remaining: bool, position: f64, duration: f64) -> String {
    let total = if duration > 0.0 { sondra_player::clock(duration) } else { "—".into() };
    if remaining && duration > 0.0 {
        format!("−{} / {total}", sondra_player::clock((duration - position).max(0.0)))
    } else {
        format!("{} / {total}", sondra_player::clock(position))
    }
}

impl Shell {
    /// A subtitle file for what plays (also what the dialog hands over).
    pub fn player_load_subtitle(&mut self, path: &std::path::Path, cx: &mut Context<Self>) -> Result<(), String> {
        let result = self.player.take_subtitle_file(path);
        cx.notify();
        result
    }

    pub(crate) fn player_choose_subtitle_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| {
                        if let Err(e) = shell.player.take_subtitle_file(&path) {
                            shell.player.subtitle_error = Some(e);
                        }
                        cx.notify();
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    /// The series of the Merkliste the file that plays is an episode of, if any.
    pub(crate) fn player_series(&self) -> Option<String> {
        let path = self.player.current_path()?;
        let name = path.file_name()?.to_string_lossy().into_owned();
        sondra_merk::matching::match_episode(&name, &self.merk.items).map(|m| m.item)
    }

    /// „Als Cover festlegen“: the picture at this moment, 720 px at most, becomes the cover of the series on the list.
    pub fn player_still_as_cover(&mut self, cx: &mut Context<Self>) {
        let (Some(id), Some(path), Some(ff)) = (self.player_series(), self.player.current_path().cloned(), sondra_media::Ffmpeg::locate()) else { return };
        // At the very end there is no picture left to take: a moment before it.
        let (at, length) = self.player.playback.as_ref().map_or((0.0f64, 0.0f64), |p| (p.position(), p.duration().unwrap_or(0.0)));
        let at = if length > 0.0 { at.min((length - 0.5).max(0.0)) } else { at };
        self.player.cover_said = Some("Das Bild wird genommen …".into());
        cx.notify();
        Self::in_background(
            cx,
            move || -> Result<String, String> {
                let still = std::env::temp_dir().join(format!("sondra-standbild-{}.jpg", std::process::id()));
                let out = std::process::Command::new(ff.program())
                    .args(["-v", "error", "-nostdin", "-y", "-ss", &format!("{at:.3}"), "-i"])
                    .arg(&path)
                    .args(["-frames:v", "1", "-vf", "scale='min(720,iw)':-2"])
                    .arg(&still)
                    .stdin(std::process::Stdio::null())
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() || !still.exists() {
                    return Err("Aus dieser Stelle liess sich kein Bild nehmen.".into());
                }
                let cover = crate::merk_edit::cover_from_file(&still);
                let _ = std::fs::remove_file(&still);
                cover
            },
            move |shell, answer, cx| {
                match answer {
                    Ok(cover) => {
                        let title = shell.merk.items.iter().find(|i| i.id == id).map(|i| i.title.clone()).unwrap_or_default();
                        shell.merk.change(&id, |item| item.cover = Some(cover));
                        crate::protocol::note("abspielen", format!("Standbild als Cover von „{title}“"));
                        shell.player.cover_said = Some(format!("Das ist jetzt das Cover von „{title}“."));
                    }
                    Err(e) => shell.player.cover_said = Some(e),
                }
                cx.notify();
            },
        );
    }

    /// „Im Ton-Editor öffnen“ / „Im Video-Editor öffnen“: the file goes into the session and to that tool; the film
    /// here is paused.
    pub fn player_open_in(&mut self, panel: Panel, cx: &mut Context<Self>) {
        let Some(path) = self.player.current_path().cloned() else { return };
        if let Some(pb) = self.player.playback.as_mut() {
            if pb.state() == sondra_playback::State::Playing {
                pb.toggle();
            }
        }
        self.session_add(vec![path.clone()], cx);
        let index = self.session_files().iter().position(|p| *p == path);
        self.session_hand_over(panel, index, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_reordered_and_shortened_around_what_plays() {
        let (mut q, mut i) = (vec!["a", "b", "c", "d"], 1);
        play_next(&mut q, &mut i, 3);
        assert_eq!((q.clone(), i), (vec!["a", "b", "d", "c"], 1));
        play_next(&mut q, &mut i, 0);
        assert_eq!((q.clone(), i), (vec!["b", "a", "d", "c"], 0), "the one that plays keeps playing");
        take_out(&mut q, &mut i, 0);
        assert_eq!(q.len(), 4, "the one that plays is not taken out");
        take_out(&mut q, &mut i, 2);
        assert_eq!(q, vec!["b", "a", "c"]);
    }

    #[test]
    fn the_clock_says_elapsed_or_remaining() {
        assert_eq!(time_text(false, 83.0, 2700.0), "1:23 / 45:00");
        assert_eq!(time_text(true, 83.0, 2700.0), "−43:37 / 45:00");
        assert_eq!(time_text(true, 83.0, 0.0), "1:23 / —");
    }
}
