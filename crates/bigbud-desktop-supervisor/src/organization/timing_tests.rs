use super::{CleanupRule, CleanupTiming, ClockSample, RuleWait};

const WAIT: RuleWait = RuleWait {
    enabled: true,
    timeout_ms: 60_000,
};

fn clock(ms: u32) -> ClockSample {
    ClockSample {
        wall_ms: i64::from(ms),
        monotonic_ms: u64::from(ms),
    }
}

fn cutoffs(timing: &mut CleanupTiming, now: ClockSample) -> (Option<i64>, Option<i64>) {
    let [(older_rule, older), (idle_rule, idle)] = timing.due_cutoffs(now, WAIT, WAIT);
    assert_eq!(older_rule, CleanupRule::Older);
    assert_eq!(idle_rule, CleanupRule::Idle);
    (older, idle)
}

#[test]
fn startup_preserves_older_age_and_waits_full_short_timeout() {
    let mut timing = CleanupTiming::new(clock(120_000), None);
    assert_eq!(cutoffs(&mut timing, clock(120_000)), (Some(60_000), None));
    for ms in [135_000, 150_000, 165_000, 179_999] {
        let (_, idle) = cutoffs(&mut timing, clock(ms));
        assert_eq!(idle, None);
    }
    assert_eq!(
        cutoffs(&mut timing, clock(180_000)),
        (Some(120_000), Some(120_000))
    );
}

#[test]
fn restart_restores_older_policy_barrier_instead_of_starting_it_again() {
    let mut timing = CleanupTiming::new(clock(0), None);
    timing.policy_changed(CleanupRule::Older, clock(10_000));
    let mut restarted = CleanupTiming::new(clock(65_000), timing.older_policy_changed_at_ms());
    assert_eq!(cutoffs(&mut restarted, clock(69_999)), (None, None));
    assert_eq!(cutoffs(&mut restarted, clock(70_000)), (Some(10_000), None));
}

#[test]
fn sleep_does_not_erase_elapsed_older_policy_grace() {
    let mut timing = CleanupTiming::new(clock(0), Some(10_000));
    assert_eq!(cutoffs(&mut timing, clock(120_000)), (Some(60_000), None));
    assert_eq!(timing.older_policy_changed_at_ms(), Some(10_000));
    for ms in [135_000, 150_000, 165_000] {
        let (_, idle) = cutoffs(&mut timing, clock(ms));
        assert_eq!(idle, None);
    }
    assert_eq!(
        cutoffs(&mut timing, clock(180_000)),
        (Some(120_000), Some(120_000))
    );
}

#[test]
fn exact_discontinuity_boundary_does_not_restart_short_wait() {
    let mut timing = CleanupTiming::new(clock(0), None);
    assert_eq!(
        cutoffs(&mut timing, clock(75_000)),
        (Some(15_000), Some(15_000))
    );
    let mut over = CleanupTiming::new(clock(0), None);
    assert_eq!(cutoffs(&mut over, clock(75_001)), (Some(15_001), None));
}

#[test]
fn idle_policy_change_does_not_reset_older_policy_wait() {
    let mut timing = CleanupTiming::new(clock(0), Some(0));
    assert_eq!(cutoffs(&mut timing, clock(30_000)), (None, None));
    timing.policy_changed(CleanupRule::Idle, clock(30_000));
    assert_eq!(cutoffs(&mut timing, clock(60_000)), (Some(0), None));
    assert_eq!(
        cutoffs(&mut timing, clock(90_000)),
        (Some(30_000), Some(30_000))
    );
}

#[test]
fn older_policy_change_does_not_reset_short_wait() {
    let mut timing = CleanupTiming::new(clock(0), None);
    assert_eq!(cutoffs(&mut timing, clock(30_000)), (Some(-30_000), None));
    timing.policy_changed(CleanupRule::Older, clock(30_000));
    assert_eq!(cutoffs(&mut timing, clock(60_000)), (None, Some(0)));
    assert_eq!(
        cutoffs(&mut timing, clock(90_000)),
        (Some(30_000), Some(30_000))
    );
}

