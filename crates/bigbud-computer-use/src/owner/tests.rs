use super::*;

#[test]
fn lost_pipe_fences_independently_and_cannot_revive() {
    let mut line = Lifeline::new("guard-1".into(), 0, 750).unwrap();
    line.eof();
    assert_eq!(line.check(1), LifelineState::Lost);
    assert!(!line.progress("guard-1", 1, 2));
}
#[test]
fn exact_expiry_is_closed_even_with_late_progress() {
    let mut line = Lifeline::new("guard-1".into(), 0, 750).unwrap();
    assert_eq!(line.check(749), LifelineState::Live);
    assert!(!line.progress("guard-1", 1, 750));
    assert_eq!(line.check(750), LifelineState::Lost);
}
#[test]
fn duplicate_or_other_generation_cannot_extend() {
    let mut line = Lifeline::new("guard-1".into(), 0, 750).unwrap();
    assert!(line.progress("guard-1", 1, 100));
    assert!(!line.progress("guard-1", 1, 700));
    assert!(!line.progress("guard-2", 2, 800));
    assert_eq!(line.check(850), LifelineState::Lost);
}
#[test]
fn progress_only_extends_a_live_current_generation() {
    let mut line = Lifeline::new("guard-1".into(), 0, 750).unwrap();
    assert!(line.progress("guard-1", 1, 700));
    assert_eq!(line.check(750), LifelineState::Live);
    assert_eq!(line.check(1450), LifelineState::Lost);
}
#[test]
fn clock_regression_overflow_and_unbounded_timeout_refuse() {
    assert!(Lifeline::new("guard-1".into(), u64::MAX, 750).is_none());
    assert!(Lifeline::new("guard-1".into(), 0, 751).is_none());
    let mut line = Lifeline::new("guard-1".into(), 100, 750).unwrap();
    assert_eq!(line.check(99), LifelineState::Lost);
    assert!(!line.progress("guard-1", 2, 100));
}
