//! A folder of one's own, as Sondra sees it (`src/lib/folder.ts`): every file in it read once, then shown,
//! sorted, filtered and selected without touching the disk again. The listing, the sorting, the selecting
//! and the setting of files into the series of the Merkliste are plain functions here too, checked against
//! the web app's answers.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use crate::matching::{
    already_seen, guess_episode, match_episode, match_hint, normal_title, EpisodeHint, EpisodeMatch,
};
use crate::model::{Item, Status};
use crate::progress::seasons_of;
use crate::stats::compare_numeric;

macro_rules! rx {
    ($pattern:expr) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        CELL.get_or_init(|| Regex::new($pattern).expect("a fixed pattern"))
    }};
}

/* Kinds ----------------------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AssetKind {
    Video,
    Audio,
    Image,
    Document,
    Archive,
    Unknown,
}

impl AssetKind {
    pub fn name(self) -> &'static str {
        match self {
            AssetKind::Video => "video",
            AssetKind::Audio => "audio",
            AssetKind::Image => "image",
            AssetKind::Document => "document",
            AssetKind::Archive => "archive",
            AssetKind::Unknown => "unknown",
        }
    }
    /// The plain-language name of a kind, for anywhere a file is described.
    pub fn label(self) -> &'static str {
        match self {
            AssetKind::Audio => "Ton",
            AssetKind::Video => "Video",
            AssetKind::Image => "Bild",
            AssetKind::Document => "Dokument",
            AssetKind::Archive => "Archiv",
            AssetKind::Unknown => "Datei",
        }
    }
    fn order(self) -> i32 {
        match self {
            AssetKind::Video => 0,
            AssetKind::Audio => 1,
            AssetKind::Image => 2,
            AssetKind::Document => 3,
            AssetKind::Archive => 4,
            AssetKind::Unknown => 5,
        }
    }
}

fn by_extension(ext: &str) -> Option<AssetKind> {
    Some(match ext {
        "mp3" | "wav" | "flac" | "ogg" | "oga" | "opus" | "m4a" | "aac" | "aiff" | "aif"
        | "wma" | "alac" | "mka" => AssetKind::Audio,
        "mp4" | "webm" | "mkv" | "mov" | "avi" | "ts" | "m4v" | "flv" | "wmv" | "mpg" | "mpeg"
        | "3gp" => AssetKind::Video,
        "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif" | "bmp" | "tif" | "tiff" | "svg"
        | "heic" => AssetKind::Image,
        "pdf" | "txt" | "md" | "csv" | "json" | "docx" | "rtf" | "xml" | "srt" | "vtt" => {
            AssetKind::Document
        }
        "zip" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" => AssetKind::Archive,
        _ => return None,
    })
}

/// What a file is, from its media type and, failing that, its name.
pub fn kind_from_mime(mime: &str, name: &str) -> AssetKind {
    if mime.starts_with("audio/") {
        return AssetKind::Audio;
    }
    if mime.starts_with("video/") {
        return AssetKind::Video;
    }
    if mime.starts_with("image/") {
        return AssetKind::Image;
    }
    if mime.starts_with("text/") || mime == "application/pdf" || mime == "application/json" {
        return AssetKind::Document;
    }
    if rx!(r"^application/(zip|x-tar|gzip|x-7z|vnd\.rar)").is_match(mime) {
        return AssetKind::Archive;
    }
    // A name without a dot is its own „extension“, as on the web.
    by_extension(&name.rsplit('.').next().unwrap_or("").to_lowercase())
        .unwrap_or(AssetKind::Unknown)
}

/* The scan ---------------------------------------------------------------------------------------- */