#[test]
fn disabled_rules_never_produce_cutoffs_and_enabling_grants_a_new_wait() {
    let mut timing = CleanupTiming::new(clock(0), None);
    let disabled = RuleWait {
        enabled: false,
        ..WAIT
    };
    assert_eq!(
        timing.due_cutoffs(clock(60_000), disabled, disabled),
        [(CleanupRule::Older, None), (CleanupRule::Idle, None)]
    );
    timing.policy_changed(CleanupRule::Idle, clock(60_000));
    timing.policy_changed(CleanupRule::Older, clock(60_000));
    assert_eq!(cutoffs(&mut timing, clock(119_999)), (None, None));
    assert_eq!(
        cutoffs(&mut timing, clock(120_000)),
        (Some(60_000), Some(60_000))
    );
}

#[test]
fn repeated_observations_do_not_renew_policy_grace() {
    let mut timing = CleanupTiming::new(clock(0), Some(0));
    for ms in [15_000, 30_000, 45_000] {
        assert_eq!(cutoffs(&mut timing, clock(ms)), (None, None));
    }
    assert_eq!(cutoffs(&mut timing, clock(60_000)), (Some(0), Some(0)));
    assert_eq!(timing.older_policy_changed_at_ms(), Some(0));
}

#[test]
fn backward_wall_time_restarts_short_wait_but_keeps_durable_older_barrier() {
    let mut timing = CleanupTiming::new(clock(60_000), Some(60_000));
    let backwards = ClockSample {
        wall_ms: 30_000,
        monotonic_ms: 75_000,
    };
    assert_eq!(cutoffs(&mut timing, backwards), (None, None));
    assert_eq!(timing.older_policy_changed_at_ms(), Some(60_000));
    for wall_ms in [60_000_u32, 89_999, 90_000] {
        let now = ClockSample {
            wall_ms: i64::from(wall_ms),
            monotonic_ms: u64::from(wall_ms) + 45_000,
        };
        let (older, idle) = cutoffs(&mut timing, now);
        assert_eq!(older, None);
        assert_eq!(idle, (wall_ms == 90_000).then_some(30_000));
    }
}

#[test]
fn small_forward_wall_correction_cannot_shorten_live_idle_wait() {
    let mut timing = CleanupTiming::new(clock(0), None);
    let corrected = ClockSample {
        wall_ms: 60_000,
        monotonic_ms: 30_000,
    };
    assert_eq!(cutoffs(&mut timing, corrected), (Some(0), None));
    assert_eq!(
        cutoffs(
            &mut timing,
            ClockSample {
                wall_ms: 90_000,
                monotonic_ms: 60_000,
            }
        ),
        (Some(30_000), Some(30_000))
    );
}

#[test]
fn monotonic_reset_and_wall_compensated_stall_restart_only_short_wait() {
    let mut timing = CleanupTiming::new(clock(60_000), None);
    assert_eq!(
        cutoffs(
            &mut timing,
            ClockSample {
                wall_ms: 120_000,
                monotonic_ms: 0,
            }
        ),
        (Some(60_000), None)
    );
    assert_eq!(
        cutoffs(
            &mut timing,
            ClockSample {
                wall_ms: 180_000,
                monotonic_ms: 75_001,
            }
        ),
        (Some(120_000), None)
    );
}

#[test]
fn unrepresentable_cutoff_does_not_saturate_into_eligibility() {
    let now = ClockSample {
        wall_ms: i64::MIN,
        monotonic_ms: 0,
    };
    let mut timing = CleanupTiming::new(now, None);
    assert_eq!(cutoffs(&mut timing, now), (None, None));
}

#[test]
fn full_signed_wall_span_and_unsigned_timeout_do_not_overflow() {
    let now = ClockSample {
        wall_ms: i64::MAX,
        monotonic_ms: u64::MAX,
    };
    let mut timing = CleanupTiming::new(now, Some(i64::MIN));
    let largest_wait = RuleWait {
        enabled: true,
        timeout_ms: u64::MAX,
    };
    assert_eq!(
        timing.due_cutoffs(now, largest_wait, largest_wait),
        [
            (CleanupRule::Older, Some(i64::MIN)),
            (CleanupRule::Idle, None),
        ]
    );
}
