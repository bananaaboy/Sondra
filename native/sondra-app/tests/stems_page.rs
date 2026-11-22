//! The Spuren-trennen page: a song chosen, a setting picked, the four stems and the karaoke version made,
//! heard one by one and written as files.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_media::audio::AudioData;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

/// A voice-like tone in the middle and a click train on the sides.
fn song(seconds: f64) -> AudioData {
    let rate = 8000u32;
    let n = (f64::from(rate) * seconds) as usize;
    let left: Vec<f32> = (0..n).map(|i| (0.4 * (i as f64 * 0.15).sin() + if i % 2000 < 40 { 0.4 } else { 0.0 }) as f32).collect();
    let right: Vec<f32> = (0..n).map(|i| (0.4 * (i as f64 * 0.15).sin() + if i % 2000 < 40 { -0.4 } else { 0.0 }) as f32).collect();
    AudioData { channels: vec![left, right], sample_rate: rate }
}

fn open<'a>(cx: &'a mut TestAppContext, name: std::path::PathBuf) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.stems_load(song(3.0), name, cx);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(1500.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Stems, cx));
    w.draw();
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(1500.))), move |_, _| view);
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn labels(&self) -> Vec<String> {
        self.tree().nodes.iter().filter_map(|n| n.label.as_ref().map(|l| AsRef::<str>::as_ref(l).to_owned())).collect()
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen: {:?}", self.labels())).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
    fn settle(&mut self, done: impl Fn(&Shell) -> bool) {
        for _ in 0..600 {
            self.cx.run_until_parked();
            self.cx.executor().advance_clock(std::time::Duration::from_millis(200));
            self.draw();
            if self.shell.read_with(self.cx, |s, _| done(s)) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("did not settle: {:?}", self.labels());
    }
}

#[gpui::test]
fn a_song_is_split_heard_stem_by_stem_and_written(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("lied.wav"));
    assert!(w.tree().find(Role::Button, "Spuren trennen").is_some());
    // Nothing is made before it is asked for, and no setting is changed by itself.
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.stems_count()), 0);

    w.press(Role::Button, "Worauf es ankommt: Gesang");
    w.press(Role::Button, "Spuren trennen");
    assert!(w.shell.read_with(w.cx, |s, _| s.stems_running()));
    w.settle(|s| s.stems_count() == 5);
    for name in ["Gesang", "Schlagzeug", "Bass", "Übriges", "Instrumental"] {
        assert!(w.labels().iter().any(|l| l == name), "{name}: {:?}", w.labels());
    }
    // Every stem has the length of the song.
    for i in 0..5 {
        assert_eq!(w.shell.read_with(w.cx, |s, _| s.stems_audio(i)).unwrap().frames(), 24_000);
    }

    w.press(Role::Button, "Gesang anhören");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.stems_playing()), Some(0));
    w.press(Role::Button, "Gesang anhalten");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.stems_playing()), None);

    w.press(Role::Button, "Alle als WAV speichern");
    w.settle(|s| s.stems_made().len() == 5);
    let folder = tmp.path().join("lied (Spuren)");
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 5);
    assert!(folder.join("lied – Instrumental.wav").exists());
    // And all of them in one ZIP beside them.
    w.press(Role::Button, "Als ZIP speichern");
    w.settle(|s| s.stems_zip().is_some());
    let (zip, bytes) = w.shell.read_with(w.cx, |s, _| s.stems_zip()).unwrap().expect("a ZIP");
    assert_eq!(zip.parent().unwrap(), folder);
    assert_eq!(std::fs::metadata(&zip).unwrap().len(), bytes);
    let data = std::fs::read(&zip).unwrap();
    assert_eq!(&data[..2], b"PK");
    for name in ["Gesang", "Schlagzeug", "Bass", "Übriges", "Instrumental"] {
        let wanted = format!("lied – {name}.wav");
        assert!(data.windows(wanted.len()).any(|w| w == wanted.as_bytes()), "{wanted} is not in the ZIP");
    }
    // A name of its own for the ZIP, and the tracks into the session.
    let field = w.shell.read_with(w.cx, |s, _| s.stems_zip_field());
    w.cx.update(|_, app| field.update(app, |f, cx| f.set_text("Meine Spuren", cx)));
    w.press(Role::Button, "Als ZIP speichern");
    w.settle(|s| s.stems_zip().is_some_and(|z| z.is_ok_and(|(p, _)| p.file_name().unwrap().to_string_lossy().starts_with("Meine Spuren"))));
    w.press(Role::Button, "Die Spuren in die Sitzung übernehmen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.session_files().len()), 5);
}

