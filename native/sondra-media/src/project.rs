//! `.sondra` project files, the website's format (`src/lib/project.ts`): a ZIP with `project.json` — the manifest, which
//! says which tool was open and lists the files — and `assets/<n>_<name>`, the files themselves. Reading takes any
//! such archive (stored or deflated, with or without Zip64 fields); writing makes one the website opens. What the
//! website keeps beside it (the state of each tool, the Merkliste) is not carried here: the native tools hold their
//! state themselves.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::zip::{write_zip, ZipFile};

/// One file of the project, as the manifest names it.
#[derive(Debug, Clone, PartialEq)]
pub struct Asset {
    pub name: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Project {
    /// The tool that was open (`PanelId` of the website), if any.
    pub panel: Option<String>,
    pub assets: Vec<Asset>,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// Every entry of a ZIP archive with its bytes: the central directory is read, so an archive whose local headers
/// carry no sizes is read as well.
pub fn read_zip(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let bad = || "Das ist kein gültiges ZIP-Archiv.".to_string();
    // The end record lies in the last 64 KiB.
    let from = bytes.len().saturating_sub(65_557);
    let end = (from..bytes.len().saturating_sub(21)).rev().find(|&i| u32_at(bytes, i) == Some(0x0605_4b50)).ok_or_else(bad)?;
    let mut count = u64::from(u16_at(bytes, end + 10).ok_or_else(bad)?);
    let mut dir = u64::from(u32_at(bytes, end + 16).ok_or_else(bad)?);
    if (count == 0xFFFF || dir == 0xFFFF_FFFF) && end >= 20 && u32_at(bytes, end - 20) == Some(0x0706_4b50) {
        let record = u64_at(bytes, end - 20 + 8).ok_or_else(bad)? as usize;
        if u32_at(bytes, record) != Some(0x0606_4b50) {
            return Err(bad());
        }
        count = u64_at(bytes, record + 32).ok_or_else(bad)?;
        dir = u64_at(bytes, record + 48).ok_or_else(bad)?;
    }
    let mut out = Vec::new();
    let mut at = dir as usize;
    for _ in 0..count {
        if u32_at(bytes, at) != Some(0x0201_4b50) {
            return Err(bad());
        }
        let method = u16_at(bytes, at + 10).ok_or_else(bad)?;
        let mut packed = u64::from(u32_at(bytes, at + 20).ok_or_else(bad)?);
        let mut size = u64::from(u32_at(bytes, at + 24).ok_or_else(bad)?);
        let name_len = usize::from(u16_at(bytes, at + 28).ok_or_else(bad)?);
        let extra_len = usize::from(u16_at(bytes, at + 30).ok_or_else(bad)?);
        let comment_len = usize::from(u16_at(bytes, at + 32).ok_or_else(bad)?);
        let mut local = u64::from(u32_at(bytes, at + 42).ok_or_else(bad)?);
        let name = String::from_utf8_lossy(bytes.get(at + 46..at + 46 + name_len).ok_or_else(bad)?).into_owned();
        // Zip64: what did not fit in four bytes is in the extra field, in this order.
        let extra = bytes.get(at + 46 + name_len..at + 46 + name_len + extra_len).ok_or_else(bad)?;
        let mut e = 0;
        while e + 4 <= extra.len() {
            let (id, len) = (u16_at(extra, e).ok_or_else(bad)?, usize::from(u16_at(extra, e + 2).ok_or_else(bad)?));
            if id == 1 {
                let mut p = e + 4;
                for field in [&mut size, &mut packed, &mut local] {
                    if *field == 0xFFFF_FFFF {
                        *field = u64_at(extra, p).ok_or_else(bad)?;
                        p += 8;
                    }
                }
            }
            e += 4 + len;
        }
        at += 46 + name_len + extra_len + comment_len;
        if name.ends_with('/') {
            continue;
        }
        let head = local as usize;
        if u32_at(bytes, head) != Some(0x0403_4b50) {
            return Err(bad());
        }
        let start = head + 30 + usize::from(u16_at(bytes, head + 26).ok_or_else(bad)?) + usize::from(u16_at(bytes, head + 28).ok_or_else(bad)?);
        let data = bytes.get(start..start + packed as usize).ok_or_else(bad)?;
        let content = match method {
            0 => data.to_vec(),
            8 => {
                let mut v = Vec::with_capacity(size as usize);
                flate2::read::DeflateDecoder::new(data).read_to_end(&mut v).map_err(|_| bad())?;
                v
            }
            m => return Err(format!("Das ZIP nutzt ein Verfahren (Nr. {m}), das hier nicht gelesen wird.")),
        };
        out.push((name, content));
    }
    Ok(out)
}

/// Reads a project: the manifest, and the files it names. A manifest that is not the website's is refused in words.
pub fn read(bytes: &[u8], source: &str) -> Result<Project, String> {
    let entries = read_zip(bytes)?;
    let manifest = entries.iter().find(|(n, _)| n == "project.json").ok_or_else(|| format!("{source} enthält keine Sondra-Projektbeschreibung (project.json)."))?;
    let manifest: Value = serde_json::from_slice(&manifest.1).map_err(|_| format!("{source} hat eine unlesbare Projektbeschreibung."))?;
    if manifest["format"] != "sondra-project" {
        return Err(format!("{source} ist keine unterstützte Sondra-Projektdatei."));
    }
    let mut assets = Vec::new();
    for meta in manifest["assets"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let (Some(path), Some(name)) = (meta["entryPath"].as_str(), meta["name"].as_str()) else { continue };
        if let Some((_, data)) = entries.iter().find(|(n, _)| n == path) {
            assets.push(Asset { name: name.to_owned(), mime: meta["mime"].as_str().unwrap_or("application/octet-stream").to_owned(), bytes: data.clone() });
        }
    }
    Ok(Project { panel: manifest["panel"].as_str().map(str::to_owned), assets })
}

/// What the website would write for a name: no character Windows refuses.
pub fn entry_safe(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c }).collect();
    if cleaned.trim().is_empty() { "datei".into() } else { cleaned }
}

