//! The cut points as text for other programs: a CUE sheet (players, burning programs), Audacity labels, a
//! Reaper region list. A port of `src/lib/cueExport.ts`.

#[derive(Debug, Clone, PartialEq)]
pub struct ExportSlice {
    pub start: f64,
    pub end: f64,
    pub name: Option<String>,
}

/// Seconds as the CUE sheet's `mm:ss:ff`, 75 frames to the second.
pub fn format_cue_time(seconds: f64) -> String {
    let total = seconds.max(0.0);
    let minutes = (total / 60.0).floor() as u64;
    let secs = (total % 60.0).floor() as u64;
    let frames = ((total % 1.0) * 75.0).floor() as u64;
    format!("{minutes:02}:{secs:02}:{frames:02}")
}

fn title_of(slice: &ExportSlice, index: usize) -> String {
    match &slice.name {
        Some(n) if !n.is_empty() => n.clone(),
        _ => format!("Pad {:02}", index + 1),
    }
}

pub fn create_cue_sheet(audio_file_name: &str, slices: &[ExportSlice], album_title: &str) -> String {
    let mut lines = vec![format!("TITLE \"{album_title}\""), format!("FILE \"{audio_file_name}\" WAVE")];
    for (index, slice) in slices.iter().enumerate() {
        lines.push(format!("  TRACK {:02} AUDIO", index + 1));
        lines.push(format!("    TITLE \"{}\"", title_of(slice, index)));
        lines.push(format!("    INDEX 01 {}", format_cue_time(slice.start)));
    }
    lines.join("\n") + "\n"
}

/// Audacity's label track: start, end and a name, tab-separated.
pub fn create_audacity_labels(slices: &[ExportSlice]) -> String {
    slices.iter().enumerate().map(|(i, s)| format!("{:.6}\t{:.6}\t{}", s.start, s.end, title_of(s, i))).collect::<Vec<_>>().join("\n") + "\n"
}

pub fn create_reaper_csv(slices: &[ExportSlice]) -> String {
    let mut rows = vec!["#\tName\tStart\tEnd\tLength".to_string()];
    for (i, s) in slices.iter().enumerate() {
        rows.push(format!("R{}\t{}\t{:.3}\t{:.3}\t{:.3}", i + 1, title_of(s, i), s.start, s.end, (s.end - s.start).max(0.0)));
    }
    rows.join("\n") + "\n"
}
