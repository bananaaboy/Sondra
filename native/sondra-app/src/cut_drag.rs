//! Moving the cuts on the waveform of „Zerschneiden“: a press near a cut takes hold of it, a drag moves it, and
//! the pads on both sides follow — a pad is never shorter than 15 ms (the web player's regions are not either).

/// The shortest a pad may become, in seconds.
pub const MIN_PAD: f64 = 0.015;

/// What the pointer holds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Grab {
    /// The cut between pad `n - 1` and pad `n`: both edges move as one.
    Joint(usize),
    /// The start of pad `n` where nothing touches it on the left (the very start, or after a gap).
    Start(usize),
    /// The end of pad `n` where nothing touches it on the right.
    End(usize),
}

/// The cut within `tolerance` seconds of `at`, the nearest one; `None` when nothing is that close. `pads` are
/// (start, end) in order.
pub fn grab_at(pads: &[(f64, f64)], at: f64, tolerance: f64) -> Option<Grab> {
    let mut best: Option<(f64, Grab)> = None;
    let mut offer = |distance: f64, grab: Grab| {
        if distance <= tolerance && best.as_ref().is_none_or(|(d, _)| distance < *d) {
            best = Some((distance, grab));
        }
    };
    for (i, (start, end)) in pads.iter().enumerate() {
        let touches_before = i > 0 && (pads[i - 1].1 - start).abs() < 1e-6;
        if touches_before {
            offer((at - start).abs(), Grab::Joint(i));
        } else {
            offer((at - start).abs(), Grab::Start(i));
        }
        let touches_after = pads.get(i + 1).is_some_and(|next| (end - next.0).abs() < 1e-6);
        if !touches_after {
            offer((at - end).abs(), Grab::End(i));
        }
    }
    best.map(|(_, g)| g)
}

/// Where the held cut may go: not past the neighbours, and every pad stays at least `MIN_PAD` long.
fn limits(pads: &[(f64, f64)], grab: Grab, total: f64) -> (f64, f64) {
    match grab {
        Grab::Joint(i) => (pads[i - 1].0 + MIN_PAD, pads[i].1 - MIN_PAD),
        Grab::Start(i) => (if i == 0 { 0.0 } else { pads[i - 1].1 }, pads[i].1 - MIN_PAD),
        Grab::End(i) => (pads[i].0 + MIN_PAD, pads.get(i + 1).map_or(total, |next| next.0)),
    }
}

/// The pads with the held cut moved to `to` (held between its limits).
pub fn drag(pads: &[(f64, f64)], grab: Grab, to: f64, total: f64) -> Vec<(f64, f64)> {
    let mut out = pads.to_vec();
    let (lo, hi) = limits(pads, grab, total);
    let to = to.clamp(lo, hi.max(lo));
    match grab {
        Grab::Joint(i) => {
            out[i - 1].1 = to;
            out[i].0 = to;
        }
        Grab::Start(i) => out[i].0 = to,
        Grab::End(i) => out[i].1 = to,
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PADS: [(f64, f64); 3] = [(0.0, 1.0), (1.0, 2.0), (2.5, 3.0)];

    #[test]
    fn the_nearest_cut_is_grabbed_and_a_touching_pair_moves_as_one() {
        assert_eq!(grab_at(&PADS, 1.02, 0.05), Some(Grab::Joint(1)));
        assert_eq!(grab_at(&PADS, 0.98, 0.05), Some(Grab::Joint(1)));
        assert_eq!(grab_at(&PADS, 1.5, 0.05), None, "the middle of a pad is no cut");
        // Across a gap the two edges are two things.
        assert_eq!(grab_at(&PADS, 2.01, 0.05), Some(Grab::End(1)));
        assert_eq!(grab_at(&PADS, 2.49, 0.05), Some(Grab::Start(2)));
        // The very ends can be moved too.
        assert_eq!(grab_at(&PADS, 0.01, 0.05), Some(Grab::Start(0)));
        assert_eq!(grab_at(&PADS, 2.99, 0.05), Some(Grab::End(2)));
    }

    #[test]
    fn a_joint_moves_both_pads_and_stops_short_of_making_one_too_short() {
        let moved = drag(&PADS, Grab::Joint(1), 1.4, 3.0);
        assert_eq!(moved[0], (0.0, 1.4));
        assert_eq!(moved[1], (1.4, 2.0));
        assert_eq!(moved[2], PADS[2], "the rest is as it was");
        let low = drag(&PADS, Grab::Joint(1), -5.0, 3.0);
        assert!((low[0].1 - MIN_PAD).abs() < 1e-9);
        let high = drag(&PADS, Grab::Joint(1), 9.0, 3.0);
        assert!((high[1].0 - (2.0 - MIN_PAD)).abs() < 1e-9);
    }

    #[test]
    fn an_edge_after_a_gap_stays_between_its_neighbours() {
        let end = drag(&PADS, Grab::End(1), 9.0, 3.0);
        assert_eq!(end[1].1, 2.5, "no further than the next pad's start");
        let start = drag(&PADS, Grab::Start(2), 0.0, 3.0);
        assert_eq!(start[2].0, 2.0, "no further back than the previous pad's end");
        let first = drag(&PADS, Grab::Start(0), -1.0, 3.0);
        assert_eq!(first[0].0, 0.0);
        let last = drag(&PADS, Grab::End(2), 9.0, 3.0);
        assert_eq!(last[2].1, 3.0, "not past the end of the sound");
    }
}