#[gpui::test]
fn a_model_the_person_brings_is_checked_kept_and_used_instead_of_the_masks(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("SONDRA_DATA", tmp.path());
    let models = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../sondra-onnx/tests/models");
    let mut w = open(cx, tmp.path().join("lied.wav"));
    assert!(w.tree().find(Role::Heading, "Eigenes Modell (.onnx)").is_some());
    assert!(w.tree().find(Role::Button, "Modell wählen …").is_some());
    // A file that is no model: said in words, nothing chosen.
    let bad = tmp.path().join("kaputt.onnx");
    std::fs::write(&bad, b"kein Modell").unwrap();
    w.shell.update(w.cx, |s, cx| s.stems_set_model(bad, cx));
    w.settle(|s| s.stems_model().2.is_some());
    assert!(w.shell.read_with(w.cx, |s, _| s.stems_model()).0.is_none());
    assert!(w.labels().iter().any(|l| l.starts_with("Das Modell ließ sich nicht laden")), "{:?}", w.labels());
    // A waveform model: opened once to see what it is, then chosen.
    let model = models.join("waveform.onnx");
    w.shell.update(w.cx, |s, cx| s.stems_set_model(model.clone(), cx));
    w.settle(|s| s.stems_model().1.is_some() || s.stems_model().2.is_some());
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.stems_model()).2, None);
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.stems_model()).1.as_deref(), Some("Wellenform, 4 Stimmen"));
    assert!(w.labels().iter().any(|l| l == "waveform.onnx"));
    assert!(w.tree().find(Role::Button, "Ohne Modell trennen").is_some());
    // It is kept for the next start.
    let kept = std::fs::read_to_string(tmp.path().join("Spuren.json")).unwrap();
    assert!(kept.contains("waveform.onnx"), "{kept}");
    // The separation is the model's: each stem is the song times its scale (0.1, 0.2, 0.3, 0.4).
    w.press(Role::Button, "Spuren trennen");
    assert!(w.labels().iter().any(|l| l.contains("Ihrem Modell")) || w.shell.read_with(w.cx, |s, _| s.stems_running()));
    w.settle(|s| s.stems_count() == 5);
    let original = song(3.0);
    let drums = w.shell.read_with(w.cx, |s, _| s.stems_audio(1)).unwrap();
    let mid = 12_000;
    assert!((drums.channels[0][mid] - original.channels[0][mid] * 0.2).abs() < 1e-3, "{} vs {}", drums.channels[0][mid], original.channels[0][mid] * 0.2);
    // And the person can go back to the masks.
    w.press(Role::Button, "Ohne Modell trennen");
    assert!(w.shell.read_with(w.cx, |s, _| s.stems_model()).0.is_none());
    assert!(w.tree().find(Role::Button, "Modell wählen …").is_some());
}

#[gpui::test]
fn the_fine_tuning_of_the_website_sets_the_values_by_hand(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Lied.wav"));
    w.press(Role::Button, "Feinjustierung");
    for label in ["Maskenhärte", "Mittenschärfe", "Auflösung (FFT)", "Filterfenster"] {
        assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.as_ref() == label)), "{label}");
    }
    w.press(Role::Button, "8192 — Orchester / Solo");
    assert_eq!(w.tree().find(Role::Button, "8192 — Orchester / Solo").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Worauf es ankommt: Ausgewogen").unwrap().toggled, Some(false), "by hand, no template is chosen");
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("Eigene Einstellung"))));
    // A template again takes the hand-set values away.
    w.press(Role::Button, "Worauf es ankommt: Gesang");
    assert_eq!(w.tree().find(Role::Button, "4096 — Musik").unwrap().toggled, Some(true));
}