/// The kind the website files a file under.
pub fn kind_of(name: &str, mime: &str) -> &'static str {
    use kinds::{kind_from_name, Kind};
    match kind_from_name(name, mime) {
        Kind::Audio => "audio",
        Kind::Video => "video",
        Kind::Image => "image",
        Kind::Other => "other",
    }
}

mod kinds {
    pub enum Kind {
        Audio,
        Video,
        Image,
        Other,
    }
    pub fn kind_from_name(name: &str, mime: &str) -> Kind {
        let lower = name.to_lowercase();
        let ends = |list: &[&str]| list.iter().any(|e| lower.ends_with(&format!(".{e}")));
        if mime.starts_with("video/") || ends(&["mp4", "m4v", "mov", "webm", "mkv", "avi"]) {
            Kind::Video
        } else if mime.starts_with("audio/") || ends(&["mp3", "wav", "flac", "ogg", "opus", "m4a", "aac", "aif", "aiff", "wma"]) {
            Kind::Audio
        } else if mime.starts_with("image/") || ends(&["png", "jpg", "jpeg", "webp", "gif"]) {
            Kind::Image
        } else {
            Kind::Other
        }
    }
}

fn mime_of(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "opus" => "audio/ogg",
        "m4a" | "aac" => "audio/mp4",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

/// Writes a project the website opens: the files are copied from where they lie, one after the other, never all
/// held in memory. `panel` is the website's `PanelId` of the tool to open. Returns the number of files.
pub fn write(out: &Path, files: &[PathBuf], panel: &str, date: [u32; 6]) -> Result<usize, String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let mut metas = Vec::new();
    let mut zipped = Vec::new();
    for (index, path) in files.iter().enumerate() {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| format!("datei{index}"));
        let size = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?.len();
        let entry = format!("assets/{index}_{}", entry_safe(&name));
        metas.push(json!({
            "id": format!("a{index}"), "name": name, "entryPath": entry, "mime": mime_of(&name), "sizeBytes": size,
            "kind": kind_of(&name, mime_of(&name)), "durationSeconds": null, "origin": "file", "createdAt": now,
        }));
        zipped.push(ZipFile { name: entry, path: path.clone(), date });
    }
    let manifest = json!({ "format": "sondra-project", "version": 1, "savedAt": now, "panel": panel, "activeAssetId": null, "assets": metas, "toolStates": {} });
    let json_path = out.with_extension("sondra.json.tmp");
    std::fs::write(&json_path, serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    zipped.insert(0, ZipFile { name: "project.json".into(), path: json_path.clone(), date });
    let result = std::fs::File::create(out).map_err(|e| e.to_string()).and_then(|file| write_zip(&mut std::io::BufWriter::new(file), &zipped).map_err(|e| e.to_string()));
    let _ = std::fs::remove_file(&json_path);
    if result.is_err() {
        let _ = std::fs::remove_file(out);
    }
    result.map(|_| files.len())
}
