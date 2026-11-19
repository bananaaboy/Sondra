//! Sharing the Merkliste, read-only (`src/lib/merkShare.ts`): the list goes into the address itself —
//! packed small, deflated and made URL-safe — so nothing is uploaded and nothing is kept on a server;
//! whoever opens the link sees it in their own program and may add it to their own list. Titles, status,
//! rating, how far one is and, if asked for, a small picture of each cover: not the addresses the
//! episodes come from, not notes.
//!
//! A link has only so much room, so a list that does not fit travels as several links, each with its place
//! in the whole, which the other side gathers. The same bytes are also a file, `.sondra-liste`.
//!
//! What is packed here is byte for byte what the web app packs, and what the web app packs is read here:
//! a link goes either way. (The deflated text may differ — two compressors, two answers — and means the
//! same.)

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::cover::{valid_thumb, THUMB_MAX};
use crate::model::{Item, Status};
use crate::progress::item_progress;

/// The hash a shared list travels in — as short as it can be.
pub const SHARE_PREFIX: &str = "#g=";
/// What the first links were called; they open as before.
const LEGACY_PREFIX: &str = "#geteilt=";
/// One link up to this long; chats, mail programs and some messengers cut off what is longer.
pub const LINK_MAX: usize = 2000;
/// What a link made for a QR code may hold, so the code stays easy to read off a screen.
pub const QR_LINK_MAX: usize = 1100;
/// More parts than this is not a thing to send in messages: the file is offered.
pub const MAX_PARTS: usize = 40;
const MAX_ITEMS: usize = 500;
const MAX_TITLE: usize = 120;
const MAX_NAME: usize = 40;
/// What a link or file may unpack to: more is not a list, it is a bomb.
const MAX_PAYLOAD: usize = 16 * 1024 * 1024;
const STATUSES: [Status; 5] = [
    Status::Watching,
    Status::Later,
    Status::Paused,
    Status::Done,
    Status::Dropped,
];

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SharedItem {
    pub title: String,
    pub status: Option<Status>,
    pub rating: Option<i64>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// Episodes seen, as a number.
    pub seen: Option<i64>,
    /// The picture of its cover, as `cover` makes and reads it.
    pub thumb: Option<Vec<u8>>,
    pub manga: bool,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SharedList {
    /// Whose list: a name the sharer typed, short.
    pub name: String,
    pub items: Vec<SharedItem>,
}

/// The first `max` UTF-16 units of a text, as JS `slice(0, max)` takes them (a pair is never split).
fn slice16(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        used += ch.len_utf16();
        if used > max {
            break;
        }
        out.push(ch);
    }
    out
}

fn is_control(ch: char) -> bool {
    ch <= '\u{1f}' || ch == '\u{7f}'
}

fn clean(text: &str, max: usize) -> String {
    let spaced: String = text
        .chars()
        .map(|c| if is_control(c) { ' ' } else { c })
        .collect();
    slice16(spaced.trim(), max)
}

/// `whole`: a number from 0 to `max`, rounded; nothing otherwise.
fn whole(value: Option<f64>, max: f64) -> Option<i64> {
    value
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= max)
        .map(|v| (v + 0.5).floor() as i64)
}

/// The list to share: with or without how far each is, and with the pictures it has.
pub fn shareable_list(
    items: &[Item],
    name: &str,
    progress: bool,
    thumbs: &HashMap<String, Vec<u8>>,
) -> SharedList {
    SharedList {
        name: slice16(name.trim(), MAX_NAME),
        items: items
            .iter()
            .take(MAX_ITEMS)
            .map(|item| {
                let thumb = thumbs.get(&item.id);
                SharedItem {
                    title: slice16(&item.title, MAX_TITLE),
                    status: (item.status != Status::Watching).then_some(item.status),
                    rating: item.rating.filter(|r| progress && *r > 0),
                    season: progress.then_some(item.season),
                    episode: if progress { item.episode } else { None },
                    seen: progress.then(|| item_progress(item).watched),
                    thumb: thumb.cloned(),
                    manga: thumb.is_some() && item.tile_format.as_deref() == Some("manga"),
                }
            })
            .collect(),
    }
}

