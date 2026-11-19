//! Files that are the same file twice — downloaded again, copied into a second folder, saved as „Film
//! (1).mp4“ (`src/lib/duplicates.ts`).
//!
//! Only files of exactly the same size can be the same, so most are never read. Of those that remain,
//! files up to 32 MB are compared whole (SHA-256 over every byte); larger ones at 32 places spread over the
//! file, 64 KB each — two different films of the very same size do not agree at 32 places. The page says
//! which of the two a group was found by.
//!
//! Of each group one is kept: a name without a copy mark („(1)“, „Kopie“, „copy“) before one with, then the
//! oldest — the original, most likely. The rest are what „Doppelte auswählen“ selects.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::OnceLock;

use regex::Regex;
use sha2::{Digest, Sha256};

use crate::folder::FolderFile;
use crate::stats::compare_de_full;

/// Up to this, the whole file is compared.
pub const WHOLE_LIMIT: u64 = 32 * 1024 * 1024;
const SAMPLES: u64 = 32;
const SAMPLE: u64 = 64 * 1024;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What a file is compared by: all of it (`g:`), or 32 slices of it (`s:`).
pub fn content_key(reader: &mut (impl Read + Seek)) -> std::io::Result<String> {
    let size = reader.seek(SeekFrom::End(0))?;
    reader.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    if size <= WHOLE_LIMIT {
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        return Ok(format!("g:{}", hex(&hash.finalize())));
    }
    for index in 0..SAMPLES {
        let start = ((size - SAMPLE) as u128 * u128::from(index) / u128::from(SAMPLES - 1)) as u64;
        reader.seek(SeekFrom::Start(start))?;
        let mut part = vec![0u8; SAMPLE as usize];
        reader.read_exact(&mut part)?;
        hash.update(&part);
    }
    Ok(format!("s:{}", hex(&hash.finalize())))
}

/// „Film (1).mp4“, „Film - Kopie.mp4“, „Film copy 2.mp4“: a copy by its name.
pub fn looks_like_copy(name: &str) -> bool {
    static STEM: OnceLock<Regex> = OnceLock::new();
    static COPY: OnceLock<Regex> = OnceLock::new();
    let stem = STEM
        .get_or_init(|| Regex::new(r"\.[^.]+$").expect("a fixed pattern"))
        .replace(name, "");
    COPY.get_or_init(|| {
        Regex::new(r"(?i)(\(\d+\)|[ _-](kopie|copy|duplikat)( \(?\d+\)?)?)$")
            .expect("a fixed pattern")
    })
    .is_match(stem.trim())
}

/// The order within a group: the one to keep first.
pub fn keep_first(files: &[FolderFile]) -> Vec<FolderFile> {
    let mut sorted = files.to_vec();
    sorted.sort_by(|a, b| {
        looks_like_copy(&a.name)
            .cmp(&looks_like_copy(&b.name))
            .then(a.modified.cmp(&b.modified))
            .then(
                a.path
                    .encode_utf16()
                    .count()
                    .cmp(&b.path.encode_utf16().count()),
            )
            .then_with(|| compare_de_full(&a.path, &b.path))
    });
    sorted
}

#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateGroup {
    pub size: u64,
    /// The one to keep first, then the copies.
    pub files: Vec<FolderFile>,
    /// Compared byte for byte, rather than at 32 places.
    pub whole: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DuplicateReport {
    pub groups: Vec<DuplicateGroup>,
    /// Files read to find them.
    pub read: usize,
    /// Bytes the copies take up.
    pub spare: u64,
}

/// Finds the groups of copies. `key` says what a file is compared by (for a file on the device:
/// [`content_key`]); a file it cannot read is called a copy of nothing. `progress` is told how far it is,
/// and may answer `false` to stop.
pub fn find_duplicates(
    files: &[FolderFile],
    mut key: impl FnMut(&FolderFile) -> std::io::Result<String>,
    mut progress: impl FnMut(usize, usize) -> bool,
) -> Option<DuplicateReport> {
    let mut sizes: Vec<u64> = Vec::new();
    let mut by_size: HashMap<u64, Vec<&FolderFile>> = HashMap::new();
    for file in files {
        if file.size == 0 {
            continue;
        }
        by_size
            .entry(file.size)
            .or_insert_with(|| {
                sizes.push(file.size);
                Vec::new()
            })
            .push(file);
    }
    let candidates: Vec<&Vec<&FolderFile>> = sizes
        .iter()
        .map(|s| &by_size[s])
        .filter(|g| g.len() > 1)
        .collect();
    let total: usize = candidates.iter().map(|g| g.len()).sum();
    let mut done = 0;
    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for group in candidates {
        let mut order: Vec<String> = Vec::new();
        let mut by_content: HashMap<String, Vec<FolderFile>> = HashMap::new();
        for file in group {
            // Unreadable now: not called a copy of anything.
            let id = key(file).unwrap_or_else(|_| format!("x:{}", file.path));
            by_content
                .entry(id.clone())
                .or_insert_with(|| {
                    order.push(id);
                    Vec::new()
                })
                .push((*file).clone());
            done += 1;
            if !progress(done, total) {
                return None;
            }
        }
        for id in order {
            let same = &by_content[&id];
            if same.len() > 1 {
                groups.push(DuplicateGroup {
                    size: group[0].size,
                    files: keep_first(same),
                    whole: id.starts_with("g:"),
                });
            }
        }
    }
    let spare = |g: &DuplicateGroup| g.size * (g.files.len() as u64 - 1);
    groups.sort_by_key(|g| std::cmp::Reverse(spare(g)));
    let spare_total = groups.iter().map(spare).sum();
    Some(DuplicateReport {
        groups,
        read: total,
        spare: spare_total,
    })
}

/// Every copy, without the one kept of each group.
pub fn copies_of(report: &DuplicateReport) -> Vec<FolderFile> {
    report
        .groups
        .iter()
        .flat_map(|g| g.files[1..].iter().cloned())
        .collect()
}
