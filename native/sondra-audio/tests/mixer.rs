//! What goes to the speakers and what has been heard — without a sound card.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use sondra_audio::{Mixer, Shared};

fn no_stop() -> AtomicBool {
    AtomicBool::new(false)
}

#[test]
fn sound_comes_out_at_the_volume_and_the_clock_counts_only_what_was_heard() {
    let shared = Shared::new(10, 2, 1.0);
    let mut mixer = Mixer::new(shared.clone());
    assert!(shared.push(&[1.0, -1.0, 0.5, -0.5, 0.25, -0.25], &no_stop()));
    assert_eq!(shared.buffered(), 0.3, "three frames at ten a second");
    let mut out = [9.0f32; 4];
    assert_eq!(mixer.fill(&mut out), 2, "two frames of real sound");
    assert_eq!(out, [1.0, -1.0, 0.5, -0.5]);
    assert_eq!(shared.heard(), 0.2);
    // The rest is short: one frame of sound, then silence — and the silence is not counted.
    let mut out = [9.0f32; 6];
    assert_eq!(mixer.fill(&mut out), 1);
    assert_eq!(out, [0.25, -0.25, 0.0, 0.0, 0.0, 0.0]);
    assert!((shared.heard() - 0.3).abs() < 1e-9);
    assert_eq!(mixer.fill(&mut [1.0f32; 4]), 0, "nothing left: the clock stands still");
    assert!((shared.heard() - 0.3).abs() < 1e-9);

    shared.set_volume(0.5);
    shared.push(&[1.0, 1.0], &no_stop());
    let mut out = [0.0f32; 2];
    mixer.fill(&mut out);
    assert_eq!(out, [0.5, 0.5]);
    shared.set_volume(100.0);
    assert_eq!(shared.volume(), 4.0, "a volume has its limit");
    shared.set_volume(-1.0);
    assert_eq!(shared.volume(), 0.0);
}

#[test]
fn pause_is_silence_that_keeps_the_sound_and_the_clock_where_they_were() {
    let shared = Shared::new(10, 1, 1.0);
    let mut mixer = Mixer::new(shared.clone());
    shared.push(&[0.1, 0.2, 0.3, 0.4], &no_stop());
    let mut out = [0.0f32; 2];
    mixer.fill(&mut out);
    shared.set_paused(true);
    assert!(shared.paused());
    let mut out = [9.0f32; 2];
    assert_eq!(mixer.fill(&mut out), 0);
    assert_eq!(out, [0.0, 0.0]);
    assert_eq!(shared.heard(), 0.2);
    assert_eq!(shared.buffered(), 0.2, "what was waiting still waits");
    shared.set_paused(false);
    let mut out = [0.0f32; 2];
    assert_eq!(mixer.fill(&mut out), 2);
    assert_eq!(out, [0.3, 0.4]);
}

#[test]
fn a_jump_throws_the_old_sound_away_and_starts_the_clock_again() {
    let shared = Shared::new(10, 2, 1.0);
    let mut mixer = Mixer::new(shared.clone());
    shared.push(&[1.0; 8], &no_stop());
    mixer.fill(&mut [0.0f32; 4]);
    assert_eq!(shared.heard(), 0.2);
    shared.clear();
    assert_eq!(shared.heard(), 0.0);
    assert_eq!(shared.buffered(), 0.0);
    assert_eq!(mixer.fill(&mut [5.0f32; 4]), 0);
}

#[test]
fn a_half_frame_is_never_played() {
    let shared = Shared::new(10, 2, 1.0);
    let mut mixer = Mixer::new(shared.clone());
    shared.push(&[1.0, 2.0, 3.0], &no_stop());
    let mut out = [9.0f32; 4];
    assert_eq!(mixer.fill(&mut out), 1);
    assert_eq!(out, [1.0, 2.0, 0.0, 0.0], "the third sample waits for its partner");
    shared.push(&[4.0], &no_stop());
    let mut out = [9.0f32; 2];
    assert_eq!(mixer.fill(&mut out), 1);
    assert_eq!(out, [3.0, 4.0], "and the channels did not shift");
}

#[test]
fn a_full_queue_makes_the_decoder_wait_until_the_speakers_take_sound_or_it_is_told_to_stop() {
    // Room for one second at ten frames a second: ten samples.
    let shared = Shared::new(10, 1, 1.0);
    let stop = Arc::new(AtomicBool::new(false));
    let pusher = {
        let (shared, stop) = (shared.clone(), stop.clone());
        std::thread::spawn(move || shared.push(&[1.0; 25], &stop))
    };
    std::thread::sleep(Duration::from_millis(150));
    assert!(!pusher.is_finished(), "twenty-five samples do not fit: it waits");
    assert_eq!(shared.buffered(), 1.0, "and the queue is as full as it is allowed to be");
    let mut mixer = Mixer::new(shared.clone());
    let mut out = [0.0f32; 10];
    mixer.fill(&mut out);
    std::thread::sleep(Duration::from_millis(100));
    mixer.fill(&mut out);
    std::thread::sleep(Duration::from_millis(100));
    mixer.fill(&mut out);
    assert!(pusher.join().unwrap(), "after the speakers took sound all of it went in");

    // Told to stop while waiting: it gives up, and says so.
    let shared = Shared::new(10, 1, 1.0);
    let stop = Arc::new(AtomicBool::new(false));
    let pusher = {
        let (shared, stop) = (shared.clone(), stop.clone());
        std::thread::spawn(move || shared.push(&[1.0; 50], &stop))
    };
    std::thread::sleep(Duration::from_millis(100));
    stop.store(true, Ordering::Relaxed);
    assert!(!pusher.join().unwrap());
}

#[test]
fn the_device_opens_or_says_there_is_none_and_never_panics() {
    // A build server has no sound card; a person's computer has one. Either answer is fine, a crash is not.
    match sondra_audio::AudioOut::open(0.5) {
        Ok(out) => {
            let shared = out.shared();
            shared.set_volume(0.0);
            let samples = vec![0.0f32; shared.rate() as usize / 10 * shared.channels()];
            assert!(shared.push(&samples, &no_stop()));
            std::thread::sleep(Duration::from_millis(400));
            assert!(shared.heard() > 0.0, "the speakers took the sound, and the clock moved");
        }
        Err(error) => println!("no sound here: {error}"),
    }
}