/* Packing ------------------------------------------------------------------------------------- */

#[derive(Default)]
struct Writer(Vec<u8>);

impl Writer {
    fn byte(&mut self, value: u8) {
        self.0.push(value);
    }
    fn varint(&mut self, value: i64) {
        let mut rest = value.max(0) as u64;
        while rest >= 0x80 {
            self.0.push((rest % 0x80) as u8 | 0x80);
            rest /= 0x80;
        }
        self.0.push(rest as u8);
    }
    fn raw(&mut self, data: &[u8]) {
        self.0.extend_from_slice(data);
    }
    fn text(&mut self, value: &str) {
        self.varint(value.len() as i64);
        self.raw(value.as_bytes());
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

type Fail = ();

impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8, Fail> {
        let b = *self.bytes.get(self.at).ok_or(())?;
        self.at += 1;
        Ok(b)
    }
    fn varint(&mut self) -> Result<i64, Fail> {
        let mut value = 0i64;
        for step in 0..5 {
            let next = self.byte()?;
            value += i64::from(next & 0x7f) * 0x80i64.pow(step);
            if next & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(())
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8], Fail> {
        let end = self
            .at
            .checked_add(count)
            .filter(|e| *e <= self.bytes.len())
            .ok_or(())?;
        let part = &self.bytes[self.at..end];
        self.at = end;
        Ok(part)
    }
    fn text(&mut self, max_bytes: usize) -> Result<String, Fail> {
        let length = self.varint()? as usize;
        if length > max_bytes {
            return Err(());
        }
        // Not valid UTF-8 reads as replacement characters, as `TextDecoder` does.
        Ok(String::from_utf8_lossy(self.take(length)?).into_owned())
    }
}

/// The list as bytes, before deflating — in columns, not by entry: all the titles, then every entry's
/// flags, then every rating, then the numbers that differ from the usual, then the pictures. Alike bytes
/// side by side is what deflate shrinks best, and what is the usual (Staffel 1, Folge 1, nothing seen, Am
/// Schauen, no rating, no picture) costs nothing but its flag.
pub fn pack_list(list: &SharedList) -> Vec<u8> {
    let items: Vec<&SharedItem> = list.items.iter().take(MAX_ITEMS).collect();
    // With progress left out, the three fields are missing everywhere; with it, a missing one is the usual.
    let progress = items
        .iter()
        .any(|i| i.season.is_some() || i.episode.is_some() || i.seen.is_some());
    let mut out = Writer::default();
    out.byte(2);
    out.byte(u8::from(progress));
    out.text(&slice16(&list.name, MAX_NAME));
    out.varint(items.len() as i64);
    let titles: Vec<String> = items
        .iter()
        .map(|i| {
            let spaced: String = i
                .title
                .chars()
                .map(|c| if is_control(c) { ' ' } else { c })
                .collect();
            slice16(&spaced, MAX_TITLE)
        })
        .collect();
    out.text(&titles.join("\n"));
    let (mut flags, mut ratings) = (Vec::new(), Vec::new());
    let (mut seasons, mut episodes, mut seen, mut thumbs) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for item in &items {
        let status = STATUSES
            .iter()
            .position(|s| *s == item.status.unwrap_or(Status::Watching))
            .unwrap_or(0) as u8;
        let season = if progress {
            whole(item.season.map(|v| v as f64), 1000.0).unwrap_or(1)
        } else {
            1
        };
        let episode = if progress {
            whole(item.episode.map(|v| v as f64), 10_000.0).unwrap_or(1)
        } else {
            1
        };
        let watched = if progress {
            whole(item.seen.map(|v| v as f64), 100_000.0).unwrap_or(0)
        } else {
            0
        };
        let thumb = item.thumb.as_ref().filter(|t| valid_thumb(t));
        flags.push(
            u8::from(season != 1)
                | (u8::from(episode != 1) << 1)
                | (u8::from(watched != 0) << 2)
                | (u8::from(thumb.is_some()) << 3)
                | (u8::from(item.manga) << 4)
                | (status << 5),
        );
        ratings.push(whole(item.rating.map(|v| v as f64), 5.0).unwrap_or(0) as u8);
        if season != 1 {
            seasons.push(season);
        }
        if episode != 1 {
            episodes.push(episode);
        }
        if watched != 0 {
            seen.push(watched);
        }
        if let Some(t) = thumb {
            thumbs.push(t.clone());
        }
    }
    out.raw(&flags);
    out.raw(&ratings);
    for v in seasons.iter().chain(&episodes).chain(&seen) {
        out.varint(*v);
    }
    for t in &thumbs {
        out.varint(t.len() as i64);
        out.raw(t);
    }
    out.0
}

/// A list from the old JSON packing (v1), checked field by field.
fn from_json(text: &str) -> Option<SharedList> {
    let raw: Value = serde_json::from_str(text).ok()?;
    if raw.get("v")? != &Value::from(1) {
        return None;
    }
    let list = raw.get("items")?.as_array()?;
    let mut items = Vec::new();
    for entry in list.iter().take(MAX_ITEMS) {
        let Some(title) = entry.get("title").and_then(Value::as_str) else {
            continue;
        };
        let title = clean(title, MAX_TITLE);
        if title.is_empty() {
            continue;
        }
        let status = entry
            .get("status")
            .and_then(Value::as_str)
            .and_then(Status::parse);
        let num = |k: &str| entry.get(k).and_then(Value::as_f64);
        items.push(SharedItem {
            title,
            status,
            rating: whole(num("rating"), 5.0).filter(|r| *r != 0),
            season: whole(num("season"), 1000.0),
            episode: whole(num("episode"), 10_000.0),
            seen: whole(num("seen"), 100_000.0),
            thumb: None,
            manga: false,
        });
    }
    Some(SharedList {
        name: raw
            .get("name")
            .and_then(Value::as_str)
            .map(|n| clean(n, MAX_NAME))
            .unwrap_or_default(),
        items,
    })
}

/// A list out of bytes, believed only as far as it is plain data: the sizes are capped, every field is
/// checked, a picture must be one, and anything else is thrown away. `None` when it is not a list at all.
pub fn unpack_list(bytes: &[u8]) -> Option<SharedList> {
    if bytes.first() == Some(&0x7b) {
        return from_json(&String::from_utf8_lossy(bytes));
    }
    unpack_binary(bytes).ok().flatten()
}

fn unpack_binary(bytes: &[u8]) -> Result<Option<SharedList>, Fail> {
    if bytes.first() != Some(&2) {
        return Ok(None);
    }
    let mut read = Reader { bytes, at: 1 };
    let progress = read.byte()? & 1 == 1;
    let name = clean(&read.text(MAX_NAME * 4)?, MAX_NAME);
    let count = read.varint()? as usize;
    if count > MAX_ITEMS {
        return Ok(None);
    }
    let block = read.text(MAX_ITEMS * (MAX_TITLE * 4 + 1))?;
    let titles: Vec<&str> = if count == 0 {
        vec![]
    } else {
        block.split('\n').collect()
    };
    if titles.len() != count || (count == 0 && !block.is_empty()) {
        return Ok(None);
    }
    let flags = read.take(count)?.to_vec();
    let ratings = read.take(count)?.to_vec();
    // The numbers that differ from the usual, column by column, in the order of the flags.
    let mut column = |bit: u8, max: f64| -> Result<HashMap<usize, Option<i64>>, Fail> {
        let mut values = HashMap::new();
        for (n, flag) in flags.iter().enumerate() {
            if flag & bit != 0 {
                values.insert(n, whole(Some(read.varint()? as f64), max));
            }
        }
        Ok(values)
    };
    let seasons = column(1, 1000.0)?;
    let episodes = column(2, 10_000.0)?;
    let seen = column(4, 100_000.0)?;
    let mut items = Vec::new();
    for n in 0..count {
        let mut thumb = None;
        if flags[n] & 8 != 0 {
            let length = read.varint()? as usize;
            if length > THUMB_MAX {
                return Err(());
            }
            let blob = read.take(length)?.to_vec();
            if valid_thumb(&blob) {
                thumb = Some(blob);
            }
        }
        let title = clean(titles[n], MAX_TITLE);
        if title.is_empty() {
            continue;
        }
        let status = STATUSES
            .get((flags[n] >> 5) as usize)
            .copied()
            .filter(|s| *s != Status::Watching);
        let rating = whole(Some(f64::from(ratings[n])), 5.0).filter(|r| *r != 0);
        let (season, episode, watched) = if progress {
            (
                if flags[n] & 1 != 0 {
                    seasons.get(&n).copied().flatten()
                } else {
                    Some(1)
                },
                if flags[n] & 2 != 0 {
                    episodes.get(&n).copied().flatten()
                } else {
                    Some(1)
                },
                if flags[n] & 4 != 0 {
                    seen.get(&n).copied().flatten()
                } else {
                    Some(0)
                },
            )
        } else {
            (None, None, None)
        };
        items.push(SharedItem {
            title,
            status,
            rating,
            season,
            episode,
            seen: watched,
            manga: thumb.is_some() && flags[n] & 16 != 0,
            thumb,
        });
    }
    Ok(Some(SharedList { name, items }))
}

/* Deflate and base 64 -------------------------------------------------------------------------- */

fn deflate(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    // Writing to a `Vec` cannot fail.
    let _ = encoder.write_all(bytes);
    encoder.finish().unwrap_or_default()
}

fn inflate(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    // One byte past the limit tells a list that fits from a bomb.
    DeflateDecoder::new(bytes)
        .take(MAX_PAYLOAD as u64 + 1)
        .read_to_end(&mut out)
        .ok()?;
    (out.len() <= MAX_PAYLOAD).then_some(out)
}

/// The packed list as the text a link carries.
pub fn encode_share(list: &SharedList) -> String {
    URL_SAFE_NO_PAD.encode(deflate(&pack_list(list)))
}

/// FNV-1a, as four base-36 characters: names a list's parts, so parts of two lists sent about the same
/// time do not mix.
pub fn name_of(text: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    let mut digits = Vec::new();
    let mut n = hash;
    while n > 0 {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    if digits.is_empty() {
        digits.push(b'0');
    }
    digits.reverse();
    let text = String::from_utf8(digits).unwrap_or_default();
    let padded = format!("{text:0>4}");
    padded[padded.len() - 4..].to_string()
}

/// The links that carry a list: one when it fits in `max` characters, else as many parts as it takes, each
/// `<name>.<n>.<of>.<data>` after the hash. Empty when even that is more than [`MAX_PARTS`] — a file is the
/// way then.
pub fn share_links(list: &SharedList, origin: &str, max: usize) -> Vec<String> {
    let base = format!("{}/{SHARE_PREFIX}", origin.trim_end_matches('/'));
    let text = encode_share(list);
    if base.len() + text.len() <= max {
        return vec![format!("{base}{text}")];
    }
    let name = name_of(&text);
    let room = 200.max(max.saturating_sub(base.len() + format!("{name}.00.00.").len()));
    let parts = text.len().div_ceil(room);
    if parts > MAX_PARTS {
        return vec![];
    }
    (0..parts)
        .map(|index| {
            let from = index * room;
            let to = ((index + 1) * room).min(text.len());
            format!("{base}{name}.{}.{parts}.{}", index + 1, &text[from..to])
        })
        .collect()
}

/// The text after `#g=` (or the older `#geteilt=`) in an address, or none.
pub fn shared_from_hash(hash: &str) -> Option<&str> {
    [SHARE_PREFIX, LEGACY_PREFIX]
        .into_iter()
        .find_map(|p| hash.strip_prefix(p).filter(|rest| !rest.is_empty()))
}

/// A list out of what a whole link carries, or none. Parts are put together first by [`read_shared`].
pub fn decode_share(text: &str) -> Option<SharedList> {
    if text.len() > MAX_PARTS * LINK_MAX
        || text.is_empty()
        || !text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(text).ok()?;
    unpack_list(&inflate(&bytes)?)
}

/* Gathering parts ------------------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gathered {
    pub of: usize,
    pub got: BTreeMap<String, String>,
    pub at: i64,
}

/// Where parts wait for the rest: a file of the app's own, or whatever a test hands in.
pub trait PartStore {
    fn read(&self) -> BTreeMap<String, Gathered>;
    fn write(&mut self, all: &BTreeMap<String, Gathered>);
}

/// A list sent in parts is opened within a day or two, or not at all.
const PARTS_KEPT_MS: i64 = 2 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq)]
pub enum Reading {
    List(SharedList),
    Parts { got: Vec<usize>, of: usize },
    Broken,
}

/// What an address carries: a list, one more part of a list that is not whole yet, or nothing readable.
pub fn read_shared(text: &str, store: &mut dyn PartStore, now: i64) -> Reading {
    let Some((name, n, of, data)) = split_part(text) else {
        return decode_share(text).map_or(Reading::Broken, Reading::List);
    };
    if of < 2 || of > MAX_PARTS || n < 1 || n > of {
        return Reading::Broken;
    }
    let mut all = store.read();
    all.retain(|_, g| now - g.at < PARTS_KEPT_MS);
    let mut here = match all.remove(name) {
        Some(g) if g.of == of => g,
        _ => Gathered {
            of,
            got: BTreeMap::new(),
            at: now,
        },
    };
    here.got.insert(n.to_string(), data.to_string());
    here.at = now;
    let mut have: Vec<usize> = here.got.keys().filter_map(|k| k.parse().ok()).collect();
    have.sort_unstable();
    if have.len() < of {
        all.insert(name.to_string(), here);
        store.write(&all);
        return Reading::Parts { got: have, of };
    }
    store.write(&all);
    let whole: String = (1..=of)
        .map(|i| here.got.get(&i.to_string()).map_or("", String::as_str))
        .collect();
    decode_share(&whole).map_or(Reading::Broken, Reading::List)
}

/// `<name>.<n>.<of>.<data>`: four letters and digits, one or two digits twice, then URL-safe text.
fn split_part(text: &str) -> Option<(&str, usize, usize, &str)> {
    let mut it = text.splitn(4, '.');
    let (name, n, of, data) = (it.next()?, it.next()?, it.next()?, it.next()?);
    let ok_name = name.len() == 4
        && name
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase());
    let digits = |s: &str| (1..=2).contains(&s.len()) && s.chars().all(|c| c.is_ascii_digit());
    let ok_data = !data.is_empty()
        && data
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    (ok_name && digits(n) && digits(of) && ok_data)
        .then(|| (name, n.parse().unwrap_or(0), of.parse().unwrap_or(0), data))
}

/* As a file ------------------------------------------------------------------------------------ */

pub const SHARE_FILE_EXT: &str = ".sondra-liste";
const MAGIC: [u8; 4] = *b"SLST";
/// A file this big is not a list.
const MAX_FILE: usize = 12 * 1024 * 1024;

pub fn is_share_file(name: &str) -> bool {
    name.to_lowercase().ends_with(SHARE_FILE_EXT)
}

pub fn share_file(list: &SharedList) -> Vec<u8> {
    let mut out = MAGIC.to_vec();
    out.extend(deflate(&pack_list(list)));
    out
}

pub fn read_share_file(bytes: &[u8]) -> Option<SharedList> {
    if bytes.len() > MAX_FILE || bytes.len() < 6 || bytes[..4] != MAGIC {
        return None;
    }
    unpack_list(&inflate(&bytes[4..])?)
}

/* As text -------------------------------------------------------------------------------------- */

fn status_word(status: Status) -> &'static str {
    match status {
        Status::Watching => "Am Schauen",
        Status::Later => "Später",
        Status::Paused => "Pausiert",
        Status::Done => "Fertig",
        Status::Dropped => "Abgebrochen",
    }
}

/// One line per series — „Frieren – S1E12 – 4/5“ — that anyone reads, with or without Sondra, then the
/// links.
pub fn share_text(list: &SharedList, links: &[String]) -> String {
    let mut lines = vec![format!(
        "{} ({}):",
        if list.name.is_empty() {
            "Merkliste".to_string()
        } else {
            format!("Merkliste von {}", list.name)
        },
        list.items.len()
    )];
    for item in &list.items {
        let place = match item.season {
            None => String::new(),
            Some(0) => format!("Film {}", item.episode.unwrap_or(1)),
            Some(s) => format!("S{s}E{}", item.episode.unwrap_or(1)),
        };
        let rating = item
            .rating
            .filter(|r| *r != 0)
            .map(|r| format!("{r}/5"))
            .unwrap_or_default();
        let status = item
            .status
            .filter(|s| *s != Status::Watching)
            .map(|s| status_word(s).to_string())
            .unwrap_or_default();
        let parts: Vec<String> = [item.title.clone(), place, rating, status]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect();
        lines.push(format!("• {}", parts.join(" – ")));
    }
    match links.len() {
        0 => {}
        1 => {
            lines.push(String::new());
            lines.push(format!("In Sondra öffnen: {}", links[0]));
        }
        n => {
            lines.push(String::new());
            lines.push(format!(
                "In Sondra öffnen — alle {n} Links nacheinander öffnen:"
            ));
            for (i, link) in links.iter().enumerate() {
                lines.push(format!("{}/{n} {link}", i + 1));
            }
        }
    }
    lines.join("\n")
}

/* Against one's own list ----------------------------------------------------------------------- */

/// A title as it is compared: without case and accents.
pub fn title_key(title: &str) -> String {
    let folded: String = title
        .nfkd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Comparison {
    /// On both lists.
    pub both: Vec<SharedItem>,
    /// Only on the shared one: what this list could take.
    pub fresh: Vec<SharedItem>,
    /// Titles only this list has.
    pub only_mine: usize,
}

pub fn compare_shared(list: &SharedList, current: &[Item]) -> Comparison {
    let mine: HashSet<String> = current.iter().map(|i| title_key(&i.title)).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let (mut both, mut fresh) = (Vec::new(), Vec::new());
    for item in &list.items {
        let key = title_key(&item.title);
        if !seen.insert(key.clone()) {
            continue;
        }
        if mine.contains(&key) {
            both.push(item.clone());
        } else {
            fresh.push(item.clone());
        }
    }
    Comparison {
        both,
        fresh,
        only_mine: mine.iter().filter(|k| !seen.contains(*k)).count(),
    }
}

/// How a shared entry becomes one of this list: as it stands there, or — for „Später“ — as something not
/// started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Take {
    AsThere,
    Later,
}

/// The fields for a new entry from a shared one. The little picture that came along stays bytes: the
/// screen draws it from them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NewEntry {
    pub title: String,
    pub thumb: Option<Vec<u8>>,
    pub manga: bool,
    pub status: Option<Status>,
    pub rating: Option<i64>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

pub fn entry_from_shared(item: &SharedItem, how: Take) -> NewEntry {
    let mut entry = NewEntry {
        title: item.title.clone(),
        thumb: item.thumb.clone(),
        manga: item.thumb.is_some() && item.manga,
        ..NewEntry::default()
    };
    match how {
        Take::Later => entry.status = Some(Status::Later),
        Take::AsThere => {
            entry.status = item.status;
            entry.rating = item.rating.filter(|r| *r != 0);
            entry.season = item.season;
            entry.episode = item.episode;
        }
    }
    entry
}
