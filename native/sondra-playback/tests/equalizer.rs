//! The equalizer's FFmpeg filters: nothing while flat or off, and a chain FFmpeg takes and that does what the
//! gains say — measured on a sine at the centre of each band.

use std::process::Command;

use sondra_playback::{equalizer_filters, Equalizer, EQ_BANDS, EQ_PRESETS};

fn mean_volume(program: &std::path::Path, hz: f64, filters: &[String]) -> f64 {
    let mut chain = filters.join(",");
    if !chain.is_empty() {
        chain.push(',');
    }
    chain.push_str("volumedetect");
    let out = Command::new(program).args(["-hide_banner", "-f", "lavfi", "-i", &format!("sine=frequency={hz}:duration=1,volume=0.1"), "-af", &chain, "-f", "null", "-"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{chain}: {text}");
    text.lines().find_map(|l| l.split("mean_volume: ").nth(1)).and_then(|v| v.trim().trim_end_matches(" dB").parse().ok()).unwrap_or_else(|| panic!("no volume in {text}"))
}

#[test]
fn flat_or_off_asks_for_no_filter_and_a_band_asks_for_its_own() {
    assert!(equalizer_filters(&Equalizer { on: true, gains: [0.0; 5] }).is_empty());
    assert!(equalizer_filters(&Equalizer { on: false, gains: [6.0; 5] }).is_empty());
    let mid = equalizer_filters(&Equalizer { on: true, gains: [0.0, 0.0, 3.0, 0.0, 0.0] });
    assert_eq!(mid, ["equalizer=f=1000:t=q:w=1:g=3", "alimiter=limit=0.944:attack=3:release=100:level=0"]);
    // Past ±12 dB the gain is held there, as the web player holds it.
    assert!(equalizer_filters(&Equalizer { on: true, gains: [40.0, 0.0, 0.0, 0.0, 0.0] })[0].ends_with("g=12"));
    assert_eq!(EQ_PRESETS.len(), 5);
    assert_eq!(EQ_BANDS[2], ("Mitten", 1000.0));
}

#[test]
fn every_preset_is_taken_by_ffmpeg_and_a_boosted_band_is_louder_by_what_was_asked() {
    let Some(ff) = sondra_media::Ffmpeg::locate() else { return };
    for (name, gains) in EQ_PRESETS {
        let filters = equalizer_filters(&Equalizer { on: true, gains });
        mean_volume(ff.program(), 1000.0, &filters);
        let _ = name;
    }
    let flat = mean_volume(ff.program(), 1000.0, &[]);
    let boosted = mean_volume(ff.program(), 1000.0, &equalizer_filters(&Equalizer { on: true, gains: [0.0, 0.0, 9.0, 0.0, 0.0] }));
    assert!((boosted - flat - 9.0).abs() < 0.6, "{flat} → {boosted}");
    let cut = mean_volume(ff.program(), 300.0, &equalizer_filters(&Equalizer { on: true, gains: [0.0, -6.0, 0.0, 0.0, 0.0] }));
    let plain = mean_volume(ff.program(), 300.0, &[]);
    assert!((cut - plain + 6.0).abs() < 0.6, "{plain} → {cut}");
}
