//! The converter's arguments against the table the web app writes (`npm run native:golden`): every
//! format with a spread of settings, every template, every sample rate.

use serde::Deserialize;
use sondra_media::convert::*;
use sondra_media::presets::{built_in, preset_for, Partial};

const GOLDEN: &str = include_str!("golden/convert-args.json");

#[derive(Deserialize)]
struct Row {
    name: String,
    settings: Settings,
    input: String,
    output: String,
    args: Vec<String>,
}

#[derive(Deserialize)]
struct Rate {
    format: String,
    wanted: Pick<u32>,
    got: Pick<u32>,
}

#[derive(Deserialize)]
struct GoldenPreset {
    id: String,
    label: String,
    hint: String,
    video: Option<Partial>,
    audio: Option<Partial>,
}

#[derive(Deserialize)]
struct Golden {
    rows: Vec<Row>,
    rates: Vec<Rate>,
    presets: Vec<GoldenPreset>,
}

fn golden() -> Golden {
    serde_json::from_str(GOLDEN).expect("the golden table reads")
}

#[test]
fn every_command_is_the_one_the_web_app_builds() {
    let golden = golden();
    assert!(golden.rows.len() >= 50, "the table is not empty");
    for row in &golden.rows {
        let got = build_args(&row.input, &row.output, &row.settings).expect("a known format");
        assert_eq!(got, row.args, "{}", row.name);
    }
}

#[test]
fn every_sample_rate_is_moved_to_the_nearest_the_encoder_takes() {
    let golden = golden();
    assert!(golden.rates.len() >= 80);
    for r in &golden.rates {
        let format = find_format(&r.format).unwrap();
        assert_eq!(
            rate_for(format, r.wanted),
            r.got,
            "{} at {:?}",
            r.format,
            r.wanted
        );
    }
}

#[test]
fn the_templates_are_the_web_apps_templates() {
    let golden = golden();
    let ours = built_in();
    assert_eq!(ours.len(), golden.presets.len());
    for (mine, theirs) in ours.iter().zip(&golden.presets) {
        assert_eq!(
            (mine.id, mine.label, mine.hint),
            (
                theirs.id.as_str(),
                theirs.label.as_str(),
                theirs.hint.as_str()
            )
        );
        assert_eq!(mine.video, theirs.video, "{} for a video", mine.id);
        assert_eq!(mine.audio, theirs.audio, "{} for a sound file", mine.id);
    }
}

#[test]
fn a_template_applied_gives_the_same_command() {
    let golden = golden();
    for preset in built_in() {
        for (kind, word) in [(Kind::Video, "video"), (Kind::Audio, "audio")] {
            let Some(set) = preset_for(&preset, kind) else {
                continue;
            };
            let mut settings = Settings::default();
            set.apply(&mut settings);
            let row = golden
                .rows
                .iter()
                .find(|r| r.name == format!("Vorlage {} ({word})", preset.id))
                .expect("a row for it");
            assert_eq!(settings, row.settings, "{} ({word})", preset.id);
            assert_eq!(
                build_args("eingang.mkv", &row.output, &settings).unwrap(),
                row.args
            );
        }
    }
}

#[test]
fn what_is_not_a_format_is_told() {
    let st = Settings {
        format_id: "mp5".into(),
        ..Settings::default()
    };
    assert_eq!(
        build_args("a", "b", &st).unwrap_err().to_string(),
        "Unbekanntes Format: mp5"
    );
}

#[test]
fn the_command_can_be_shown_as_typed() {
    let args = build_args("Meine Datei.mkv", "aus.mp3", &Settings::default()).unwrap();
    assert_eq!(
        preview_command(&args),
        "ffmpeg -i \"Meine Datei.mkv\" -vn -c:a libmp3lame -q:a 2 aus.mp3"
    );
}

#[test]
fn numbers_print_the_way_javascript_prints_them() {
    assert_eq!(js_number(30.0), "30");
    assert_eq!(js_number(29.97), "29.97");
    assert_eq!(js_number(23.5), "23.5");
    assert_eq!(js_number(0.0), "0");
}

#[test]
fn vp8_quality_follows_the_x264_scale_with_javascript_rounding() {
    // Math.round(23 * 0.9 - 10) = 11; halves go up; the ends are clamped.
    assert_eq!(vp8_args(23.0)[3], "11");
    assert_eq!(vp8_args(0.0)[3], "4");
    assert_eq!(vp8_args(60.0)[3], "44");
    assert_eq!(vp8_args(100.0)[3], "50");
    // 25.0 * 0.9 - 10 = 12.5 → 13
    assert_eq!(vp8_args(25.0)[3], "13");
}