/// In Google Drive: its id there, its media type, the folder it is in, and what it was filed as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveInfo {
    pub id: String,
    pub mime: String,
    pub parent: Option<String>,
    pub hint: Option<EpisodeHint>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FolderFile {
    /// Inside the chosen folder, with `/`: „Staffel 1/Frieren S01E01.mkv“.
    pub path: String,
    pub name: String,
    /// The folder it is in, relative; empty for the top.
    pub dir: String,
    pub size: u64,
    pub modified: i64,
    pub kind: AssetKind,
    pub drive: Option<DriveInfo>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct FolderScan {
    pub name: String,
    pub files: Vec<FolderFile>,
    /// Every folder inside, relative, empty one included.
    pub dirs: Vec<String>,
    /// Stopped at `SCAN_LIMIT` files.
    pub truncated: bool,
    /// Sondra's folder in Google Drive rather than one on this device.
    pub drive: bool,
}

/// More than this, and the folder is rather a drive: the scan stops and says so.
pub const SCAN_LIMIT: usize = 20_000;

/// Hidden files and the ones systems leave behind are not anybody's media.
pub fn is_skipped(name: &str) -> bool {
    rx!(r"(?i)^(\.|desktop\.ini$|thumbs\.db$|\$recycle\.bin$|system volume information$|sondra-papierkorb$)").is_match(name)
}

/* Notes and names in Drive --------------------------------------------------------------------------- */

pub const HINT_SERIES: &str = "sondraSerie";
pub const HINT_SEASON: &str = "sondraStaffel";
pub const HINT_EPISODE: &str = "sondraFolge";

/// What `fileIntoSeason` left on a file: the entry, season and episode it was filed as.
pub fn hint_of(properties: &HashMap<String, String>) -> Option<EpisodeHint> {
    let series = properties.get(HINT_SERIES).filter(|s| !s.is_empty())?;
    let int = |key: &str| -> Option<i64> {
        let text = properties.get(key)?;
        // `Number(text)` then `Number.isInteger`: whole numbers in plain decimal.
        let f: f64 = if text.trim().is_empty() {
            0.0
        } else {
            text.trim().parse().ok()?
        };
        (f.fract() == 0.0 && f.is_finite()).then_some(f as i64)
    };
    let (season, episode) = (int(HINT_SEASON)?, int(HINT_EPISODE)?);
    (season >= 0 && episode >= 1).then(|| EpisodeHint {
        series: series.clone(),
        season,
        episode,
    })
}

pub fn hint_properties(hint: &EpisodeHint) -> BTreeMap<String, String> {
    BTreeMap::from([
        (HINT_SERIES.to_string(), hint.series.clone()),
        (HINT_SEASON.to_string(), hint.season.to_string()),
        (HINT_EPISODE.to_string(), hint.episode.to_string()),
    ])
}

/// A season's folder as `fileIntoSeason` names it: „Staffel 2“, films „Filme“.
pub fn season_folder_name(season: i64) -> String {
    if season == 0 {
        "Filme".into()
    } else {
        format!("Staffel {season}")
    }
}

/// A series' name as a folder: no slashes, which would read as folders of their own.
pub fn series_folder_name(title: &str) -> String {
    let t = rx!(r"[/\\]+").replace_all(title, "-");
    let t = rx!(r"\s+").replace_all(&t, " ");
    let t = t.trim();
    if t.is_empty() {
        "Ohne Namen".into()
    } else {
        t.to_string()
    }
}

/// Where a series' season lies below „Sondra“.
pub fn season_path(title: &str, season: i64) -> [String; 3] {
    [
        "Serien".into(),
        series_folder_name(title),
        season_folder_name(season),
    ]
}

/// A file in „Serien/<Titel>/Staffel n“ without notes (moved there by hand in Drive): the entry by its
/// title, the season by its folder, the episode by the number in its name.
fn from_path(file: &FolderFile, items: &[Item]) -> Option<EpisodeMatch> {
    let found = rx!(r"(?:^|/)Serien/([^/]+)/(?:Staffel (\d+)|(Filme))$").captures(&file.dir)?;
    let title = normal_title(&found[1]);
    let item = items
        .iter()
        .find(|i| normal_title(&series_folder_name(&i.title)) == title)?;
    let episode = match guess_episode(&file.name) {
        Some(g) => g.episode,
        None => {
            let stem = rx!(r"(?i)\.[a-z0-9]{2,5}$")
                .replace(&file.name, "")
                .into_owned();
            // The last run of digits, its last four: what `(\d{1,4})(?!.*\d)` finds.
            let run = rx!(r"[0-9]+").find_iter(&stem).last()?.as_str().to_string();
            let tail: String = run
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            tail.parse::<i64>().ok()?
        }
    };
    if episode < 1 {
        return None;
    }
    let season = if found.get(3).is_some() {
        0
    } else {
        found[2].parse().ok()?
    };
    Some(EpisodeMatch {
        item: item.id.clone(),
        season,
        episode,
    })
}

/// Which episode a file is: as filed, by its folder, else by its name.
pub fn match_file(file: &FolderFile, items: &[Item]) -> Option<EpisodeMatch> {
    match_hint(file.drive.as_ref().and_then(|d| d.hint.as_ref()), items)
        .or_else(|| from_path(file, items))
        .or_else(|| match_episode(&file.name, items))
}

fn is_media(file: &FolderFile) -> bool {
    matches!(file.kind, AssetKind::Video | AssetKind::Audio)
}

/* Series the folder holds that the Merkliste does not know ----------------------------------------------- */

/// A series the file names tell of, with what lies in the folder of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundSeries {
    /// Normalised title: the key.
    pub key: String,
    /// The title as the names spell it, tidied.
    pub title: String,
    /// The episodes there are, per season (1 where the names say none).
    pub seasons: Vec<(i64, Vec<i64>)>,
    /// How many files.
    pub files: usize,
}

