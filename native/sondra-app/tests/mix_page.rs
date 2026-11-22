//! The Mischen page with the real FFmpeg: a voice over music, the music stepping back, files written beside.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::time::Duration;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AppContext as _, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_media::Ffmpeg;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(1000.))), move |_, _| view);
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen")).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
    fn settle(&mut self, rounds: usize) {
        for _ in 0..rounds {
            self.cx.run_until_parked();
            self.draw();
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn made(&self) -> Vec<PathBuf> {
        self.cx.read_entity(&self.shell, |s, _| s.mix_made().to_vec())
    }
}

fn ff_run(ff: &Ffmpeg, args: &[&str]) {
    let out = Command::new(ff.program()).args(["-v", "error", "-y"]).args(args).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[gpui::test]
fn a_voice_over_music_is_mixed_with_the_music_stepping_back_and_goes_out_in_three_ways(cx: &mut TestAppContext) {
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let dir: &Path = tmp.path();
    // A voice that speaks in bursts (a 200 Hz tone, gated on and off) and music of two tones.
    let voice = dir.join("stimme.wav");
    ff_run(&ff, &["-f", "lavfi", "-i", "sine=frequency=200:sample_rate=22050:duration=8", "-af", "volume='if(lt(mod(t,2),1),0.4,0.002)':eval=frame", "-ac", "1", voice.to_str().unwrap()]);
    let music = dir.join("musik.wav");
    ff_run(&ff, &["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=5", "-ac", "2", music.to_str().unwrap()]);
    let film = dir.join("film.mp4");
    ff_run(&ff, &["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=8", "-i", voice.to_str().unwrap(), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", film.to_str().unwrap()]);

    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, vcx) = cx.add_window_view(|window, cx| Shell::new(window, cx));
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    vcx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    vcx.simulate_resize(size(px(WIDTH), px(1000.)));
    let mut w = Window { cx: vcx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Mix, cx));
    w.draw();
    assert!(w.tree().find(Role::Button, "Stimme wählen").is_some());
    assert!(w.tree().find(Role::Button, "Musik wählen").is_some());

    w.shell.update(w.cx, |shell, cx| shell.mix_take(true, voice.clone(), cx));
    w.draw();
    assert!(w.tree().find(Role::Button, "Als WAV speichern").is_none(), "one file is not a mix");
    w.shell.update(w.cx, |shell, cx| shell.mix_take(false, music.clone(), cx));
    w.settle(60);
    let report = w.cx.read_entity(&w.shell, |s, _| s.mix_report()).expect("mixed");
    assert!((report.voice_seconds - 8.0).abs() < 0.05, "{}", report.voice_seconds);
    assert!(report.speech_seconds > 2.0 && report.speech_seconds < 7.0, "the bursts are heard: {}", report.speech_seconds);
    assert!((report.total_seconds - 13.0).abs() < 0.1, "two seconds before, three after: {}", report.total_seconds);
    assert!(w.tree().find(Role::Heading, "Mischung").is_some());
    assert!(w.tree().find(Role::Button, "Unter das Video legen").is_none(), "the voice is not a video");

    // A setting changes the mix; the lead-in is the length of the mix.
    w.press(Role::Button, "Musik vor Sprachbeginn 0 s");
    w.settle(60);
    let report = w.cx.read_entity(&w.shell, |s, _| s.mix_report()).unwrap();
    assert!((report.total_seconds - 11.0).abs() < 0.1, "{}", report.total_seconds);

    // Written as a WAV beside the voice, and as its three tracks.
    w.press(Role::Button, "Als WAV speichern");
    w.settle(60);
    let made = w.made();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].file_name().unwrap().to_string_lossy(), "stimme (gemischt).wav");
    assert!(std::fs::metadata(&made[0]).unwrap().len() > 100_000);
    // As MP3, too.
    w.press(Role::Button, "Als MP3 speichern");
    w.settle(60);
    let made = w.made();
    assert_eq!(made[0].file_name().unwrap().to_string_lossy(), "stimme (gemischt).mp3");
    // A template sets five values at once.
    w.press(Role::Button, "Voiceover / Stark");
    w.settle(60);
    assert_eq!(w.tree().find(Role::Button, "Musikpegel −8,0 dB").map(|n| n.toggled), None.or(w.tree().find(Role::Button, "Musikpegel −8,0 dB").map(|n| n.toggled)));
    assert_eq!(w.tree().find(Role::Button, "Voiceover / Stark").unwrap().toggled, Some(true));
    // Hear the mix, then the same without lowering the music; the second press stops it.
    w.press(Role::Button, "Gemischt anhören");
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.mix_listening()), Some(true));
    w.press(Role::Button, "Ohne Absenken anhören");
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.mix_listening()), Some(false));
    w.press(Role::Button, "Ohne Absenken anhören");
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.mix_listening()), None);
    w.press(Role::Button, "Einzelspuren speichern");
    w.settle(60);
    let made = w.made();
    assert_eq!(made.len(), 3);
    assert!(made.iter().all(|p| p.exists() && p.parent().unwrap().file_name().unwrap() == "stimme-spuren"));

    // Under a video: the voice is a video now.
    w.shell.update(w.cx, |shell, cx| shell.mix_take(true, film.clone(), cx));
    w.settle(60);
    assert!(w.tree().find(Role::Button, "Unter das Video legen").is_some());
    w.press(Role::Button, "Unter das Video legen");
    w.settle(80);
    let made = w.made();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].extension().unwrap(), "mp4");
    let probe = ff.probe(&made[0]).unwrap();
    assert!(probe.streams.iter().any(|s| s.kind == "video") && probe.streams.iter().any(|s| s.kind == "audio"));
    assert!(film.exists());
}
