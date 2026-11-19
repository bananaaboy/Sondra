use sondra_ui::motion::*;
use std::time::Duration;

#[test]
fn the_curves_start_at_nothing_end_at_everything_and_never_go_back() {
    for curve in [ease_out as fn(f32) -> f32, ease_settle] {
        assert!(curve(0.0).abs() < 1e-3);
        assert!((curve(1.0) - 1.0).abs() < 1e-3);
        let mut last = 0.0;
        for i in 1..=100 {
            let v = curve(i as f32 / 100.0);
            assert!(v >= last - 1e-4, "monotonic at {i}");
            last = v;
        }
        // An ease-out has done most of its work early.
        assert!(curve(0.3) > 0.45);
    }
    // The exponential one is the faster of the two at the start.
    assert!(ease_settle(0.2) > ease_out(0.2));
    // Worked out apart from the code (bisection on x(s) = 0.5 gives s = 0.693, y = 0.916): halfway through the time it is
    // already 92 % of the way.
    assert!((ease_out(0.5) - 0.916).abs() < 0.01, "{}", ease_out(0.5));
}

#[test]
fn a_list_waits_for_its_turn_and_never_longer_than_a_quarter_second() {
    assert_eq!(stagger(0), Duration::ZERO);
    assert_eq!(stagger(3), Duration::from_millis(90));
    assert_eq!(stagger(40), Duration::from_millis(240));
    let total = Duration::from_millis(90 + 240);
    // Before its turn nothing has moved; at the end all of it has.
    assert!(progress(0.1, total, Duration::from_millis(90), BASE) < 1e-5);
    assert!((progress(1.0, total, Duration::from_millis(90), BASE) - 1.0).abs() < 1e-3);
}

#[test]
fn reduced_motion_is_a_switch() {
    set_reduced(true);
    assert!(reduced());
    set_reduced(false);
    assert!(!reduced());
}
