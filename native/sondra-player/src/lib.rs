//! The rules of the media player, as pure functions: what kind of file something is, when „Vorspann
//! überspringen“ and „Nächste Folge“ are offered, how the sleep timer fades, how the settings, the place
//! a file was left at and the bookmarks are read and kept, and the clock a film shows. All of it the web
//! app's `src/lib/player.ts`, answer for answer (`npm run native:golden` writes the table it is held to).
//! Nothing here plays anything or touches a file: what is remembered is handed in and out as JSON text, so
//! the program decides where it lives.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/* Kinds of file ------------------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Video,
    Audio,
}

static VIDEO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ts|mts|m2ts|mpg|mpeg|vob|3gp|ogv|asf)$").unwrap());
static AUDIO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aiff?|ac3|mka|amr|caf)$").unwrap());
static SUBTITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(srt|vtt)$").unwrap());
static EXTENSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[^.]+$").unwrap());

/// What the player does with a file: watch it, listen to it, or nothing. A media type wins over a name.
pub fn player_kind(name: &str, media_type: &str) -> Option<Kind> {
    if media_type.starts_with("video/") || VIDEO.is_match(name) {
        return Some(Kind::Video);
    }
    if media_type.starts_with("audio/") || AUDIO.is_match(name) {
        return Some(Kind::Audio);
    }
    None
}

pub fn is_subtitle_file(name: &str) -> bool {
    SUBTITLE.is_match(name)
}

/// The name without its extension, lower case — how a film finds its subtitles.
pub fn stem_of(name: &str) -> String {
    EXTENSION.replace(name, "").to_lowercase()
}

/// SubRip to WebVTT: a header, and dots instead of commas in the times.
pub fn srt_to_vtt(text: &str) -> String {
    static TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{1,2}):(\d{2}):(\d{2}),(\d{3})").unwrap());
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let body = TIME.replace_all(&text, |c: &regex::Captures| format!("{:0>2}:{}:{}.{}", &c[1], &c[2], &c[3], &c[4])).into_owned();
    if body.trim_start().starts_with("WEBVTT") {
        body
    } else {
        format!("WEBVTT\n\n{}\n", body.trim())
    }
}

/* What is offered when ------------------------------------------------------------------------ */

/// Shorter than this is a clip, not an episode: no opening, no next episode offered.
const EPISODE_MIN: f64 = 240.0;
/// An opening comes within the first minutes, after a cold open at most.
const OPENING_WINDOW: f64 = 360.0;

/// Whether „Vorspann überspringen“ is on offer: in the first six minutes of an episode (a third of a short
/// one), while the jump still lands before the last minute.
pub fn opening_offered(time: f64, duration: f64, opening: f64) -> bool {
    if !(duration >= EPISODE_MIN) || !(time >= 0.0) {
        return false;
    }
    time < OPENING_WINDOW.min(duration / 3.0) && time + opening < duration - 60.0
}

/// Whether „Nächste Folge“ is on offer: in the credits — the last 2:30, an eighth of a short episode.
pub fn next_offered(time: f64, duration: f64) -> bool {
    if !(duration >= EPISODE_MIN) {
        return false;
    }
    let left = duration - time;
    left > 0.5 && left <= 150.0_f64.min(duration / 8.0)
}

/// The volume a running-out sleep timer leaves: all of it, then down over the last ten seconds.
pub fn sleep_fade(left_ms: f64) -> f64 {
    (left_ms / 10_000.0).clamp(0.0, 1.0)
}

/// „1:30“ for 90 seconds.
pub fn minutes_seconds(seconds: f64) -> String {
    let rounded = (seconds % 60.0 + 0.5).floor();
    format!("{}:{:0>2}", (seconds / 60.0).floor(), rounded)
}

/// h:mm:ss or m:ss — a film's clock, not the editor's centiseconds.
pub fn clock(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "0:00".into();
    }
    let total = seconds.floor() as i64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// „Normal“ at 1, else „1,5×“.
pub fn rate_label(rate: f64) -> String {
    if rate == 1.0 {
        "Normal".into()
    } else {
        format!("{}×", number_text(rate).replace('.', ","))
    }
}

