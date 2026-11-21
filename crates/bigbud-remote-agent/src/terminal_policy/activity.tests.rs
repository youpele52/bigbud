//! Fake-clock tests for the §8.5 idle state machine and the three busy definitions.

use super::{ActivityTracker, Clock, FakeClock, IdleEvent, IdleTimings, OwnerHint, ViewState};

const MINUTE: u64 = 60_000;
const T0: u64 = 10_000_000;

/// A managed, hidden PTY created a minute before `T0` whose last output is at `T0`.
fn quiet_since_t0() -> (FakeClock, ActivityTracker) {
    let clock = FakeClock::new(T0 - MINUTE);
    let mut tracker = ActivityTracker::new(true, clock.now_ms());
    clock.set(T0);
    tracker.record_output(clock.now_ms());
    (clock, tracker)
}

fn tick(tracker: &mut ActivityTracker, clock: &FakeClock, at: u64) -> Option<IdleEvent> {
    clock.set(at);
    tracker.evaluate_idle(clock.now_ms(), IdleTimings::default())
}

fn warning(closes_at: u64) -> Option<IdleEvent> {
    Some(IdleEvent::Warning { closes_at })
}

#[test]
fn warns_at_nine_minutes_and_closes_at_ten() {
    let (clock, mut tracker) = quiet_since_t0();
    assert_eq!(tick(&mut tracker, &clock, T0 + 9 * MINUTE - 1), None);
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 9 * MINUTE),
        warning(T0 + 10 * MINUTE)
    );
    assert_eq!(tracker.warning_closes_at(), Some(T0 + 10 * MINUTE));
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 9 * MINUTE + 1),
        None,
        "warned once per period"
    );
    assert_eq!(tick(&mut tracker, &clock, T0 + 10 * MINUTE - 1), None);
    assert!(!tracker.still_idle(clock.now_ms()));
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 10 * MINUTE),
        Some(IdleEvent::Close)
    );
    assert!(tracker.still_idle(clock.now_ms()));
}

#[test]
fn output_after_the_warning_clears_it_and_the_warning_returns_nine_minutes_later() {
    let (clock, mut tracker) = quiet_since_t0();
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 9 * MINUTE),
        warning(T0 + 10 * MINUTE)
    );
    let output_at = T0 + 9 * MINUTE + 30_000;
    clock.set(output_at);
    tracker.record_output(clock.now_ms());
    assert_eq!(
        tick(&mut tracker, &clock, output_at),
        Some(IdleEvent::WarningCleared)
    );
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 10 * MINUTE),
        None,
        "no close in the new period"
    );
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 18 * MINUTE + 30_000 - 1),
        None
    );
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 18 * MINUTE + 30_000),
        warning(T0 + 19 * MINUTE + 30_000)
    );
}

#[test]
fn a_clear_re_arms_the_next_warning() {
    let (clock, mut tracker) = quiet_since_t0();
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 9 * MINUTE),
        warning(T0 + 10 * MINUTE)
    );
    let keep_open_at = T0 + 9 * MINUTE + 10_000;
    tracker.keep_open(keep_open_at);
    assert_eq!(
        tick(&mut tracker, &clock, keep_open_at),
        Some(IdleEvent::WarningCleared)
    );
    assert_eq!(tracker.warning_closes_at(), None);
    assert_eq!(
        tick(&mut tracker, &clock, keep_open_at + 9 * MINUTE),
        warning(keep_open_at + 10 * MINUTE),
        "the cleared warning is armed again for the new quiet period"
    );
    assert_eq!(
        tick(&mut tracker, &clock, keep_open_at + 10 * MINUTE),
        Some(IdleEvent::Close)
    );
}

#[test]
fn a_foreground_program_blocks_the_warning_and_the_close() {
    let (clock, mut tracker) = quiet_since_t0();
    tracker.set_foreground_program(true, T0 + MINUTE);
    for minute in [9, 10, 30, 120] {
        assert_eq!(tick(&mut tracker, &clock, T0 + minute * MINUTE), None);
        assert!(!tracker.still_idle(clock.now_ms()));
    }
    // A warning already showing is cleared when a program starts.
    let (clock, mut tracker) = quiet_since_t0();
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 9 * MINUTE),
        warning(T0 + 10 * MINUTE)
    );
    tracker.set_foreground_program(true, T0 + 9 * MINUTE + 1);
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 9 * MINUTE + 1),
        Some(IdleEvent::WarningCleared)
    );
    assert_eq!(tick(&mut tracker, &clock, T0 + 10 * MINUTE), None);
    // The program ending starts a fresh quiet period instead of closing at once.
    let ended = T0 + 20 * MINUTE;
    tracker.set_foreground_program(false, ended);
    assert_eq!(tick(&mut tracker, &clock, ended + 1), None);
    assert_eq!(
        tick(&mut tracker, &clock, ended + 9 * MINUTE),
        warning(ended + 10 * MINUTE)
    );
}

