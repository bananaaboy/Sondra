//! One conversion, made to finish. A port of `src/lib/convertRun.ts`.
//!
//! What goes away: the file is read where it lies (no copy into memory), and there is no second
//! attempt on a single-threaded core, because a native FFmpeg does not have the crashes that
//! needed one. What stays: a failure is said in a sentence, with FFmpeg's own words one step behind
//! it, and a conversion that "succeeds" with an empty file is a failure.

use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;

use crate::convert::{build_args, find_format, Settings};
use crate::ffmpeg::{Cancel, Ffmpeg, MediaError, Progress};

/// A failure, said in a sentence, with FFmpeg's own words kept for the curious.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct ConversionError {
    pub message: String,
    pub detail: String,
    /// The person cancelled; that is not a failure to explain.
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub path: PathBuf,
    pub size: u64,
    /// The command that ran, as it would be typed.
    pub command: String,
}

fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern")
}

/// The first line a person reads. FFmpeg's own last lines stay in `detail`, because they are what
/// anyone who can help will ask for.
pub fn explain(text: &str, label: &str) -> ConversionError {
    let said = |pattern: &str| rx(&format!("(?i){pattern}")).is_match(text);
    let message = if said(
        r"does not contain any stream|matches no streams|Output file .* does not contain",
    ) {
        format!("Die Datei hat nichts, woraus {label} werden kann — zum Beispiel ein Video ohne Tonspur, wenn nur der Ton behalten werden soll.")
    } else if said(
        r"Invalid data found when processing input|moov atom not found|could not find codec parameters|Error opening input|Failed to read frame size",
    ) {
        "Die Datei ist beschädigt oder unvollständig — FFmpeg findet darin keinen lesbaren Anfang."
            .to_owned()
    } else if said(r"Decoder .* not found|Unknown decoder|unsupported codec") {
        "In der Datei steckt ein Codec, den dieses FFmpeg nicht lesen kann.".to_owned()
    } else if said(r"sample rate .* not supported|Specified sample rate") {
        format!("{label} nimmt diese Abtastrate nicht an. Unter „Abtastrate“ eine andere wählen oder „Wie Quelle“ lassen.")
    } else if said(r"Cannot allocate memory|out of memory") {
        "Für diese Datei hat der Arbeitsspeicher nicht gereicht. Kürzer schneiden oder eine kleinere Auflösung wählen hilft.".to_owned()
    } else {
        format!("Die Umwandlung nach {label} hat nicht geklappt.")
    };
    ConversionError {
        message,
        detail: text.trim().to_owned(),
        cancelled: false,
    }
}

/// `dir/name.ext`, or `dir/name (2).ext` when that is taken.
pub fn unique_path(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{extension}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).{extension}"));
        n += 1;
    }
    candidate
}

/// Converts `input` into `dir`, named after `stem`. An existing file is never replaced. The result
/// is written under a temporary name and moved into place when it is whole.
pub fn convert_file(
    ffmpeg: &Ffmpeg,
    input: &Path,
    dir: &Path,
    stem: &str,
    settings: &Settings,
    cancel: &Cancel,
    on_progress: &mut dyn FnMut(Progress),
) -> Result<Outcome, ConversionError> {
    let format = find_format(&settings.format_id).ok_or_else(|| ConversionError {
        message: format!("Unbekanntes Format: {}", settings.format_id),
        detail: String::new(),
        cancelled: false,
    })?;
    let fail = |text: &str| explain(text, format.label);
    fs::create_dir_all(dir).map_err(|e| fail(&e.to_string()))?;
    let target = unique_path(dir, stem, format.extension);
    // The extension has to stay last: FFmpeg picks the muxer from it.
    let temp = dir.join(format!(
        ".sondra-umwandeln-{}.{}",
        std::process::id(),
        format.extension
    ));
    let _ = fs::remove_file(&temp);

    // How long the result will be, for the progress bar.
    let source_length = ffmpeg.probe(input).ok().and_then(|p| p.duration);
    let length = source_length.map(|total| {
        let end = settings.trim_end_seconds.map_or(total, |e| e.min(total));
        (end - settings.trim_start_seconds.unwrap_or(0.0)).max(0.0)
    });

    let args = build_args(&input.to_string_lossy(), &temp.to_string_lossy(), settings)
        .map_err(|e| fail(&e.to_string()))?;
    let command = crate::convert::preview_command(&args);

    match ffmpeg.run(&args, length, cancel, on_progress) {
        Ok(()) => {}
        Err(MediaError::Cancelled) => {
            let _ = fs::remove_file(&temp);
            return Err(ConversionError {
                message: "Abgebrochen.".into(),
                detail: String::new(),
                cancelled: true,
            });
        }
        Err(MediaError::Failed { tail, .. }) => {
            let _ = fs::remove_file(&temp);
            return Err(explain(&tail, format.label));
        }
        Err(other) => {
            let _ = fs::remove_file(&temp);
            return Err(ConversionError {
                message: other.to_string(),
                detail: String::new(),
                cancelled: false,
            });
        }
    }

    let size = fs::metadata(&temp).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        let _ = fs::remove_file(&temp);
        return Err(ConversionError {
            message: "FFmpeg ist fertig geworden, hat aber eine leere Datei geschrieben.".into(),
            detail: String::new(),
            cancelled: false,
        });
    }
    fs::rename(&temp, &target).map_err(|e| fail(&e.to_string()))?;
    Ok(Outcome {
        path: target,
        size,
        command,
    })
}
