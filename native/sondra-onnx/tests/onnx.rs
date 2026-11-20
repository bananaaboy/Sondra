//! A model the person brings, run on this computer: two tiny models in the two shapes the runner knows
//! (`tests/make-models.py`) stand in for Demucs and Spleeter. Each stem of them is the mix times 0.1, 0.2, 0.3, 0.4, so
//! what comes out says whether the windows were laid and the masks applied the way the website does it.

use std::path::PathBuf;

use sondra_media::audio::AudioData;
use sondra_onnx::{Model, Strategy};

fn model(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/models").join(name)
}

fn mix(frames: usize, channels: usize) -> AudioData {
    let make = |phase: f64| (0..frames).map(|i| (0.6 * (i as f64 * 0.05 + phase).sin() + 0.2 * (i as f64 * 0.31).sin()) as f32).collect::<Vec<f32>>();
    AudioData { channels: (0..channels).map(|c| make(c as f64)).collect(), sample_rate: 8000 }
}

const SCALES: [f32; 4] = [0.1, 0.2, 0.3, 0.4];

fn close(got: &[f32], want: &[f32], edge: usize, tolerance: f32, what: &str) {
    assert_eq!(got.len(), want.len());
    let worst = (edge..got.len() - edge).map(|i| (got[i] - want[i]).abs()).fold(0f32, f32::max);
    assert!(worst < tolerance, "{what}: off by {worst}");
}

#[test]
fn a_waveform_model_is_read_and_its_windows_add_up_to_the_mix_times_each_scale() {
    let mut m = Model::open(&model("waveform.onnx")).unwrap();
    assert_eq!(m.info.strategy, Strategy::Waveform);
    assert_eq!(m.info.stem_count, 4);
    assert_eq!(m.info.input_shape, [1, 2, 4096]);
    assert_eq!(m.info.describe(), "Wellenform, 4 Stimmen");
    // Three and a bit windows of 4096 with half overlap.
    let audio = mix(10_000, 2);
    let mut noted = Vec::new();
    let stems = m.separate(&audio, &mut |f, note| noted.push((f, note.to_string()))).unwrap();
    assert!(noted.len() >= 4 && (noted.last().unwrap().0 - 1.0).abs() < 1e-9, "{noted:?}");
    assert!(noted[0].1.starts_with("Fenster 1 von"));
    for (s, stem) in stems.iter().enumerate() {
        assert_eq!(stem.channels.len(), 2);
        for c in 0..2 {
            let want: Vec<f32> = audio.channels[c].iter().map(|v| v * SCALES[s]).collect();
            // The first and last samples carry (next to) no weight — the Hann window is zero there — as on the website.
            close(&stem.channels[c], &want, 3, 1e-4, &format!("stem {s} channel {c}"));
        }
    }
}

#[test]
fn a_mono_take_goes_through_a_stereo_model_and_comes_out_mono() {
    let mut m = Model::open(&model("waveform.onnx")).unwrap();
    let audio = mix(6000, 1);
    let stems = m.separate(&audio, &mut |_, _| {}).unwrap();
    assert_eq!(stems[0].channels.len(), 1);
    let want: Vec<f32> = audio.channels[0].iter().map(|v| v * 0.2).collect();
    close(&stems[1].channels[0], &want, 3, 1e-4, "drums");
}

#[test]
fn a_mask_model_is_read_and_its_masks_are_applied_to_the_spectrogram() {
    let mut m = Model::open(&model("mask.onnx")).unwrap();
    assert_eq!(m.info.strategy, Strategy::SpectrogramMask);
    assert_eq!(m.info.input_shape.len(), 4);
    assert_eq!(m.info.stem_count, 4);
    assert_eq!(m.info.describe(), "Spektrogramm-Masken, 4 Stimmen");
    let audio = mix(20_000, 2);
    let mut last = 0.0;
    let stems = m.separate(&audio, &mut |f, _| last = f).unwrap();
    assert!((last - 1.0).abs() < 1e-9);
    for (s, stem) in stems.iter().enumerate() {
        for c in 0..2 {
            let want: Vec<f32> = audio.channels[c].iter().map(|v| v * SCALES[s]).collect();
            close(&stem.channels[c], &want, 0, 2e-3, &format!("stem {s} channel {c}"));
        }
    }
}

#[test]
fn what_is_no_model_is_said_in_words() {
    let dir = tempfile::tempdir().unwrap();
    let bad = dir.path().join("kaputt.onnx");
    std::fs::write(&bad, b"das ist kein Modell").unwrap();
    let error = Model::open(&bad).err().expect("refused");
    assert!(error.starts_with("Das Modell ließ sich nicht laden"), "{error}");
    assert!(Model::open(&dir.path().join("fehlt.onnx")).is_err());
}