#[test]
fn responder_replies_do_not_move_last_input_or_clear_a_warning() {
    let (clock, mut tracker) = quiet_since_t0();
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 9 * MINUTE),
        warning(T0 + 10 * MINUTE)
    );
    tracker.record_responder_reply(T0 + 9 * MINUTE + 5_000);
    assert_eq!(tracker.last_input(), None);
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 10 * MINUTE),
        Some(IdleEvent::Close)
    );
    tracker.record_input(T0 + 10 * MINUTE);
    assert_eq!(tracker.last_input(), Some(T0 + 10 * MINUTE));
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 10 * MINUTE),
        Some(IdleEvent::WarningCleared)
    );
}

#[test]
fn output_aging_out_of_a_window_never_clears_a_warning() {
    let (clock, mut tracker) = quiet_since_t0();
    assert!(tracker.sidebar_busy(T0 + 59_999));
    assert!(!tracker.sidebar_busy(T0 + MINUTE));
    assert!(tracker.pressure_busy(T0 + 9 * MINUTE));
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 9 * MINUTE),
        warning(T0 + 10 * MINUTE)
    );
    // The 10-minute pressure window ages out exactly at the close; the warning stands.
    assert!(!tracker.pressure_busy(T0 + 10 * MINUTE));
    assert_eq!(
        tick(&mut tracker, &clock, T0 + 10 * MINUTE),
        Some(IdleEvent::Close)
    );
}

#[test]
fn a_visible_terminal_is_never_idle_and_hiding_starts_a_new_period() {
    let (clock, mut tracker) = quiet_since_t0();
    tracker.set_view_state(ViewState::Visible, T0 + MINUTE);
    assert_eq!(tick(&mut tracker, &clock, T0 + 60 * MINUTE), None);
    let hidden_at = T0 + 60 * MINUTE;
    tracker.set_view_state(ViewState::Hidden, hidden_at);
    assert_eq!(tick(&mut tracker, &clock, hidden_at + 9 * MINUTE - 1), None);
    assert_eq!(
        tick(&mut tracker, &clock, hidden_at + 9 * MINUTE),
        warning(hidden_at + 10 * MINUTE)
    );
    tracker.set_view_state(ViewState::Visible, hidden_at + 9 * MINUTE + 1);
    assert_eq!(
        tick(&mut tracker, &clock, hidden_at + 9 * MINUTE + 1),
        Some(IdleEvent::WarningCleared)
    );
}

#[test]
fn output_right_after_a_host_resize_is_a_redraw_not_activity() {
    let (_, mut tracker) = quiet_since_t0();
    tracker.record_resize_applied(T0 + 5 * MINUTE);
    tracker.record_output(T0 + 5 * MINUTE + 999);
    assert_eq!(tracker.last_output(), Some(T0));
    tracker.record_output(T0 + 5 * MINUTE + 1_000);
    assert_eq!(tracker.last_output(), Some(T0 + 5 * MINUTE + 1_000));
}

#[test]
fn owner_hints_split_across_the_three_busy_uses() {
    let (_, mut tracker) = quiet_since_t0();
    let later = T0 + 30 * MINUTE;
    tracker.set_owner_hint(Some(OwnerHint::Unknown), T0);
    assert!(tracker.idle_busy() && tracker.pressure_busy(later));
    assert!(
        !tracker.sidebar_busy(later),
        "unknown shows muted in the sidebar"
    );
    tracker.set_owner_hint(Some(OwnerHint::Busy), T0);
    assert!(tracker.idle_busy() && tracker.pressure_busy(later) && tracker.sidebar_busy(later));
    tracker.set_owner_hint(Some(OwnerHint::Idle), T0);
    assert!(!tracker.idle_busy() && !tracker.pressure_busy(later) && !tracker.sidebar_busy(later));
    // Output 5 minutes ago: pressure-busy, but the sidebar is muted and idle ignores it.
    tracker.record_output(later - 5 * MINUTE);
    assert!(tracker.pressure_busy(later) && !tracker.sidebar_busy(later) && !tracker.idle_busy());
}

#[test]
fn a_late_tick_still_gives_the_full_warning_lead_and_unmanaged_ptys_never_warn() {
    let (clock, mut tracker) = quiet_since_t0();
    let late = T0 + 45 * MINUTE;
    assert_eq!(tick(&mut tracker, &clock, late), warning(late + MINUTE));
    assert_eq!(
        tick(&mut tracker, &clock, late + MINUTE),
        Some(IdleEvent::Close)
    );
    let mut unmanaged = ActivityTracker::new(false, T0);
    assert_eq!(
        unmanaged.evaluate_idle(T0 + 60 * MINUTE, IdleTimings::default()),
        None
    );
    assert!(!unmanaged.still_idle(T0 + 60 * MINUTE));
}
