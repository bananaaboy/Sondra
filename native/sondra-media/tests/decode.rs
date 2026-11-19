//! Reading a sound file into floats and writing it back out, through the real FFmpeg.

use std::process::Command;

use sondra_media::audio::{decode_file, write_wav_f32, AudioData};
use sondra_media::Ffmpeg;

#[test]
fn a_tone_is_read_into_planar_floats_and_a_wav_of_them_reads_back_the_same() {
    let Some(ff) = Ffmpeg::locate() else { return };
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("ton.wav");
    let out = Command::new(ff.program()).args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050", "-ac", "2", "-t", "1"]).arg(&src).output().unwrap();
    assert!(out.status.success());
    let audio = decode_file(&ff, &src, None).unwrap();
    assert_eq!((audio.channels.len(), audio.sample_rate), (2, 22050));
    assert!((22000..=22100).contains(&audio.frames()), "{}", audio.frames());
    let peak = audio.channels[0].iter().fold(0f32, |m, s| m.max(s.abs()));
    assert!((0.05..=1.0).contains(&peak), "a tone, not silence: {peak}");
    let resampled = decode_file(&ff, &src, Some(44100)).unwrap();
    assert_eq!(resampled.sample_rate, 44100);
    assert!((resampled.frames() as f64 / 44100.0 - 1.0).abs() < 0.02);

    let wav = dir.path().join("zurueck.wav");
    write_wav_f32(&wav, &audio).unwrap();
    let back = decode_file(&ff, &wav, None).unwrap();
    assert_eq!(back.channels.len(), 2);
    assert_eq!(back.frames(), audio.frames());
    let worst = audio.channels[0].iter().zip(&back.channels[0]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
    assert!(worst < 1e-6, "a float WAV loses nothing: {worst}");
    assert!(decode_file(&ff, &dir.path().join("gibt-es-nicht.wav"), None).is_err());
    let _ = AudioData { channels: vec![], sample_rate: 1 };
}
