//! The Whisper model: which ones there are, where they are kept, and fetching one — only the model, only
//! when the person said so, with its progress. The sound never goes anywhere. The models are ggml files
//! (whisper.cpp), the quantised ones, from the same Hugging Face place as the web app's, a different file
//! format for a different runtime.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    pub file: &'static str,
    /// Download size, for the one-time note and to refuse a file that stopped short.
    pub bytes: u64,
}

pub const MODELS: [Model; 2] = [
    Model { id: "base", label: "Schnell", hint: "Gut für klare Sprache. Einmalig rund 60 MB.", file: "ggml-base-q5_1.bin", bytes: 59_707_625 },
    Model { id: "small", label: "Genauer", hint: "Besser bei Dialekt, Musik im Hintergrund und Fachwörtern, aber etwa dreimal langsamer. Einmalig rund 190 MB.", file: "ggml-small-q5_1.bin", bytes: 190_085_487 },
];

pub const SOURCE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

pub fn model_by_id(id: &str) -> Model {
    MODELS.iter().copied().find(|m| m.id == id).unwrap_or(MODELS[0])
}

/// Where a model lies, whether it is there or not.
pub fn path_of(dir: &Path, model: &Model) -> PathBuf {
    dir.join(model.file)
}

/// A model that is whole: the right size, as far as a size can say.
pub fn is_present(dir: &Path, model: &Model) -> bool {
    std::fs::metadata(path_of(dir, model)).is_ok_and(|m| m.len() >= model.bytes * 9 / 10)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FetchError {
    #[error("Das Sprachmodell liess sich nicht laden: {0}")]
    Failed(String),
    #[error("Abgebrochen")]
    Cancelled,
}

/// Fetches `model` into `dir` (from `source`, [`SOURCE`] unless a test brings its own), calling `progress`
/// with the bytes so far and the total. The file is written under a temporary name and given its own when it
/// is whole, so a half model is never taken for a whole one. `cancel` is looked at between pieces.
pub fn fetch(dir: &Path, model: &Model, source: &str, cancel: &dyn Fn() -> bool, progress: &mut dyn FnMut(u64, u64)) -> Result<PathBuf, FetchError> {
    let fail = |e: &dyn std::fmt::Display| FetchError::Failed(e.to_string());
    std::fs::create_dir_all(dir).map_err(|e| fail(&e))?;
    let target = path_of(dir, model);
    let part = target.with_extension("bin.teil");
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(None).timeout_connect(Some(std::time::Duration::from_secs(20))).http_status_as_error(false).build().into();
    let mut response = agent.get(format!("{source}/{}", model.file)).call().map_err(|e| fail(&e))?;
    if !response.status().is_success() {
        return Err(FetchError::Failed(format!("{} auf dem Server", response.status().as_u16())));
    }
    let total = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(model.bytes);
    let mut reader = response.body_mut().as_reader();
    let mut file = std::fs::File::create(&part).map_err(|e| fail(&e))?;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    loop {
        if cancel() {
            drop(file);
            let _ = std::fs::remove_file(&part);
            return Err(FetchError::Cancelled);
        }
        let n = reader.read(&mut buffer).map_err(|e| fail(&e))?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n]).map_err(|e| fail(&e))?;
        done += n as u64;
        progress(done, total);
    }
    file.flush().map_err(|e| fail(&e))?;
    drop(file);
    if done < total || done < model.bytes * 9 / 10 {
        let _ = std::fs::remove_file(&part);
        return Err(FetchError::Failed("Die Datei kam nicht ganz an.".into()));
    }
    std::fs::rename(&part, &target).map_err(|e| fail(&e))?;
    Ok(target)
}
