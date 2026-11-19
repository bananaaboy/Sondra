//! WAV bytes and reversal, byte for byte against `encodeWav` / `reverseAudio` of the web app.

use sondra_media::audio::{encode_wav, AudioData, WavBits};

fn floats(v: &serde_json::Value) -> Vec<f32> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn the_bytes_of_a_wav_are_the_web_apps_at_every_depth() {
    let t: serde_json::Value = serde_json::from_str(include_str!("golden/wav.json")).unwrap();
    let audio = AudioData { channels: vec![floats(&t["left"]), floats(&t["right"])], sample_rate: t["rate"].as_u64().unwrap() as u32 };
    for (bits, key) in [(WavBits::Pcm16, "w16"), (WavBits::Pcm24, "w24"), (WavBits::Float32, "w32")] {
        assert_eq!(hex(&encode_wav(&audio, bits)), t[key].as_str().unwrap(), "{key}");
    }
}