/// The series in a folder that are not on the Merkliste yet, read from the file names. A series needs two
/// episodes to count: one file called „Ocean's 11“ is a film, and the folder is not offering to follow it.
pub fn find_new_series(
    files: &[FolderFile],
    known: &[Item],
    ignored: &HashSet<String>,
) -> Vec<FoundSeries> {
    struct Entry {
        titles: Vec<(String, usize)>,
        seasons: BTreeMap<i64, BTreeSet<i64>>,
        files: usize,
    }
    let mut order: Vec<String> = Vec::new();
    let mut found: HashMap<String, Entry> = HashMap::new();
    for file in files {
        if !is_media(file) || match_file_cached(file, known).is_some() {
            continue;
        }
        let Some(guess) = guess_episode(&file.name) else {
            continue;
        };
        let key = normal_title(&guess.title);
        if key.is_empty() || ignored.contains(&key) {
            continue;
        }
        let entry = found.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            Entry {
                titles: Vec::new(),
                seasons: BTreeMap::new(),
                files: 0,
            }
        });
        match entry.titles.iter_mut().find(|(t, _)| *t == guess.title) {
            Some(t) => t.1 += 1,
            None => entry.titles.push((guess.title.clone(), 1)),
        }
        entry
            .seasons
            .entry(guess.season.unwrap_or(1))
            .or_default()
            .insert(guess.episode);
        entry.files += 1;
    }
    let mut all: Vec<FoundSeries> = order
        .iter()
        .map(|key| {
            let entry = &found[key];
            // The spelling most files use; the first one on a tie.
            let mut titles = entry.titles.clone();
            titles.sort_by(|a, b| b.1.cmp(&a.1));
            FoundSeries {
                key: key.clone(),
                title: titles[0].0.clone(),
                seasons: entry
                    .seasons
                    .iter()
                    .map(|(n, set)| (*n, set.iter().copied().collect()))
                    .collect(),
                files: entry.files,
            }
        })
        .filter(|s| s.seasons.iter().map(|(_, e)| e.len()).sum::<usize>() >= 2)
        .collect();
    all.sort_by(|a, b| compare_numeric(&a.title, &b.title));
    all
}

fn match_file_cached(file: &FolderFile, items: &[Item]) -> Option<EpisodeMatch> {
    match_file(file, items)
}

