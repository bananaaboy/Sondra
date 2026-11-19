//! Subtitle files into cues.

use sondra_player::cues::*;

#[test]
fn a_subrip_file_becomes_cues_with_times_and_words() {
    let srt = "\u{feff}1\r\n00:00:01,000 --> 00:00:02,500\r\nHallo\r\n\r\n2\r\n00:01:02,003 --> 01:01:02,999\r\n<i>Noch</i> eine\r\nin zwei Zeilen\r\n\r\n3\r\n00:02:00,000 --> 00:02:01,000\r\n{\\an8}Oben &amp; <b>fett</b>\r\n";
    let cues = parse_cues(srt);
    assert_eq!(cues.len(), 3);
    assert_eq!(cues[0], Cue { start: 1.0, end: 2.5, text: "Hallo".into() });
    assert_eq!(cues[1].start, 62.003);
    assert_eq!(cues[1].end, 3662.999);
    assert_eq!(cues[1].text, "Noch eine\nin zwei Zeilen");
    assert_eq!(cues[2].text, "Oben & fett");
}

#[test]
fn a_webvtt_file_with_settings_notes_and_short_times() {
    let vtt = "WEBVTT - Titel\n\nNOTE ein Kommentar\nüber zwei Zeilen\n\nkap-1\n00:05.000 --> 00:07.500 align:start position:10%\n<v Frieren>Guten Tag.</v>\n\n00:09.000 --> 00:08.000\nverkehrt herum\n\n00:10.000 --> 00:11.000\n\n01:00:00.000 --> 01:00:01.000\n<c.gelb>spät</c>\n";
    let cues = parse_cues(vtt);
    let shape: Vec<(f64, f64, &str)> = cues.iter().map(|c| (c.start, c.end, c.text.as_str())).collect();
    assert_eq!(shape, [(5.0, 7.5, "Guten Tag."), (3600.0, 3601.0, "spät")], "a note, an upside-down time and an empty cue are not cues");
}

#[test]
fn the_cue_of_a_moment_and_overlaps_and_order() {
    let cues = parse_cues("1\n00:00:05,000 --> 00:00:09,000\nzweite\n\n2\n00:00:01,000 --> 00:00:06,000\nerste\n");
    assert_eq!(cues[0].text, "erste", "in the order of the start");
    let at = |t: f64| -> Vec<&str> { cues_at(&cues, t).iter().map(|c| c.text.as_str()).collect() };
    assert!(at(0.9).is_empty());
    assert_eq!(at(1.0), ["erste"]);
    assert_eq!(at(5.5), ["erste", "zweite"], "two at once, the earlier first");
    assert_eq!(at(6.0), ["zweite"], "the end is not part of the cue");
    assert!(at(9.0).is_empty());
    assert!(parse_cues("").is_empty());
    assert!(parse_cues("kein Untertitel, nur Text").is_empty());
}
