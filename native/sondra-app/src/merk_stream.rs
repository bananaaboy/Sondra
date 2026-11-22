//! „Folge n abspielen“ as a stream (the website's `useStreamHere`): when the next episode lies in no folder, its page
//! is looked up as „Herunterladen“ would, and the best source plays straight away in the player — nothing is saved.
//! The player shows the episode under a name of its own („Frieren S01E05.mp4“), so it is ticked off at 90 % as a file
//! would be; FFmpeg reads the address, with the hoster's page as referer.

use std::path::PathBuf;

use gpui::Context;
use sondra_extract::stream::StreamInfo;

use crate::download_page::{find, Found};
use crate::merk_edit::episode_address;
use crate::shell::Shell;

/// The source to play among those found: a whole file before a playlist of pieces, then the first.
pub fn best_stream(found: &Found) -> Result<StreamInfo, String> {
    match found {
        Found::Direct(stream) => Ok(stream.clone()),
        Found::Episode(ep) => {
            let pick = ep.streams.iter().find(|s| !s.is_hls).or_else(|| ep.streams.first()).ok_or("Für diese Folge hat Sondra keinen Stream gefunden. „Laden“ unter „Mehr“ versucht es mit allen Quellen.")?;
            Ok(StreamInfo { title: ep.title.clone(), url: pick.url.clone(), is_hls: pick.is_hls, referer: pick.referer.clone(), hoster: pick.provider.clone() })
        }
        Found::Portal { .. } => Err("Diese Adresse lässt sich nur laden, nicht direkt abspielen.".into()),
    }
}

/// The name the player shows: the series, „S01E05“, as a file of the kind the stream is.
pub fn shown_name(title: &str, season: i64, episode: i64) -> String {
    let clean: String = title.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { ' ' } else { c }).collect();
    format!("{} S{season:02}E{episode:02}.mp4", clean.trim())
}

impl Shell {
    /// For tests: what the player's list holds.
    pub fn player_queue_now(&self) -> Vec<PathBuf> {
        self.player.queue.clone()
    }

    /// „Stream sofort abspielen“ in „Herunterladen“: what was found plays at once, nothing is saved.
    pub fn download_stream_now(&mut self, cx: &mut Context<Self>) {
        let Some(found) = self.download.found.clone() else { return };
        match best_stream(&found) {
            Ok(stream) => {
                let name = match &found {
                    Found::Episode(ep) if ep.season > 0 => shown_name(&ep.series_title, ep.season as i64, ep.episode as i64),
                    _ => format!("{}.mp4", stream.title.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { ' ' } else { c }).collect::<String>().trim()),
                };
                let shown = std::env::temp_dir().join("sondra-stream").join(name);
                sondra_playback::register_stream(&shown, &stream.url, &stream.referer);
                self.download.stream_said = None;
                self.go(crate::nav::Panel::Player, cx);
                self.play_files(vec![shown], cx);
            }
            Err(why) => self.download.stream_said = Some(why),
        }
        cx.notify();
    }

    /// Plays the episode the series stands at, from its address, without loading it first.
    pub fn merk_stream_here(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(item) = self.merk.items.iter().find(|i| i.id == id) else { return };
        if item.url.trim().is_empty() || self.merk.streaming.is_some() {
            return;
        }
        let (season, episode) = (item.season, item.episode.unwrap_or(1).max(1));
        let address = episode_address(&item.url, season, episode);
        let name = shown_name(&item.title, season, episode);
        let (factory, language) = (self.download.fetch.clone(), self.download.language.clone());
        self.merk.streaming = Some(id.to_string());
        self.merk.stream_said = Some("Sucht den Stream …".into());
        cx.notify();
        Self::in_background(
            cx,
            move || find(factory().as_ref(), &address, &language).and_then(|found| best_stream(&found)),
            move |shell, answer, cx| {
                shell.merk.streaming = None;
                match answer {
                    Ok(stream) => {
                        let shown: PathBuf = std::env::temp_dir().join("sondra-stream").join(&name);
                        sondra_playback::register_stream(&shown, &stream.url, &stream.referer);
                        shell.merk.stream_said = None;
                        crate::protocol::note("merkliste", format!("Als Stream: {name}"));
                        shell.go(crate::nav::Panel::Player, cx);
                        shell.play_files(vec![shown], cx);
                    }
                    Err(why) => shell.merk.stream_said = Some(why),
                }
                cx.notify();
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shown_name_is_a_file_name_the_list_recognises() {
        assert_eq!(shown_name("Re:Zero", 2, 5), "Re Zero S02E05.mp4");
        let items = vec![sondra_merk::normalize::normalize(&serde_json::json!({ "id": "fr", "title": "Frieren", "seasons": [{ "number": 1, "episodes": 28 }] }), &mut sondra_merk::normalize::Context::system())];
        let found = sondra_merk::matching::match_episode(&shown_name("Frieren", 1, 5), &items).unwrap();
        assert_eq!((found.item.as_str(), found.season, found.episode), ("fr", 1, 5));
    }
}