/// Episodes lying loose in Drive that belong to a series on the list: where they should go.
#[derive(Debug, Clone, PartialEq)]
pub struct Unfiled {
    pub item: String,
    pub title: String,
    pub season: i64,
    pub files: Vec<(FolderFile, i64)>,
}

/// The files in Google Drive that the Merkliste knows by name but that are not filed yet — no note on them,
/// not in „Serien/<Titel>/Staffel n“ — grouped by series and season. Only what the name says clearly.
pub fn unfiled_episodes(files: &[FolderFile], items: &[Item]) -> Vec<Unfiled> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Unfiled> = HashMap::new();
    for file in files {
        if file.drive.is_none() || !is_media(file) {
            continue;
        }
        if file.drive.as_ref().is_some_and(|d| d.hint.is_some())
            || rx!(r"(?:^|/)Serien/[^/]+/(?:Staffel \d+|Filme)$").is_match(&file.dir)
        {
            continue;
        }
        let Some(m) = match_episode(&file.name, items) else {
            continue;
        };
        let key = format!("{}|{}", m.item, m.season);
        let group = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            let title = items
                .iter()
                .find(|i| i.id == m.item)
                .map(|i| i.title.clone())
                .unwrap_or_default();
            Unfiled {
                item: m.item.clone(),
                title,
                season: m.season,
                files: Vec::new(),
            }
        });
        group.files.push((file.clone(), m.episode));
    }
    let mut out: Vec<Unfiled> = order
        .into_iter()
        .map(|k| {
            let mut g = groups
                .remove(&k)
                .unwrap_or_else(|| unreachable!("a key in the order has a group"));
            g.files.sort_by_key(|(_, e)| *e);
            g
        })
        .collect();
    out.sort_by(|a, b| compare_numeric(&a.title, &b.title).then(a.season.cmp(&b.season)));
    out
}

/// What a found series becomes on the Merkliste: following it from its first episode here, the length of
/// it not known — as the fields `normalize` takes.
pub fn series_to_merk_item(series: &FoundSeries) -> Value {
    let first = &series.seasons[0];
    json!({
        "title": series.title,
        "status": "watching",
        "season": first.0,
        "episode": first.1[0],
        "seasons": series.seasons.iter().map(|(n, _)| json!({"number": n, "episodes": null, "watched": []})).collect::<Vec<_>>(),
    })
}

/// The scan without some files — after they were deleted.
pub fn without_files(scan: &FolderScan, paths: &HashSet<String>) -> FolderScan {
    FolderScan {
        files: scan
            .files
            .iter()
            .filter(|f| !paths.contains(&f.path))
            .cloned()
            .collect(),
        ..scan.clone()
    }
}

