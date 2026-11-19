//! Where received files go on this computer: into a folder, below it the subfolders of a folder that was
//! sent, each file written as it arrives to a temporary name and given its real one when it is whole — a
//! half file never carries the name of a finished one, and a file that is there already is never replaced
//! („Film (2).mp4“, as on the web).

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use crate::engine::SinkMaker;
use crate::transfer::{free_name, safe_file_name, split_path, FileInfo, OutgoingFile, Piece, Sink};

const PART: &str = ".sondra-teil";

struct FileSink {
    dir: PathBuf,
    name: String,
    part: PathBuf,
    file: Option<File>,
    /// What the place reads like: the folder's own name and the way down to the file.
    shown: String,
}

impl Sink for FileSink {
    fn write(&mut self, chunk: &[u8]) -> io::Result<()> {
        self.file.as_mut().ok_or_else(|| io::Error::other("closed"))?.write_all(chunk)
    }

    fn close(&mut self) -> io::Result<String> {
        if let Some(mut file) = self.file.take() {
            file.flush()?;
            file.sync_all()?;
        }
        let name = free_name(&self.name, &|candidate| self.dir.join(candidate).exists());
        fs::rename(&self.part, self.dir.join(&name))?;
        let place = match self.shown.rsplit_once('/') {
            Some((up, _)) => format!("{up}/{name}"),
            None => name,
        };
        Ok(place)
    }

    fn abort(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.part);
    }
}

/// A folder is a place only if it stays inside the folder it was made for.
fn inside(root: &Path, dir: &Path) -> bool {
    dir.strip_prefix(root).is_ok_and(|rest| rest.components().all(|c| matches!(c, Component::Normal(_))))
}

/// Sinks that write into `root` (made when needed), keeping the folders a sent folder came in.
pub fn folder_sinks(root: PathBuf) -> SinkMaker {
    let label = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Arc::new(move |file: &FileInfo, index: usize, _piece: Option<&Piece>| -> io::Result<Box<dyn Sink>> {
        let (dir, name) = split_path(file.path.as_deref(), &file.name);
        let target = if dir.is_empty() { root.clone() } else { root.join(dir.split('/').collect::<PathBuf>()) };
        if !inside(&root, &target) {
            return Err(io::Error::other("Der Ordner liegt ausserhalb des Ziels."));
        }
        fs::create_dir_all(&target)?;
        let part = target.join(format!("{name}.{index}{PART}"));
        let handle = File::create(&part)?;
        let shown = if dir.is_empty() { format!("{label}/{name}") } else { format!("{label}/{dir}/{name}") };
        Ok(Box::new(FileSink { dir: target, name, part, file: Some(handle), shown }))
    })
}

/// What the web app's `File.type` would say for the common kinds, by extension.
pub fn mime_of(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).as_deref() {
        Some("mp4" | "m4v") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        Some("ogg" | "opus") => "audio/ogg",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        Some("txt" | "srt") => "text/plain",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

fn outgoing_file(path: &Path, shown: Option<String>) -> io::Result<OutgoingFile> {
    let size = fs::metadata(path)?.len();
    let name = safe_file_name(&path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Datei".into()));
    let info = FileInfo { mime: mime_of(&name).to_owned(), name, size, path: shown };
    let path = path.to_path_buf();
    let mut open: Option<File> = None;
    let read = Box::new(move |start: u64, end: u64| -> io::Result<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        if open.is_none() {
            open = Some(File::open(&path)?);
        }
        let file = open.as_mut().expect("opened");
        file.seek(SeekFrom::Start(start))?;
        let mut buffer = vec![0u8; (end - start) as usize];
        file.read_exact(&mut buffer)?;
        Ok(buffer)
    });
    Ok(OutgoingFile { info, read })
}

/// Files the person chose, to be sent one after the other.
pub fn files_to_send(paths: &[PathBuf]) -> io::Result<Vec<OutgoingFile>> {
    paths.iter().filter(|p| p.is_file()).map(|p| outgoing_file(p, None)).collect()
}

/// A folder and everything under it, each file remembering the way down from the folder's own name
/// („Anime/Staffel 1/Folge 1.mkv“); at most `limit` files, the rest left out.
pub fn folder_to_send(dir: &Path, limit: usize) -> io::Result<Vec<OutgoingFile>> {
    fn walk(dir: &Path, way: &str, out: &mut Vec<(PathBuf, String)>) -> io::Result<()> {
        let mut entries: Vec<_> = fs::read_dir(dir)?.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let kind = entry.file_type()?;
            let shown = format!("{way}/{name}");
            if kind.is_dir() {
                walk(&entry.path(), &shown, out)?;
            } else if kind.is_file() {
                out.push((entry.path(), shown));
            }
        }
        Ok(())
    }
    let top = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Ordner".into());
    let mut found = Vec::new();
    walk(dir, &top, &mut found)?;
    found.into_iter().take(limit).map(|(path, shown)| outgoing_file(&path, Some(shown))).collect()
}