/// A number as JavaScript prints it, for the plain cases here (whole, or a short decimal).
fn number_text(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

pub const RATES: [f64; 9] = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 3.0];
pub const SKIPS: [f64; 4] = [5.0, 10.0, 15.0, 30.0];
pub const BOOSTS: [f64; 4] = [1.0, 1.5, 2.0, 3.0];
/// Opening lengths to choose from, in seconds: most anime openings run 1:25 to 1:30.
pub const OPENINGS: [f64; 7] = [60.0, 80.0, 85.0, 90.0, 100.0, 120.0, 150.0];
/// Sleep timer lengths, in minutes.
pub const SLEEPS: [i64; 3] = [15, 30, 60];
/// Heights a film can be watched at below its own.
pub const QUALITY_STEPS: [i64; 6] = [2160, 1440, 1080, 720, 480, 360];

/// A preset of the equalizer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EqPreset {
    pub id: &'static str,
    pub name: &'static str,
    pub bass_boost: f64,
    pub eq_low: f64,
    pub eq_mid: f64,
    pub eq_high: f64,
}

pub const EQ_PRESETS: [EqPreset; 6] = [
    EqPreset { id: "flat", name: "Linear", bass_boost: 0.0, eq_low: 0.0, eq_mid: 0.0, eq_high: 0.0 },
    EqPreset { id: "bass", name: "Bass-Boost", bass_boost: 6.0, eq_low: 5.0, eq_mid: 0.0, eq_high: 1.0 },
    EqPreset { id: "vocal", name: "Vocal / Podcast", bass_boost: 0.0, eq_low: -2.0, eq_mid: 4.0, eq_high: 2.0 },
    EqPreset { id: "electronic", name: "Club / Dance", bass_boost: 4.0, eq_low: 4.0, eq_mid: -2.0, eq_high: 4.0 },
    EqPreset { id: "rock", name: "Rock / Metal", bass_boost: 2.0, eq_low: 4.0, eq_mid: 2.0, eq_high: 3.0 },
    EqPreset { id: "acoustic", name: "Akustik / Jazz", bass_boost: 0.0, eq_low: 2.0, eq_mid: 1.0, eq_high: 3.0 },
];

