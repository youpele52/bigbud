#![allow(clippy::unwrap_used)]
use super::clocks::*;
use std::time::Duration;

const MIN: u64 = 60_000_000_000;

#[test]
fn limits_preserve_existing_ranges_exactly() {
    assert!(check_in_limit(Duration::from_secs(59)).is_err());
    assert_eq!(check_in_limit(Duration::from_secs(60)), Ok(MIN));
    assert!(check_in_limit(Duration::from_secs(3_601)).is_err());
    assert!(action_timeout(Duration::from_secs(9)).is_err());
    assert_eq!(
        action_timeout(Duration::from_millis(10_500)),
        Ok(10_500_000_000)
    );
    assert!(action_timeout(Duration::from_secs(3_600)).is_ok());
}

#[test]
fn first_primitive_anchors_and_only_human_continue_reanchors() {
    let mut check_in = CheckIn::new(10 * MIN);
    assert!(!check_in.expired(u64::MAX));
    check_in.primitive(100);
    check_in.primitive(5 * MIN); // later calls/turns never reset
    assert_eq!(check_in.deadline(), Some(100 + 10 * MIN));
    assert!(check_in.expired(100 + 10 * MIN));
    check_in.human_continue(20 * MIN);
    assert_eq!(check_in.deadline(), Some(30 * MIN));
    check_in.new_episode();
    assert_eq!(check_in.deadline(), None);
}

#[test]
fn shrink_is_immediate_from_original_anchor_and_growth_waits() {
    let mut check_in = CheckIn::new(10 * MIN);
    check_in.primitive(0);
    check_in.set_limit(3 * MIN);
    assert_eq!(check_in.deadline(), Some(3 * MIN));
    check_in.set_limit(30 * MIN);
    assert_eq!(check_in.deadline(), Some(3 * MIN));
    check_in.human_continue(4 * MIN);
    assert_eq!(check_in.deadline(), Some(34 * MIN));
    // Shrinking never extends an already-earlier deadline.
    check_in.set_limit(31 * MIN);
    assert_eq!(check_in.deadline(), Some(34 * MIN));
}

#[test]
fn restoring_the_current_limit_cancels_pending_growth() {
    let mut check_in = CheckIn::new(10 * MIN);
    check_in.primitive(0);
    check_in.set_limit(20 * MIN);
    check_in.set_limit(10 * MIN);
    check_in.human_continue(MIN);
    assert_eq!(check_in.deadline(), Some(11 * MIN));
    check_in.set_limit(20 * MIN);
    check_in.set_limit(5 * MIN);
    check_in.new_episode();
    check_in.primitive(0);
    assert_eq!(check_in.deadline(), Some(5 * MIN));
}

#[test]
fn operation_deadline_is_fixed_at_acceptance_and_only_tightens() {
    let mut operation = OperationDeadline::accept(1_000, 15 * MIN);
    operation.apply_limit(60 * MIN);
    assert_eq!(operation.deadline(), 1_000 + 15 * MIN);
    operation.apply_limit(MIN);
    assert_eq!(operation.deadline(), 1_000 + MIN);
    assert!(operation.expired(1_000 + MIN));
    assert!(!OperationDeadline::accept(u64::MAX - 1, u64::MAX).expired(u64::MAX - 1));
}
