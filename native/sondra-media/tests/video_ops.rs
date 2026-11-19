//! The video editor's command lines against what the web app's own `video.ts` builds for the same settings
//! (`npm run native:golden`), argument for argument.

use serde::Deserialize;
use serde_json::Value;
use sondra_media::video_ops::*;

const GOLDEN: &str = include_str!("golden/video.json");

#[derive(Deserialize)]
struct File {
    jobs: Vec<Job>,
    extraction: Vec<Extraction>,
    grabs: Vec<Grab>,
    replacement: Built,
}
#[derive(Deserialize)]
struct Source {
    width: u32,
    height: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Built {
    args: Vec<String>,
    extension: String,
    mime: String,
    copy_only: bool,
}
#[derive(Deserialize)]
struct Job {
    name: String,
    ops: Value,
    duration: f64,
    source: Option<Source>,
    #[serde(flatten)]
    built: Built,
}
#[derive(Deserialize)]
struct Extraction {
    format: String,
    #[serde(flatten)]
    built: Built,
}
#[derive(Deserialize)]
struct Grab {
    at: f64,
    #[serde(flatten)]
    built: Built,
}

fn num(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or_else(|| panic!("{key}"))
}
fn flag(v: &Value, key: &str) -> bool {
    v[key].as_bool().unwrap_or_else(|| panic!("{key}"))
}

fn ops_of(v: &Value) -> VideoOps {
    VideoOps {
        start: num(v, "start"),
        end: num(v, "end"),
        crop: v["crop"].as_object().map(|c| CropBox { x: c["x"].as_f64().unwrap(), y: c["y"].as_f64().unwrap(), width: c["width"].as_f64().unwrap(), height: c["height"].as_f64().unwrap() }),
        rotate: num(v, "rotate") as u16,
        flip_h: flag(v, "flipH"),
        flip_v: flag(v, "flipV"),
        speed: num(v, "speed"),
        mute: flag(v, "mute"),
        container: match v["container"].as_str().unwrap() {
            "webm" => Container::Webm,
            "gif" => Container::Gif,
            "webp" => Container::Webp,
            _ => Container::Mp4,
        },
        preset: v["preset"].as_str().unwrap().to_owned(),
        brightness: num(v, "brightness"),
        contrast: num(v, "contrast"),
        saturation: num(v, "saturation"),
        look: VIDEO_LOOKS.iter().find(|(_, id, _)| *id == v["look"].as_str().unwrap()).map(|(l, _, _)| *l).unwrap(),
        sharpen: flag(v, "sharpen"),
        denoise: flag(v, "denoise"),
        stabilize: flag(v, "stabilize"),
        fade_in: num(v, "fadeIn"),
        fade_out: num(v, "fadeOut"),
        volume_db: num(v, "volumeDb"),
        loudnorm: flag(v, "loudnorm"),
        reverse: flag(v, "reverse"),
        fps: num(v, "fps"),
        width: num(v, "width"),
    }
}

#[test]
fn every_job_is_the_web_apps_command_line() {
    let file: File = serde_json::from_str(GOLDEN).unwrap();
    assert!(file.jobs.len() >= 26);
    for job in &file.jobs {
        let made = build_video_job(&ops_of(&job.ops), "in.mp4", job.duration, job.source.as_ref().map(|s| (s.width, s.height)));
        assert_eq!(made.args, job.built.args, "{}", job.name);
        assert_eq!(made.extension, job.built.extension, "{}", job.name);
        assert_eq!(made.mime, job.built.mime, "{}", job.name);
        assert_eq!(made.copy_only, job.built.copy_only, "{}", job.name);
    }
}

#[test]
fn extraction_frame_grab_and_replacement_are_the_web_apps_too() {
    let file: File = serde_json::from_str(GOLDEN).unwrap();
    for e in &file.extraction {
        let made = build_audio_extraction("in.mp4", &e.format);
        assert_eq!((made.args, made.extension, made.mime, made.copy_only), (e.built.args.clone(), e.built.extension.as_str(), e.built.mime.as_str(), e.built.copy_only), "{}", e.format);
    }
    for g in &file.grabs {
        assert_eq!(build_frame_grab("in.mp4", g.at).args, g.built.args, "{}", g.at);
    }
    let r = build_audio_replacement("v.mp4", "a.wav");
    assert_eq!(r.args, file.replacement.args);
    assert_eq!(r.extension, file.replacement.extension);
}

#[test]
fn to_fixed_rounds_as_javascript_does() {
    assert_eq!(to_fixed(0.125, 2), "0.13");
    assert_eq!(to_fixed(2.5, 0), "3");
    assert_eq!(to_fixed(1.005, 2), "1.00");
    assert_eq!(to_fixed(-0.0004, 3), "-0.000");
    assert_eq!(to_fixed(-0.0, 3), "0.000");
    assert_eq!(to_fixed(-3.25, 1), "-3.3");
    assert_eq!(to_fixed(0.5, 4), "0.5000");
    assert_eq!(to_fixed(59.9996, 3), "60.000");
}