/* Settings ------------------------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionSize {
    Klein,
    Mittel,
    Gross,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    Contain,
    Cover,
    Fill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    Aus,
    Titel,
    Liste,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VisualizerMode {
    Bars,
    Wave,
    Radial,
}

/// Everything the settings menu holds. Kept on this device, never needed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub volume: f64,
    pub muted: bool,
    pub rate: f64,
    pub caption_size: CaptionSize,
    pub caption_background: bool,
    pub fit: Fit,
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub mirror: bool,
    /// Gain above the element's own 100 %.
    pub boost: f64,
    /// Quiet passages up, loud ones down — for watching at night.
    pub night: bool,
    pub bass_boost: f64,
    pub eq_low: f64,
    pub eq_mid: f64,
    pub eq_high: f64,
    pub eq_band1: f64,
    pub eq_band2: f64,
    pub eq_band3: f64,
    pub eq_band4: f64,
    pub eq_band5: f64,
    pub eq_enabled: bool,
    pub eq_preset: String,
    pub karaoke: bool,
    pub visualizer: bool,
    pub visualizer_mode: VisualizerMode,
    pub auto_next: bool,
    pub repeat: Repeat,
    pub skip: f64,
    /// A file named like an episode on the Merkliste is ticked off at 90 %.
    pub merkliste: bool,
    /// „Vorspann überspringen“ and „Nächste Folge“ offered over an episode.
    pub skip_opening: bool,
    /// How far „Vorspann überspringen“ jumps, for files no series on the Merkliste names.
    pub opening: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            volume: 1.0,
            muted: false,
            rate: 1.0,
            caption_size: CaptionSize::Mittel,
            caption_background: true,
            fit: Fit::Contain,
            brightness: 1.0,
            contrast: 1.0,
            saturation: 1.0,
            mirror: false,
            boost: 1.0,
            night: false,
            bass_boost: 0.0,
            eq_low: 0.0,
            eq_mid: 0.0,
            eq_high: 0.0,
            eq_band1: 0.0,
            eq_band2: 0.0,
            eq_band3: 0.0,
            eq_band4: 0.0,
            eq_band5: 0.0,
            eq_enabled: true,
            eq_preset: "Flat".into(),
            karaoke: false,
            visualizer: true,
            visualizer_mode: VisualizerMode::Bars,
            auto_next: true,
            repeat: Repeat::Aus,
            skip: 10.0,
            merkliste: true,
            skip_opening: true,
            opening: 90.0,
        }
    }
}

/// A number within bounds, or the fallback when it is no number.
fn within(value: Option<&Value>, low: f64, high: f64, fallback: f64) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(v) if v.is_finite() => v.clamp(low, high),
        _ => fallback,
    }
}

/// One of the listed numbers, or the fallback.
fn one_of(value: Option<&Value>, options: &[f64], fallback: f64) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(v) if options.contains(&v) => v,
        _ => fallback,
    }
}

fn word<T: Copy>(value: Option<&Value>, options: &[(&str, T)], fallback: T) -> T {
    value.and_then(Value::as_str).and_then(|s| options.iter().find(|(name, _)| *name == s).map(|(_, v)| *v)).unwrap_or(fallback)
}

/// A key is „there“ for `??` when it is neither missing nor null.
fn present<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    map.get(key).filter(|v| !v.is_null())
}

impl Settings {
    /// What was kept, made whole: every value checked, what is wrong or missing replaced by the default.
    /// Text that is no JSON, or no object, gives the defaults.
    pub fn from_json(text: Option<&str>) -> Settings {
        let Some(Ok(saved)) = text.map(serde_json::from_str::<Value>) else { return Settings::default() };
        Settings::from_value(&saved)
    }

    pub fn from_value(saved: &Value) -> Settings {
        let d = Settings::default();
        let empty = Map::new();
        let map = match saved {
            Value::Object(m) => m,
            Value::Array(_) => &empty,
            _ => return d,
        };
        let get = |key: &str| map.get(key);
        let flag_on = |key: &str| get(key) == Some(&Value::Bool(true));
        let flag_not_off = |key: &str| get(key) != Some(&Value::Bool(false));
        Settings {
            volume: within(get("volume"), 0.0, 1.0, d.volume),
            muted: flag_on("muted"),
            rate: one_of(get("rate"), &RATES, d.rate),
            caption_size: word(get("captionSize"), &[("klein", CaptionSize::Klein), ("mittel", CaptionSize::Mittel), ("gross", CaptionSize::Gross)], d.caption_size),
            caption_background: flag_not_off("captionBackground"),
            fit: word(get("fit"), &[("contain", Fit::Contain), ("cover", Fit::Cover), ("fill", Fit::Fill)], d.fit),
            brightness: within(get("brightness"), 0.5, 1.5, d.brightness),
            contrast: within(get("contrast"), 0.5, 1.5, d.contrast),
            saturation: within(get("saturation"), 0.0, 2.0, d.saturation),
            mirror: flag_on("mirror"),
            boost: one_of(get("boost"), &BOOSTS, d.boost),
            night: flag_on("night"),
            bass_boost: within(get("bassBoost"), 0.0, 12.0, d.bass_boost),
            eq_low: within(get("eqLow"), -12.0, 12.0, d.eq_low),
            eq_mid: within(get("eqMid"), -12.0, 12.0, d.eq_mid),
            eq_high: within(get("eqHigh"), -12.0, 12.0, d.eq_high),
            // Five bands came after three: a band not saved takes the value of the old one that covered it.
            eq_band1: within(present(map, "eqBand1").or(get("eqLow")), -12.0, 12.0, d.eq_band1),
            eq_band2: within(get("eqBand2"), -12.0, 12.0, d.eq_band2),
            eq_band3: within(present(map, "eqBand3").or(get("eqMid")), -12.0, 12.0, d.eq_band3),
            eq_band4: within(get("eqBand4"), -12.0, 12.0, d.eq_band4),
            eq_band5: within(present(map, "eqBand5").or(get("eqHigh")), -12.0, 12.0, d.eq_band5),
            eq_enabled: flag_not_off("eqEnabled"),
            eq_preset: get("eqPreset").and_then(Value::as_str).map_or(d.eq_preset.clone(), str::to_string),
            karaoke: flag_on("karaoke"),
            visualizer: flag_not_off("visualizer"),
            visualizer_mode: word(get("visualizerMode"), &[("bars", VisualizerMode::Bars), ("wave", VisualizerMode::Wave), ("radial", VisualizerMode::Radial)], d.visualizer_mode),
            auto_next: flag_not_off("autoNext"),
            repeat: word(get("repeat"), &[("aus", Repeat::Aus), ("titel", Repeat::Titel), ("liste", Repeat::Liste)], d.repeat),
            skip: one_of(get("skip"), &SKIPS, d.skip),
            merkliste: flag_not_off("merkliste"),
            skip_opening: flag_not_off("skipOpening"),
            opening: one_of(get("opening"), &OPENINGS, d.opening),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/* A table that keeps its order ---------------------------------------------------------------- */