/* What is shown ---------------------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Name,
    Modified,
    Size,
    Kind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KindFilter {
    All,
    Video,
    Audio,
    Image,
    Other,
}

#[derive(Debug, Clone)]
pub struct ListingOptions {
    /// The folder being looked at; empty for the top.
    pub dir: String,
    /// All files below it, not only those directly in it.
    pub deep: bool,
    pub filter: KindFilter,
    pub query: String,
    pub sort: SortKey,
    pub descending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirSummary {
    pub path: String,
    pub name: String,
    /// Files in it and below.
    pub count: usize,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Listing {
    pub dirs: Vec<DirSummary>,
    pub files: Vec<FolderFile>,
    /// Per kind, of the files in view before the kind filter, for the filter's labels.
    pub counts: HashMap<KindFilter, usize>,
}

/// Lower case, no accents: „Café“ is found by „cafe“.
fn plain(text: &str) -> String {
    text.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
}

pub fn kind_matches(kind: AssetKind, filter: KindFilter) -> bool {
    match filter {
        KindFilter::All => true,
        KindFilter::Other => {
            !matches!(kind, AssetKind::Video | AssetKind::Audio | AssetKind::Image)
        }
        KindFilter::Video => kind == AssetKind::Video,
        KindFilter::Audio => kind == AssetKind::Audio,
        KindFilter::Image => kind == AssetKind::Image,
    }
}

pub fn sort_files(files: &[FolderFile], sort: SortKey, descending: bool) -> Vec<FolderFile> {
    let mut sorted = files.to_vec();
    sorted.sort_by(|a, b| match sort {
        SortKey::Name => {
            compare_numeric(&a.name, &b.name).then_with(|| compare_numeric(&a.path, &b.path))
        }
        SortKey::Modified => a
            .modified
            .cmp(&b.modified)
            .then_with(|| compare_numeric(&a.name, &b.name)),
        SortKey::Size => a
            .size
            .cmp(&b.size)
            .then_with(|| compare_numeric(&a.name, &b.name)),
        SortKey::Kind => a
            .kind
            .order()
            .cmp(&b.kind.order())
            .then_with(|| compare_numeric(&a.name, &b.name)),
    });
    if descending {
        sorted.reverse();
    }
    sorted
}

fn inside(dir: &str, path: &str) -> bool {
    dir.is_empty() || path == dir || path.starts_with(&format!("{dir}/"))
}

/// What one folder of the scan shows: its subfolders, then its files, filtered and sorted.
pub fn listing(scan: &FolderScan, options: &ListingOptions) -> Listing {
    let query = plain(options.query.trim());
    let searching = !query.is_empty();
    let searched: Vec<&FolderFile> = scan
        .files
        .iter()
        .filter(|file| {
            let in_view = if options.deep || searching {
                inside(&options.dir, &file.dir)
            } else {
                file.dir == options.dir
            };
            in_view && (!searching || plain(&file.name).contains(&query))
        })
        .collect();
    let mut counts: HashMap<KindFilter, usize> = HashMap::from([
        (KindFilter::All, searched.len()),
        (KindFilter::Video, 0),
        (KindFilter::Audio, 0),
        (KindFilter::Image, 0),
        (KindFilter::Other, 0),
    ]);
    for file in &searched {
        let key = match file.kind {
            AssetKind::Video => KindFilter::Video,
            AssetKind::Audio => KindFilter::Audio,
            AssetKind::Image => KindFilter::Image,
            _ => KindFilter::Other,
        };
        *counts.entry(key).or_insert(0) += 1;
    }
    let kept: Vec<FolderFile> = searched
        .into_iter()
        .filter(|f| kind_matches(f.kind, options.filter))
        .cloned()
        .collect();
    let files = sort_files(&kept, options.sort, options.descending);

    // Subfolders only when browsing one level at a time.
    let mut dirs = Vec::new();
    if !options.deep && !searching {
        let depth = if options.dir.is_empty() {
            0
        } else {
            options.dir.split('/').count()
        };
        for path in &scan.dirs {
            if path.is_empty()
                || !inside(&options.dir, path)
                || path.split('/').count() != depth + 1
            {
                continue;
            }
            let (mut count, mut size) = (0, 0);
            for file in &scan.files {
                if inside(path, &file.dir) {
                    count += 1;
                    size += file.size;
                }
            }
            let name = path.rsplit('/').next().unwrap_or(path).to_string();
            dirs.push(DirSummary {
                path: path.clone(),
                name,
                count,
                size,
            });
        }
        dirs.sort_by(|a, b| compare_numeric(&a.name, &b.name));
    }
    Listing {
        dirs,
        files,
        counts,
    }
}

/// „Anime / Frieren / Staffel 1“ as steps to click back through.
pub fn crumbs(scan_name: &str, dir: &str) -> Vec<(String, String)> {
    let mut steps = vec![(scan_name.to_string(), String::new())];
    if dir.is_empty() {
        return steps;
    }
    let parts: Vec<&str> = dir.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        steps.push((part.to_string(), parts[..=i].join("/")));
    }
    steps
}

/* Selecting ---------------------------------------------------------------------------------------------- */

