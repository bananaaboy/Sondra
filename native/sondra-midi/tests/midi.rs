use sondra_midi::{pad_of, parse, Input, Message};

#[test]
fn notes_map_to_pads_as_on_the_website() {
    // General MIDI drums and the MPC: 36 is the first pad, 51 the sixteenth.
    assert_eq!((pad_of(36), pad_of(37), pad_of(51)), (0, 1, 15));
    // 52 to 63 count from 48, 64 to 75 from 60.
    assert_eq!((pad_of(52), pad_of(63), pad_of(64), pad_of(75)), (4, 15, 4, 15));
    // The rest wraps into the sixteen.
    assert_eq!((pad_of(0), pad_of(35), pad_of(76), pad_of(127)), (0, 3, 12, 15));
    for note in 0..=127u8 {
        assert!(pad_of(note) < 16);
    }
}

#[test]
fn bytes_are_notes_on_and_off_and_nothing_else() {
    assert_eq!(parse(&[0x90, 36, 127]), Some(Message::NoteOn { pad: 0, velocity: 1.0, note: 36 }));
    // Another channel is the same pad.
    let Some(Message::NoteOn { pad, velocity, .. }) = parse(&[0x95, 38, 64]) else { panic!("a note") };
    assert_eq!(pad, 2);
    assert!((velocity - 64.0 / 127.0).abs() < 1e-9);
    // The softest strike is not silence.
    let Some(Message::NoteOn { velocity, .. }) = parse(&[0x90, 36, 1]) else { panic!("a note") };
    assert!(velocity >= 0.01);
    // A note on with velocity 0 is a note off, as is the note off message.
    assert_eq!(parse(&[0x90, 36, 0]), Some(Message::NoteOff { pad: 0, note: 36 }));
    assert_eq!(parse(&[0x80, 40, 64]), Some(Message::NoteOff { pad: 4, note: 40 }));
    // Controllers, pitch bend, a message that is cut short.
    assert_eq!(parse(&[0xB0, 1, 50]), None);
    assert_eq!(parse(&[0xE0, 0, 64]), None);
    assert_eq!(parse(&[0x90, 36]), None);
    assert_eq!(parse(&[]), None);
}

#[test]
fn where_there_is_no_midi_there_is_no_panic() {
    // A build machine has no controller; whether it has the system's MIDI at all differs, and neither may break.
    if let Some(input) = Input::connect() {
        assert!(input.poll().is_empty() || !input.devices.is_empty());
    }
}
