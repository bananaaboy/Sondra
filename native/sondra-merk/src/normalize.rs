//! An entry read from wherever it comes — the list in `localStorage`, a file, the Merkliste in Drive, a
//! project — made into one the rest can rely on (`normalize` in `merkliste.ts`). The same rules, in the
//! same order, including the odd ones: an unknown status is „watching“, an opening outside 10–600 s is
//! forgotten, a season length of 0 is unknown. What is not known is dropped, as there.

use serde_json::{Map, Value};

use crate::model::*;
use crate::progress::{clean_watched, season_progress, seasons_of, settle, with_parts};
use crate::urlinfo::{derive_link_title, parse_link_episode_info};

/// What a read needs from the outside: the time (for what has none) and a way to make an id.
pub struct Context {
    pub now: i64,
    /// Makes the tail of an id; the web app uses random base-36 text.
    pub random: Box<dyn FnMut() -> String>,
}

impl Context {
    /// A context with the real clock and a counter for the ids — enough for ids that only have to differ.
    pub fn system() -> Context {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        let mut counter = now as u64 ^ 0x9e37_79b9_7f4a_7c15;
        Context {
            now,
            random: Box::new(move || {
                counter = counter
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                to_base36(counter >> 20, 5)
            }),
        }
    }
}

fn to_base36(mut n: u64, width: usize) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 && out.len() < width {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    while out.len() < width {
        out.push(b'0');
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/* JS-shaped reading of a value ---------------------------------------------------------------- */

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

/// JS truthiness of a value (what `raw.title ||` and `raw.cover ?` ask).
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// JS `String(value)` for what can show up in a stored entry.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_i64() {
            Some(i) => i.to_string(),
            None => n.as_f64().map_or_else(String::new, |f| {
                if f.fract() == 0.0 && f.abs() < 1e21 {
                    format!("{}", f as i64)
                } else {
                    f.to_string()
                }
            }),
        },
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(items) => items
            .iter()
            .map(|i| {
                if i.is_null() {
                    String::new()
                } else {
                    js_string(i)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Math.round`: halves go up.
fn js_round(f: f64) -> i64 {
    (f + 0.5).floor() as i64
}

fn floor(f: f64) -> i64 {
    f.floor() as i64
}

fn string_of(v: Option<&Value>) -> Option<String> {
    truthy(v).then(|| js_string(v.unwrap()))
}

/* The small parts ----------------------------------------------------------------------------- */

pub fn normalize_frame(raw: Option<&Value>) -> Option<CoverFrame> {
    let obj = raw?.as_object()?;
    let (x, y, zoom) = (
        num(obj.get("x"))?,
        num(obj.get("y"))?,
        num(obj.get("zoom"))?,
    );
    let clamp = |v: f64, lo: f64, hi: f64| v.max(lo).min(hi);
    let frame = CoverFrame {
        x: clamp(x, 0.0, 100.0),
        y: clamp(y, 0.0, 100.0),
        zoom: clamp(zoom, 1.0, 3.0),
    };
    (!(frame.x == 50.0 && frame.y == 50.0 && frame.zoom == 1.0)).then_some(frame)
}

fn is_day(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

pub fn normalize_goal(raw: Option<&Value>, now: i64) -> Option<Goal> {
    let obj = raw?.as_object()?;
    let (season, episode) = (num(obj.get("season"))?, num(obj.get("episode"))?);
    if season < 0.0 || episode < 1.0 {
        return None;
    }
    Some(Goal {
        season: floor(season),
        episode: floor(episode),
        by: obj
            .get("by")
            .and_then(Value::as_str)
            .filter(|s| is_day(s))
            .map(str::to_string),
        set_at: num(obj.get("setAt")).map_or(now, |f| f as i64),
        count: num(obj.get("count")).filter(|c| *c > 0.0).map(js_round),
    })
}

const INTRO_TEXT_MAX: usize = 200 * 10 * 8;

fn normalize_intros(raw: &[Value]) -> Vec<Intro> {
    let kept: Vec<Intro> = raw
        .iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            let print = obj.get("print")?.as_str()?;
            let seconds = num(obj.get("seconds"))?;
            if print.is_empty() || print.encode_utf16().count() > INTRO_TEXT_MAX || seconds <= 0.0 {
                return None;
            }
            Some(Intro {
                print: print.to_string(),
                seconds: (seconds * 10.0 + 0.5).floor() / 10.0,
                // `Number(entry.learnedAt) || 0`
                learned_at: match obj.get("learnedAt") {
                    Some(Value::Number(n)) => n.as_f64().map_or(0, |f| f as i64),
                    Some(Value::String(s)) => s.trim().parse::<f64>().map_or(0, |f| f as i64),
                    _ => 0,
                },
            })
        })
        .collect();
    let skip = kept.len().saturating_sub(INTROS_KEPT);
    kept.into_iter().skip(skip).collect()
}

fn normalize_part(raw: &Map<String, Value>) -> Part {
    let cover = string_of(raw.get("cover"));
    let frame = if cover.is_some() {
        normalize_frame(raw.get("coverFrame"))
    } else {
        None
    };
    Part {
        episodes: num(raw.get("episodes")).filter(|e| *e > 0.0).map(floor),
        title: string_of(raw.get("title")),
        cover,
        cover_frame: frame,
    }
}

fn watched_of(raw: Option<&Value>) -> Vec<i64> {
    // Only whole numbers count, the rest of whatever was stored is dropped.
    raw.and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_f64)
                .filter(|f| f.fract() == 0.0)
                .map(|f| f as i64)
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_season(raw: &Map<String, Value>) -> Option<Season> {
    let number = num(raw.get("number"))?;
    let cover = string_of(raw.get("cover"));
    let frame = if cover.is_some() {
        normalize_frame(raw.get("coverFrame"))
    } else {
        None
    };
    let mut season = Season {
        number: floor(number).max(0),
        episodes: num(raw.get("episodes")).filter(|e| *e > 0.0).map(floor),
        watched: watched_of(raw.get("watched")),
        title: string_of(raw.get("title")),
        cover,
        cover_frame: frame,
        parts: None,
    };
    let parts: Vec<Part> = raw
        .get("parts")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|p| p.as_object().map(normalize_part))
                .collect()
        })
        .unwrap_or_default();
    if parts.len() >= 2 {
        // `withParts` cleans the marks against the new length itself.
        Some(with_parts(&season, &parts))
    } else {
        season.watched = clean_watched(&season.watched, season.episodes);
        Some(season)
    }
}

fn normalize_tags(raw: &[Value]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for tag in raw {
        let Some(text) = tag.as_str() else { continue };
        if text.trim().is_empty() {
            continue;
        }
        let cleaned = text.trim().trim_start_matches('#').to_string();
        if !seen.contains(&cleaned) {
            seen.push(cleaned);
        }
    }
    seen
}

fn normalize_history(raw: &[Value], ctx: &mut Context) -> Vec<HistoryEntry> {
    raw.iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            let (season, episode) = (num(obj.get("season"))?, num(obj.get("episode"))?);
            Some(HistoryEntry {
                id: string_of(obj.get("id"))
                    .unwrap_or_else(|| format!("wh-{}-{}", ctx.now, (ctx.random)())),
                season: floor(season).max(0),
                episode: floor(episode).max(1),
                at: num(obj.get("at")).map_or(ctx.now, |f| f as i64),
            })
        })
        .collect()
}

/// `Math.max(low, Math.floor(Number(x) || 1))`: a zero, a missing number and text that is none are all 1.
fn number_or_one(v: Option<&Value>) -> i64 {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    };
    if n == 0.0 || n.is_nan() {
        1
    } else {
        floor(n)
    }
}

fn normalize_online(raw: &Value, ctx: &Context) -> Option<Online> {
    let truthy_object = matches!(raw, Value::Object(_) | Value::Array(_));
    if !truthy_object {
        return None;
    }
    let obj = raw.as_object();
    let get = |k: &str| obj.and_then(|o| o.get(k));
    Some(Online {
        max_season: number_or_one(get("maxSeason")).max(0),
        max_episode: number_or_one(get("maxEpisode")).max(1),
        checked_at: num(get("checkedAt")).map_or(ctx.now, |f| f as i64),
        has_new: Some(truthy(get("hasNew"))),
    })
}

/* The entry ----------------------------------------------------------------------------------- */

/// An entry read from `raw`, made whole: what is missing gets its default, what is out of range is put
/// back in it, and what the entry cannot be without (an id) is made.
pub fn normalize(raw: &Value, ctx: &mut Context) -> Item {
    let empty = Map::new();
    let obj = raw.as_object().unwrap_or(&empty);
    let url = string_of(obj.get("url")).unwrap_or_default();
    let info = parse_link_episode_info(&url);

    let season = num(obj.get("season")).map_or(info.season, floor);
    let episode = match obj.get("episode") {
        Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_f64().map(floor),
        _ => Some(info.episode.unwrap_or(1)),
    };
    let seasons: Option<Vec<Season>> = obj.get("seasons").and_then(Value::as_array).map(|list| {
        list.iter()
            .filter_map(|s| s.as_object().and_then(normalize_season))
            .collect()
    });

    let status = obj
        .get("status")
        .and_then(Value::as_str)
        .and_then(Status::parse)
        .unwrap_or(Status::Watching);
    let cover = string_of(obj.get("cover"));
    let cover_frame = if cover.is_some() {
        normalize_frame(obj.get("coverFrame"))
    } else {
        None
    };

    let mut item = Item {
        id: string_of(obj.get("id")).unwrap_or_else(|| {
            let tail = (ctx.random)();
            format!("merk-{}-{}", ctx.now, tail)
        }),
        title: string_of(obj.get("title")).unwrap_or_else(|| {
            if url.is_empty() {
                "Ohne Namen".into()
            } else {
                derive_link_title(&url)
            }
        }),
        url,
        language: string_of(obj.get("language")).unwrap_or_else(|| "auto".into()),
        season,
        episode,
        mode: if obj.get("mode").and_then(Value::as_str) == Some("audio") {
            "audio".into()
        } else {
            "video".into()
        },
        audio_format: string_of(obj.get("audioFormat")).unwrap_or_else(|| "mp3".into()),
        video_pref: string_of(obj.get("videoPref")).unwrap_or_else(|| "untouched".into()),
        audio_pref: string_of(obj.get("audioPref")).unwrap_or_else(|| "high".into()),
        auto_transcribe: truthy(obj.get("autoTranscribe")),
        updated_at: match num(obj.get("updatedAt")) {
            Some(f) if f != 0.0 => f as i64,
            _ => ctx.now,
        },
        status,
        last_opened_at: num(obj.get("lastOpenedAt")).map(|f| f as i64),
        seasons: seasons.clone(),
        cover,
        cover_frame,
        tile_format: (obj.get("tileFormat").and_then(Value::as_str) == Some("manga"))
            .then(|| "manga".to_string()),
        notes: string_of(obj.get("notes")),
        rating: num(obj.get("rating")).map(|r| js_round(r).clamp(0, 5)),
        episode_duration: num(obj.get("episodeDuration"))
            .filter(|d| *d > 0.0)
            .map(js_round),
        film_duration: num(obj.get("filmDuration"))
            .filter(|d| *d > 0.0)
            .map(js_round),
        opening: num(obj.get("opening"))
            .filter(|o| *o >= OPENING_MIN as f64 && *o <= OPENING_MAX as f64)
            .map(js_round),
        intros: obj
            .get("intros")
            .and_then(Value::as_array)
            .map(|list| normalize_intros(list))
            .filter(|list| !list.is_empty()),
        durations: match obj.get("durations") {
            Some(Value::Object(map)) => Some(map.clone()),
            // An array is an object to JS, and survives as one; here it has no keys worth keeping.
            _ => None,
        },
        goal: normalize_goal(obj.get("goal"), ctx.now),
        tags: obj
            .get("tags")
            .and_then(Value::as_array)
            .map(|list| normalize_tags(list)),
        history: obj
            .get("history")
            .and_then(Value::as_array)
            .map(|list| normalize_history(list, ctx)),
        online_available: obj
            .get("onlineAvailable")
            .and_then(|v| normalize_online(v, ctx)),
    };

    // A position past the end of its season — saved by „Alle gesehen“ before it knew better, or left
    // there by a count made smaller — moves to the first episode not seen. A „Fertig“ set by hand stays.
    let length = seasons
        .as_ref()
        .and_then(|list| list.iter().find(|s| s.number == season))
        .and_then(|s| s.episodes);
    if let (Some(list), Some(e), Some(len)) = (&seasons, episode, length) {
        if e > len {
            let settled = settle(&item, list, season);
            item.season = settled.season;
            item.episode = settled.episode;
            if settled.status == Status::Done {
                item.status = Status::Done;
            }
        }
    }
    let _ = (season_progress, seasons_of);
    item
}
