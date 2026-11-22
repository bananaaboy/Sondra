//! „Vorschau abspielen“ in the video editor: what stays — from „Anfang“ to „Ende“ — plays on the stage with the
//! player's own machinery, at the speed set, and stops at the end. „Ton im Vorhören“ (the website's switch) says
//! whether its sound is heard; a film set to „Ohne Ton“ is previewed without it either way. The picture is the
//! original's: crop and turn show on the stills, and in what is saved.

use std::sync::Arc;

use gpui::{Context, RenderImage, Window};
use image::{Frame as ImageFrame, RgbaImage};
use smallvec::smallvec;
use sondra_playback::{Playback, State};

use crate::shell::Shell;

/// Whether the preview is heard: the switch, unless the film is to be silent anyway.
pub fn heard(sound: bool, film_muted: bool) -> bool {
    sound && !film_muted
}

impl Shell {
    /// Starts the preview at the beginning of what stays, or stops it.
    pub fn video_preview_toggle(&mut self, cx: &mut Context<Self>) {
        if self.video.preview.take().is_some() {
            cx.notify();
            return;
        }
        let (Some(file), Some(ff)) = (self.video.file.clone(), sondra_media::Ffmpeg::locate()) else { return };
        let ops = self.video.ops.clone();
        match Playback::open(ff, &file, ops.start.max(0.0)) {
            Ok(mut p) => {
                p.set_muted(!heard(self.video.preview_sound, ops.mute));
                if (ops.speed - 1.0).abs() > 1e-9 {
                    let _ = p.set_rate(ops.speed.clamp(0.25, 4.0));
                }
                p.play();
                self.video.preview = Some(p);
                self.video.error = None;
            }
            Err(e) => self.video.error = Some(format!("Die Vorschau liess sich nicht abspielen: {e}")),
        }
        cx.notify();
    }

    /// „Ton im Vorhören“ an/aus, also while it plays.
    pub fn video_preview_sound(&mut self, on: bool, cx: &mut Context<Self>) {
        self.video.preview_sound = on;
        let muted = !heard(on, self.video.ops.mute);
        if let Some(p) = self.video.preview.as_mut() {
            p.set_muted(muted);
        }
        cx.notify();
    }

    /// For tests: whether the preview plays, and whether it is heard.
    pub fn video_preview_now(&self) -> (bool, bool) {
        (self.video.preview.is_some(), heard(self.video.preview_sound, self.video.ops.mute))
    }

    /// One step of the window's clock: the picture that is due, the place on the timeline, the end of what stays.
    /// Returns whether to draw again soon.
    pub(crate) fn video_preview_tick(&mut self, window: &mut Window) -> bool {
        let on_page = self.panel() == crate::nav::Panel::Video;
        let v = &mut self.video;
        let Some(p) = v.preview.as_mut() else { return false };
        let end = if v.ops.end > 0.0 { v.ops.end } else { v.duration };
        if !on_page || p.state() == State::Ended || (end > 0.0 && p.position() >= end) {
            v.preview = None;
            return true;
        }
        if let Some(frame) = p.next_frame() {
            if let Some(buffer) = RgbaImage::from_raw(frame.width, frame.height, frame.bgra) {
                let new = Arc::new(RenderImage::new(smallvec![ImageFrame::new(buffer)]));
                if let Some(old) = v.frame.replace(new) {
                    let _ = window.drop_image(old);
                }
            }
        }
        v.position = p.position();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::heard;

    #[test]
    fn a_silent_film_is_previewed_silent_whatever_the_switch() {
        assert!(heard(true, false));
        assert!(!heard(false, false));
        assert!(!heard(true, true));
    }
}