/// The selection after a click: alone, added or taken away (Ctrl/Cmd), or the run from the last click to
/// this one in the order shown (Shift) — the way every file manager does it.
pub fn click_select(
    selected: &BTreeSet<String>,
    order: &[String],
    anchor: Option<&str>,
    path: &str,
    toggle: bool,
    range: bool,
) -> (BTreeSet<String>, String) {
    if range {
        if let Some(a) = anchor.filter(|a| order.iter().any(|o| o == a)) {
            let from = order.iter().position(|o| o == a);
            let to = order.iter().position(|o| o == path);
            if let (Some(from), Some(to)) = (from, to) {
                let run = &order[from.min(to)..=from.max(to)];
                let mut next = if toggle {
                    selected.clone()
                } else {
                    BTreeSet::new()
                };
                next.extend(run.iter().cloned());
                return (next, a.to_string());
            }
            // The clicked file is not in the order: JS `indexOf` gives -1 and slices from the end.
            let to_index = to.map_or(-1i64, |t| t as i64);
            let from_index = from.map_or(0i64, |f| f as i64);
            let len = order.len() as i64;
            let norm = |i: i64| if i < 0 { (len + i).max(0) } else { i.min(len) };
            let (lo, hi) = (
                norm(from_index.min(to_index)),
                norm(from_index.max(to_index) + 1),
            );
            let mut next = if toggle {
                selected.clone()
            } else {
                BTreeSet::new()
            };
            if lo < hi {
                next.extend(order[lo as usize..hi as usize].iter().cloned());
            }
            return (next, a.to_string());
        }
    }
    if toggle {
        let mut next = selected.clone();
        if !next.remove(path) {
            next.insert(path.to_string());
        }
        return (next, path.to_string());
    }
    (BTreeSet::from([path.to_string()]), path.to_string())
}

/* Episodes of the Merkliste in the folder ------------------------------------------------------------------ */

#[derive(Debug, Clone, PartialEq)]
pub struct FolderEpisode {
    pub file: FolderFile,
    pub season: i64,
    pub episode: i64,
    pub seen: bool,
}

fn find<'a>(items: &'a [Item], id: &str) -> Option<&'a Item> {
    items.iter().find(|i| i.id == id)
}

/// The file each episode belongs to, for the badges on the tiles.
pub fn episode_of(file: &FolderFile, items: &[Item]) -> Option<FolderEpisode> {
    if !is_media(file) {
        return None;
    }
    let m = match_file(file, items)?;
    let item = find(items, &m.item)?;
    Some(FolderEpisode {
        file: file.clone(),
        season: m.season,
        episode: m.episode,
        seen: already_seen(item, m.season, m.episode),
    })
}

/// Every episode of every series of the Merkliste that lies in the folder, in order, seen ones included —
/// per series id, in the order the series were first met. The same episode twice (two qualities, a copy)
/// counts once: the larger file.
pub fn folder_episodes(files: &[FolderFile], items: &[Item]) -> Vec<(String, Vec<FolderEpisode>)> {
    let mut order: Vec<String> = Vec::new();
    let mut by_series: HashMap<String, Vec<((i64, i64), FolderEpisode)>> = HashMap::new();
    for file in files {
        if !is_media(file) {
            continue;
        }
        let Some(m) = match_file(file, items) else {
            continue;
        };
        let Some(item) = find(items, &m.item) else {
            continue;
        };
        let found = FolderEpisode {
            file: file.clone(),
            season: m.season,
            episode: m.episode,
            seen: already_seen(item, m.season, m.episode),
        };
        let group = by_series.entry(m.item.clone()).or_insert_with(|| {
            order.push(m.item.clone());
            Vec::new()
        });
        let key = (m.season, m.episode);
        match group.iter_mut().find(|(k, _)| *k == key) {
            Some((_, before)) => {
                if before.file.size < file.size {
                    *before = found;
                }
            }
            None => group.push((key, found)),
        }
    }
    order
        .into_iter()
        .map(|id| {
            let mut list: Vec<FolderEpisode> = by_series
                .remove(&id)
                .unwrap_or_default()
                .into_iter()
                .map(|(_, e)| e)
                .collect();
            list.sort_by(|a, b| a.season.cmp(&b.season).then(a.episode.cmp(&b.episode)));
            (id, list)
        })
        .collect()
}

