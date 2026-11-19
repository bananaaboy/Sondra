use sondra_media::cue::*;

fn slice(a: f64, b: f64, n: Option<&str>) -> ExportSlice {
    ExportSlice { start: a, end: b, name: n.map(str::to_owned) }
}

#[test]
fn the_cut_points_are_written_as_the_other_programs_read_them() {
    assert_eq!(format_cue_time(0.0), "00:00:00");
    assert_eq!(format_cue_time(61.5), "01:01:37");
    assert_eq!(format_cue_time(-3.0), "00:00:00");
    let slices = [slice(0.0, 1.25, None), slice(1.25, 2.0, Some("Snare"))];
    assert_eq!(
        create_cue_sheet("Break.wav", &slices, "Break"),
        "TITLE \"Break\"\nFILE \"Break.wav\" WAVE\n  TRACK 01 AUDIO\n    TITLE \"Pad 01\"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE \"Snare\"\n    INDEX 01 00:01:18\n"
    );
    assert_eq!(create_audacity_labels(&slices), "0.000000\t1.250000\tPad 01\n1.250000\t2.000000\tSnare\n");
    assert_eq!(create_reaper_csv(&slices), "#\tName\tStart\tEnd\tLength\nR1\tPad 01\t0.000\t1.250\t1.250\nR2\tSnare\t1.250\t2.000\t0.750\n");
}