/// A JSON object read and written in the order of its keys, the way an object keeps them: what is kept
/// „newest N“ is the end of it.
#[derive(Default, Debug, Clone, PartialEq)]
struct Table(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Table {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Table;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<Table, A::Error> {
                let mut out: Vec<(String, Value)> = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    match out.iter_mut().find(|(name, _)| *name == k) {
                        Some(slot) => slot.1 = v,
                        None => out.push((k, v)),
                    }
                }
                Ok(Table(out))
            }
        }
        d.deserialize_map(V)
    }
}

impl Table {
    fn read(text: Option<&str>) -> Table {
        text.and_then(|t| serde_json::from_str::<Table>(t).ok()).unwrap_or_default()
    }

    fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn without(mut self, key: &str) -> Table {
        self.0.retain(|(k, _)| k != key);
        self
    }

    /// Only the newest `keep` entries stay.
    fn newest(mut self, keep: usize) -> Table {
        let over = self.0.len().saturating_sub(keep);
        self.0.drain(..over);
        self
    }

    fn to_json(&self) -> String {
        let mut out = String::from("{");
        for (i, (k, v)) in self.0.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&serde_json::to_string(k).unwrap_or_default());
            out.push(':');
            out.push_str(&serde_json::to_string(v).unwrap_or_default());
        }
        out.push('}');
        out
    }
}

/// Files are known by name and size, like „Weiter bei“.
fn key_of(name: &str, size: u64) -> String {
    format!("{name}|{size}")
}

/// Where a file was left, when that is worth coming back to.
pub fn remembered_place(table_json: Option<&str>, name: &str, size: u64) -> Option<f64> {
    Table::read(table_json).get(&key_of(name, size)).and_then(Value::as_f64).filter(|s| *s > 0.0)
}

/// Remembers where a file was left (`None` forgets it); the newest fifty stay. Returns the text to keep.
pub fn remember_place(table_json: Option<&str>, name: &str, size: u64, seconds: Option<f64>) -> String {
    let key = key_of(name, size);
    let mut table = Table::read(table_json).without(&key);
    if let Some(seconds) = seconds {
        let rounded = (seconds + 0.5).floor();
        table.0.push((key, serde_json::Number::from_f64(rounded).map_or(Value::Null, |n| if rounded.abs() < 1e15 { Value::from(rounded as i64) } else { Value::Number(n) })));
    }
    table.newest(50).to_json()
}

/* Bookmarks ----------------------------------------------------------------------------------- */

/// A place in a file worth finding again, with a name of one's own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mark {
    pub id: String,
    /// Seconds into the file.
    pub at: f64,
    /// Empty until named; shown as „Lesezeichen n“ until then.
    pub label: String,
}

/// Two marks closer than this are one place.
const MARK_GAP: f64 = 1.0;

/// JavaScript's `String(value)` for what an id may be.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(items) => items.iter().map(|v| if v.is_null() { String::new() } else { js_string(v) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// An id that is there, in JavaScript's sense: not missing, null, false, 0, NaN or empty.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The first `max` UTF-16 units of a text, as `String.prototype.slice(0, max)` takes them.
fn slice_units(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for ch in text.chars() {
        units += ch.len_utf16();
        if units > max {
            break;
        }
        out.push(ch);
    }
    out
}