/// What „abspielen“ hands the player from one episode on: that one, then the ones after it in the folder
/// that are not seen yet.
pub fn play_queue(episodes: &[FolderEpisode], season: i64, episode: i64) -> Vec<FolderEpisode> {
    let Some(at) = episodes
        .iter()
        .position(|e| e.season == season && e.episode == episode)
    else {
        return vec![];
    };
    let mut out = vec![episodes[at].clone()];
    out.extend(episodes[at + 1..].iter().filter(|e| !e.seen).cloned());
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct FolderSeries {
    pub item: String,
    pub episodes: Vec<FolderEpisode>,
    /// The episode to watch next.
    pub next: FolderEpisode,
    /// What comes after it in the folder, in order: the queue for the player.
    pub queue: Vec<FolderEpisode>,
}

/// Series of the Merkliste that have episodes in the folder, with the next one to watch: where the list
/// stands, else the first unseen one after the last seen, else the first unseen at all. A series with
/// nothing left unseen here is left out.
pub fn folder_series(files: &[FolderFile], items: &[Item]) -> Vec<FolderSeries> {
    let mut result: Vec<FolderSeries> = Vec::new();
    for (id, list) in folder_episodes(files, items) {
        let Some(item) = find(items, &id) else {
            continue;
        };
        let unseen: Vec<&FolderEpisode> = list.iter().filter(|e| !e.seen).collect();
        if unseen.is_empty() {
            continue;
        }
        let stand = item.episode.and_then(|ep| {
            list.iter()
                .find(|e| e.season == item.season && e.episode == ep && !e.seen)
        });
        let last_seen = list.iter().rev().find(|e| e.seen);
        let next = stand
            .or_else(|| {
                last_seen.and_then(|l| {
                    unseen.iter().copied().find(|e| {
                        e.season > l.season || (e.season == l.season && e.episode > l.episode)
                    })
                })
            })
            .unwrap_or(unseen[0])
            .clone();
        let queue = play_queue(&list, next.season, next.episode);
        result.push(FolderSeries {
            item: id,
            episodes: list,
            next,
            queue,
        });
    }
    // The series being watched first, then by title.
    let watching = |id: &str| find(items, id).is_some_and(|i| i.status == Status::Watching);
    let title = |id: &str| find(items, id).map(|i| i.title.clone()).unwrap_or_default();
    result.sort_by(|a, b| {
        watching(&b.item)
            .cmp(&watching(&a.item))
            .then_with(|| compare_numeric(&title(&a.item), &title(&b.item)))
    });
    result
}

/// One season of one series, as the folder page sets it apart: its episodes in order under a heading that
/// says how far along it is.
#[derive(Debug, Clone, PartialEq)]
pub struct SeriesGroup {
    /// `<series id>|<season>`
    pub key: String,
    pub item: String,
    pub season: i64,
    pub files: Vec<FolderFile>,
    /// Episodes in the folder — two copies of one count once.
    pub here: usize,
    /// Of those, how many the Merkliste has seen.
    pub seen_here: usize,
    /// Episodes of this season the Merkliste has seen, wherever they lie.
    pub seen: usize,
    /// The episodes the season is known to have; none when the Merkliste does not know.
    pub total: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Grouped {
    pub groups: Vec<SeriesGroup>,
    /// Everything that is no episode of the Merkliste, in the order it came.
    pub rest: Vec<FolderFile>,
    /// The groups one after the other, then the rest: the one order the page draws, selects a range in and
    /// moves through with the arrow keys.
    pub ordered: Vec<FolderFile>,
    /// Each episode's file path → what it is, for the badges and for „Ungesehen“.
    pub episodes: HashMap<String, FolderEpisode>,
    /// Each grouped file path → the key of its group.
    pub key_of: HashMap<String, String>,
}

/// The seasons a series is known to have, for „Staffel 1 · Folge 4 von 12“.
pub fn episodes_in_season(item: &Item, season: i64) -> Option<i64> {
    seasons_of(item)
        .iter()
        .find(|s| s.number == season)
        .and_then(|s| s.episodes)
}

/// The files set into series: per series of the Merkliste and season, in the order of the episodes; the
/// series being watched first, then by title. What the Merkliste does not know stays where it was, after
/// them.
pub fn group_by_series(files: &[FolderFile], items: &[Item]) -> Grouped {
    let mut episodes: HashMap<String, FolderEpisode> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut found: HashMap<String, (String, i64, Vec<FolderEpisode>)> = HashMap::new();
    let mut rest = Vec::new();
    for file in files {
        let m = if is_media(file) {
            match_file(file, items)
        } else {
            None
        };
        let Some(m) = m.filter(|m| find(items, &m.item).is_some()) else {
            rest.push(file.clone());
            continue;
        };
        let item = find(items, &m.item).unwrap_or_else(|| unreachable!("filtered just above"));
        let entry = FolderEpisode {
            file: file.clone(),
            season: m.season,
            episode: m.episode,
            seen: already_seen(item, m.season, m.episode),
        };
        episodes.insert(file.path.clone(), entry.clone());
        let key = format!("{}|{}", m.item, m.season);
        let group = found.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            (m.item.clone(), m.season, Vec::new())
        });
        group.2.push(entry);
    }
    let utf16 = |s: &str| s.encode_utf16().count();
    let mut groups: Vec<SeriesGroup> = order
        .iter()
        .map(|key| {
            let (id, season, list) = &found[key];
            let item =
                find(items, id).unwrap_or_else(|| unreachable!("a group's series is on the list"));
            // Two files of one episode: the plainer name first, so „(1)“ and „Kopie“ come after the original.
            let mut sorted = list.clone();
            sorted.sort_by(|a, b| {
                a.episode
                    .cmp(&b.episode)
                    .then(utf16(&a.file.name).cmp(&utf16(&b.file.name)))
                    .then_with(|| compare_numeric(&a.file.name, &b.file.name))
            });
            SeriesGroup {
                key: key.clone(),
                item: id.clone(),
                season: *season,
                files: sorted.iter().map(|e| e.file.clone()).collect(),
                here: sorted
                    .iter()
                    .map(|e| e.episode)
                    .collect::<HashSet<_>>()
                    .len(),
                seen_here: sorted
                    .iter()
                    .filter(|e| e.seen)
                    .map(|e| e.episode)
                    .collect::<HashSet<_>>()
                    .len(),
                seen: seasons_of(item)
                    .iter()
                    .find(|s| s.number == *season)
                    .map_or(0, |s| s.watched.len()),
                total: episodes_in_season(item, *season),
            }
        })
        .collect();
    let watching = |id: &str| find(items, id).is_some_and(|i| i.status == Status::Watching);
    let title = |id: &str| find(items, id).map(|i| i.title.clone()).unwrap_or_default();
    // The films (season 0) after the seasons.
    groups.sort_by(|a, b| {
        watching(&b.item)
            .cmp(&watching(&a.item))
            .then_with(|| compare_numeric(&title(&a.item), &title(&b.item)))
            .then((a.season == 0, a.season).cmp(&(b.season == 0, b.season)))
    });
    let mut key_of = HashMap::new();
    for group in &groups {
        for file in &group.files {
            key_of.insert(file.path.clone(), group.key.clone());
        }
    }
    let ordered: Vec<FolderFile> = groups
        .iter()
        .flat_map(|g| g.files.clone())
        .chain(rest.clone())
        .collect();
    Grouped {
        groups,
        rest,
        ordered,
        episodes,
        key_of,
    }
}
