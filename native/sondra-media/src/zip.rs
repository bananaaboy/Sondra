//! The store-only ZIP of the website (`src/lib/zip.ts`), byte for byte: entries are stored as they are (the sound
//! and film files are compressed already), names are made safe for every file system and told apart, and Zip64
//! records stand at the end so a large batch is no broken file. No compression library, no dependency.

use std::collections::{HashMap, HashSet};

/// One file in the archive. The date is what the DOS timestamp of the format carries — the clock of the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntry {
    pub name: String,
    pub data: Vec<u8>,
    /// Year, month (1–12), day, hour, minute, second.
    pub date: [u32; 6],
}

const LIMIT: u64 = 0xffff_ffff;

/// JavaScript's `\s` and `trim()`: not quite the Unicode list of Rust (no NEL, and the byte order mark counts).
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    table
}

/// CRC-32 of the data, as ZIP wants it.
pub fn crc32(data: &[u8]) -> u32 {
    let table = crc_table();
    let mut crc = 0xffff_ffffu32;
    for b in data {
        crc = table[((crc ^ u32::from(*b)) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xffff_ffff
}

/// MS-DOS time and date.
fn dos(date: &[u32; 6]) -> (u16, u16) {
    let [y, mo, d, h, mi, s] = *date;
    let time = (h << 11) | (mi << 5) | ((s / 2) & 0x1f);
    let day = (y.wrapping_sub(1980) << 9) | (mo << 5) | d;
    (time as u16, day as u16)
}

/// Cleans one entry path: slashes stay (they are how a ZIP says folders), everything that could climb out of the
/// folder or that Windows refuses does not.
fn clean_path(name: &str) -> String {
    let segments: Vec<String> = name
        .split('/')
        .map(|segment| {
            let swapped: String = {
                let mut out = String::new();
                let mut in_run = false;
                for c in segment.chars() {
                    if matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                        if !in_run {
                            out.push('_');
                        }
                        in_run = true;
                    } else {
                        in_run = false;
                        out.push(c);
                    }
                }
                out
            };
            let dotted = if !swapped.is_empty() && swapped.chars().all(|c| c == '.') { String::new() } else { swapped };
            js_trim(&dotted).to_string()
        })
        .filter(|s| !s.is_empty())
        .collect();
    if segments.is_empty() {
        "datei".to_string()
    } else {
        segments.join("/")
    }
}

/// Entry names must be unique, or unpacking tools drop the duplicates silently.
fn unique_names(entries: &[ZipEntry]) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    entries
        .iter()
        .map(|entry| {
            let clean = clean_path(&entry.name);
            let count = *seen.get(&clean).unwrap_or(&0);
            seen.insert(clean.clone(), count + 1);
            if count == 0 {
                return clean;
            }
            let (dot, slash) = (clean.rfind('.'), clean.rfind('/'));
            match dot {
                Some(d) if slash.is_none_or(|s| d > s) && d > 0 => format!("{}_{}{}", &clean[..d], count + 1, &clean[d..]),
                _ => format!("{clean}_{}", count + 1),
            }
        })
        .collect()
}

/// The archive: local headers with the data, then the central directory with a Zip64 field for each entry, then
/// the Zip64 records and the end record.
pub fn create_zip(entries: &[ZipEntry]) -> Vec<u8> {
    let names: Vec<Vec<u8>> = unique_names(entries).into_iter().map(String::into_bytes).collect();
    let mut out: Vec<u8> = Vec::new();
    let u16w = |out: &mut Vec<u8>, v: u16| out.extend_from_slice(&v.to_le_bytes());
    let u32w = |out: &mut Vec<u8>, v: u32| out.extend_from_slice(&v.to_le_bytes());
    let u64w = |out: &mut Vec<u8>, v: u64| out.extend_from_slice(&v.to_le_bytes());
    let mut records: Vec<(u32, u64, u64)> = Vec::new();

    for (entry, name) in entries.iter().zip(&names) {
        let (time, date) = dos(&entry.date);
        let crc = crc32(&entry.data);
        let size = entry.data.len() as u64;
        let start = out.len() as u64;
        u32w(&mut out, 0x0403_4b50);
        u16w(&mut out, 45);
        u16w(&mut out, 0x0800);
        u16w(&mut out, 0);
        u16w(&mut out, time);
        u16w(&mut out, date);
        u32w(&mut out, crc);
        u32w(&mut out, size.min(LIMIT) as u32);
        u32w(&mut out, size.min(LIMIT) as u32);
        u16w(&mut out, name.len() as u16);
        u16w(&mut out, 0);
        out.extend_from_slice(name);
        out.extend_from_slice(&entry.data);
        records.push((crc, size, start));
    }

    let central_start = out.len() as u64;
    for ((entry, name), (crc, size, offset)) in entries.iter().zip(&names).zip(&records) {
        let (time, date) = dos(&entry.date);
        u32w(&mut out, 0x0201_4b50);
        u16w(&mut out, 45);
        u16w(&mut out, 45);
        u16w(&mut out, 0x0800);
        u16w(&mut out, 0);
        u16w(&mut out, time);
        u16w(&mut out, date);
        u32w(&mut out, *crc);
        u32w(&mut out, (*size).min(LIMIT) as u32);
        u32w(&mut out, (*size).min(LIMIT) as u32);
        u16w(&mut out, name.len() as u16);
        u16w(&mut out, 20);
        u16w(&mut out, 0);
        u16w(&mut out, 0);
        u16w(&mut out, 0);
        u32w(&mut out, 0);
        u32w(&mut out, (*offset).min(LIMIT) as u32);
        out.extend_from_slice(name);
        u16w(&mut out, 0x0001);
        u16w(&mut out, 16);
        u64w(&mut out, *size);
        u64w(&mut out, *size);
    }
    let central_bytes = out.len() as u64 - central_start;

    let zip64_start = out.len() as u64;
    u32w(&mut out, 0x0606_4b50);
    u64w(&mut out, 44);
    u16w(&mut out, 45);
    u16w(&mut out, 45);
    u32w(&mut out, 0);
    u32w(&mut out, 0);
    u64w(&mut out, entries.len() as u64);
    u64w(&mut out, entries.len() as u64);
    u64w(&mut out, central_bytes);
    u64w(&mut out, central_start);
    u32w(&mut out, 0x0706_4b50);
    u32w(&mut out, 0);
    u64w(&mut out, zip64_start);
    u32w(&mut out, 1);
    u32w(&mut out, 0x0605_4b50);
    u16w(&mut out, 0);
    u16w(&mut out, 0);
    u16w(&mut out, entries.len().min(0xffff) as u16);
    u16w(&mut out, entries.len().min(0xffff) as u16);
    u32w(&mut out, central_bytes.min(LIMIT) as u32);
    u32w(&mut out, central_start.min(LIMIT) as u32);
    u16w(&mut out, 0);
    out
}

fn is_bad(c: char) -> bool {
    matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\u{0}'..='\u{1f}')
}

/// `clean` of `zipName`: what was typed, made safe for every file system.
fn clean_typed(value: &str) -> String {
    let trimmed = js_trim(value);
    let lower = trimmed.to_lowercase();
    let no_ext = if lower.ends_with(".zip") { &trimmed[..trimmed.len() - 4] } else { trimmed };
    // Before a space or at the end such a character just goes; between words it becomes a dash.
    let chars: Vec<char> = no_ext.chars().collect();
    let n = chars.len();
    let mut removed: Vec<char> = Vec::new();
    let mut i = 0;
    while i < n {
        if is_bad(chars[i]) {
            let mut e = i;
            while e < n && is_bad(chars[e]) {
                e += 1;
            }
            // The longest run that is followed by a space or the end (backing off as a regex does).
            if let Some(k) = (i + 1..=e).rev().find(|k| *k == n || js_space(chars[*k])) {
                i = k;
                continue;
            }
        }
        removed.push(chars[i]);
        i += 1;
    }
    let mut dashed = String::new();
    let mut in_run = false;
    for c in removed {
        if is_bad(c) {
            if !in_run {
                dashed.push('-');
            }
            in_run = true;
        } else {
            in_run = false;
            dashed.push(c);
        }
    }
    let mut spaced = String::new();
    let mut in_space = false;
    for c in dashed.chars() {
        if js_space(c) {
            if !in_space {
                spaced.push(' ');
            }
            in_space = true;
        } else {
            in_space = false;
            spaced.push(c);
        }
    }
    let stripped = spaced.trim_matches(|c: char| js_space(c) || c == '.');
    // `slice(0, 120)` counts UTF-16 units.
    let mut units = 0;
    let mut out = String::new();
    for c in stripped.chars() {
        units += c.len_utf16();
        if units > 120 {
            break;
        }
        out.push(c);
    }
    out
}

/// The name an archive is saved under and the folder its files sit in: what was typed (or the suggestion), with one
/// `.zip` on the end. Returns (file, stem).
pub fn zip_name(typed: &str, suggestion: &str) -> (String, String) {
    let mut stem = {
        let t = clean_typed(typed);
        if !t.is_empty() {
            t
        } else {
            let s = clean_typed(suggestion);
            if s.is_empty() {
                "sondra".to_string()
            } else {
                s
            }
        }
    };
    let lower = stem.to_lowercase();
    let device = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul") || ((lower.starts_with("com") || lower.starts_with("lpt")) && lower.len() == 4 && lower.as_bytes()[3].is_ascii_digit());
    if device {
        stem.push('_');
    }
    (format!("{stem}.zip"), stem)
}

/// Two entries with one name overwrite each other when unpacked: the later ones become „Name (2).ext“, „Name (3).ext“.
pub fn unique_entry_names(names: &[String]) -> Vec<String> {
    let mut taken: HashSet<String> = HashSet::new();
    names
        .iter()
        .map(|original| {
            let mut name = original.clone();
            let (base, extension) = match name.rfind('.') {
                Some(d) if d > 0 => (name[..d].to_string(), name[d..].to_string()),
                _ => (name.clone(), String::new()),
            };
            let mut count = 2;
            while taken.contains(&name.to_lowercase()) {
                name = format!("{base} ({count}){extension}");
                count += 1;
            }
            taken.insert(name.to_lowercase());
            name
        })
        .collect()
}

/// A file on disk for the archive: its name inside, where it lies, and its date.
#[derive(Debug, Clone)]
pub struct ZipFile {
    pub name: String,
    pub path: std::path::PathBuf,
    pub date: [u32; 6],
}

/// Writes the same archive as `create_zip` would, from files on disk, without holding them in memory: each file is read
/// twice (once for its sum, which the local header carries, once to copy it). The bytes are the website's.
pub fn write_zip(out: &mut impl std::io::Write, files: &[ZipFile]) -> std::io::Result<()> {
    use std::io::Read;
    let probe: Vec<ZipEntry> = files.iter().map(|f| ZipEntry { name: f.name.clone(), data: Vec::new(), date: f.date }).collect();
    let names: Vec<Vec<u8>> = unique_names(&probe).into_iter().map(String::into_bytes).collect();
    let table = crc_table();
    let mut position: u64 = 0;
    let mut records: Vec<(u32, u64, u64)> = Vec::new();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut put = |out: &mut dyn std::io::Write, bytes: &[u8], position: &mut u64| -> std::io::Result<()> {
        *position += bytes.len() as u64;
        out.write_all(bytes)
    };

    for (file, name) in files.iter().zip(&names) {
        // First the sum and the size.
        let mut reader = std::fs::File::open(&file.path)?;
        let (mut crc, mut size) = (0xffff_ffffu32, 0u64);
        loop {
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            for b in &buffer[..n] {
                crc = table[((crc ^ u32::from(*b)) & 0xff) as usize] ^ (crc >> 8);
            }
            size += n as u64;
        }
        let crc = crc ^ 0xffff_ffff;
        let (time, date) = dos(&file.date);
        let start = position;
        let mut head: Vec<u8> = Vec::new();
        head.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        head.extend_from_slice(&45u16.to_le_bytes());
        head.extend_from_slice(&0x0800u16.to_le_bytes());
        head.extend_from_slice(&0u16.to_le_bytes());
        head.extend_from_slice(&time.to_le_bytes());
        head.extend_from_slice(&date.to_le_bytes());
        head.extend_from_slice(&crc.to_le_bytes());
        head.extend_from_slice(&(size.min(LIMIT) as u32).to_le_bytes());
        head.extend_from_slice(&(size.min(LIMIT) as u32).to_le_bytes());
        head.extend_from_slice(&(name.len() as u16).to_le_bytes());
        head.extend_from_slice(&0u16.to_le_bytes());
        head.extend_from_slice(name);
        put(out, &head, &mut position)?;
        // Then the file itself; one that changed in between is no archive worth writing.
        let mut reader = std::fs::File::open(&file.path)?;
        let mut copied = 0u64;
        loop {
            let n = reader.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            put(out, &buffer[..n], &mut position)?;
            copied += n as u64;
        }
        if copied != size {
            return Err(std::io::Error::other(format!("{} hat sich beim Packen verändert", file.path.display())));
        }
        records.push((crc, size, start));
    }

    // The directory at the end is small; the same bytes as `create_zip` writes after the data.
    let central_start = position;
    let mut tail: Vec<u8> = Vec::new();
    for ((file, name), (crc, size, offset)) in files.iter().zip(&names).zip(&records) {
        let (time, date) = dos(&file.date);
        tail.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        tail.extend_from_slice(&45u16.to_le_bytes());
        tail.extend_from_slice(&45u16.to_le_bytes());
        tail.extend_from_slice(&0x0800u16.to_le_bytes());
        tail.extend_from_slice(&0u16.to_le_bytes());
        tail.extend_from_slice(&time.to_le_bytes());
        tail.extend_from_slice(&date.to_le_bytes());
        tail.extend_from_slice(&crc.to_le_bytes());
        tail.extend_from_slice(&((*size).min(LIMIT) as u32).to_le_bytes());
        tail.extend_from_slice(&((*size).min(LIMIT) as u32).to_le_bytes());
        tail.extend_from_slice(&(name.len() as u16).to_le_bytes());
        tail.extend_from_slice(&20u16.to_le_bytes());
        tail.extend_from_slice(&0u16.to_le_bytes());
        tail.extend_from_slice(&0u16.to_le_bytes());
        tail.extend_from_slice(&0u16.to_le_bytes());
        tail.extend_from_slice(&0u32.to_le_bytes());
        tail.extend_from_slice(&((*offset).min(LIMIT) as u32).to_le_bytes());
        tail.extend_from_slice(name);
        tail.extend_from_slice(&1u16.to_le_bytes());
        tail.extend_from_slice(&16u16.to_le_bytes());
        tail.extend_from_slice(&size.to_le_bytes());
        tail.extend_from_slice(&size.to_le_bytes());
    }
    let central_bytes = tail.len() as u64;
    let zip64_start = central_start + central_bytes;
    tail.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
    tail.extend_from_slice(&44u64.to_le_bytes());
    tail.extend_from_slice(&45u16.to_le_bytes());
    tail.extend_from_slice(&45u16.to_le_bytes());
    tail.extend_from_slice(&0u32.to_le_bytes());
    tail.extend_from_slice(&0u32.to_le_bytes());
    tail.extend_from_slice(&(files.len() as u64).to_le_bytes());
    tail.extend_from_slice(&(files.len() as u64).to_le_bytes());
    tail.extend_from_slice(&central_bytes.to_le_bytes());
    tail.extend_from_slice(&central_start.to_le_bytes());
    tail.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
    tail.extend_from_slice(&0u32.to_le_bytes());
    tail.extend_from_slice(&zip64_start.to_le_bytes());
    tail.extend_from_slice(&1u32.to_le_bytes());
    tail.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    tail.extend_from_slice(&0u16.to_le_bytes());
    tail.extend_from_slice(&0u16.to_le_bytes());
    tail.extend_from_slice(&(files.len().min(0xffff) as u16).to_le_bytes());
    tail.extend_from_slice(&(files.len().min(0xffff) as u16).to_le_bytes());
    tail.extend_from_slice(&(central_bytes.min(LIMIT) as u32).to_le_bytes());
    tail.extend_from_slice(&(central_start.min(LIMIT) as u32).to_le_bytes());
    tail.extend_from_slice(&0u16.to_le_bytes());
    put(out, &tail, &mut position)
}