/// Marks as they are kept: valid ones only, in order of time.
pub fn clean_marks(raw: &Value) -> Vec<Mark> {
    let Value::Array(items) = raw else { return Vec::new() };
    let mut marks: Vec<Mark> = items
        .iter()
        .filter_map(|item| {
            let at = item.get("at").and_then(Value::as_f64).filter(|a| a.is_finite() && *a >= 0.0)?;
            let id = match item.get("id").filter(|v| truthy(v)) {
                Some(v) => js_string(v),
                None => format!("m{}", (at * 1000.0 + 0.5).floor() as i64),
            };
            let label = item.get("label").and_then(Value::as_str).map_or(String::new(), |l| slice_units(l, 120));
            Some(Mark { id, at, label })
        })
        .collect();
    marks.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
    marks
}

/// A mark at `at`, unless one is already there; the list stays in order. The id is made from the time
/// (in base 36) and four characters of luck, which the caller brings.
pub fn with_mark(marks: &[Mark], at: f64, now_ms: u64, luck: &str) -> (Vec<Mark>, Option<Mark>) {
    let rounded = ((at * 10.0 + 0.5).floor() / 10.0).max(0.0);
    if marks.iter().any(|m| (m.at - rounded).abs() < MARK_GAP) {
        return (marks.to_vec(), None);
    }
    let added = Mark { id: format!("m{}{}", base36(now_ms), luck.chars().take(4).collect::<String>()), at: rounded, label: String::new() };
    let mut all = marks.to_vec();
    all.push(added.clone());
    let list = clean_marks(&serde_json::to_value(all).unwrap_or(Value::Null));
    (list, Some(added))
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

/// The mark before or after `time` — a step back lands on the previous one, not the one just passed by a
/// second.
pub fn neighbour_mark(marks: &[Mark], time: f64, forward: bool) -> Option<&Mark> {
    if forward {
        marks.iter().find(|m| m.at > time + 0.5)
    } else {
        marks.iter().rev().find(|m| m.at < time - 2.0)
    }
}

/// Its own name, or „Lesezeichen n“ by its place in the list.
pub fn mark_name(marks: &[Mark], index: usize) -> String {
    let label = marks.get(index).map_or("", |m| m.label.trim());
    if label.is_empty() {
        format!("Lesezeichen {}", index + 1)
    } else {
        label.to_string()
    }
}

/// The marks as chapters, the way YouTube reads them from a description: one line each, the first at 0:00
/// — a beginning is added when no mark is there.
pub fn chapters_text(marks: &[Mark]) -> String {
    let sorted = clean_marks(&serde_json::to_value(marks).unwrap_or(Value::Null));
    let mut lines: Vec<String> = sorted
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let label = m.label.trim();
            format!("{} {}", clock(m.at), if label.is_empty() { format!("Kapitel {}", i + 1) } else { label.to_string() })
        })
        .collect();
    if sorted.first().is_none_or(|m| m.at >= 1.0) {
        lines.insert(0, "0:00 Anfang".into());
    } else {
        let label = sorted[0].label.trim();
        lines[0] = format!("0:00 {}", if label.is_empty() { "Kapitel 1" } else { label });
    }
    lines.join("\n")
}

/// The bookmarks of a file, by its name and size, from the text they are kept in.
pub fn marks_for(all_json: Option<&str>, name: &str, size: u64) -> Vec<Mark> {
    clean_marks(Table::read(all_json).get(&key_of(name, size)).unwrap_or(&Value::Null))
}

/// Keeps a file's bookmarks; an empty list forgets the file. The newest hundred files stay.
pub fn save_marks(all_json: Option<&str>, name: &str, size: u64, marks: &[Mark]) -> String {
    let key = key_of(name, size);
    let mut table = Table::read(all_json).without(&key);
    if !marks.is_empty() {
        let cleaned = clean_marks(&serde_json::to_value(marks).unwrap_or(Value::Null));
        table.0.push((key, serde_json::to_value(cleaned).unwrap_or(Value::Null)));
    }
    table.newest(100).to_json()
}
