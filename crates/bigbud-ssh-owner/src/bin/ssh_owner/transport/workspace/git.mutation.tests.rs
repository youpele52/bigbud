use super::*;

#[test]
fn mutation_timeouts_are_explicitly_ambiguous() {
    assert!(Recipe::RestoreTrackedPaths.is_mutation());
    assert!(Recipe::CleanUntrackedPaths.is_mutation());
    assert!(Recipe::StagePaths.is_mutation());
    assert!(!Recipe::Status.is_mutation());
    assert!(!Recipe::UntrackedNumstat.is_mutation());
    let result = ambiguous();
    assert_eq!(result.code, None);
    assert_eq!(result.stdout, "");
    assert_eq!(result.stderr, "");
    assert_eq!(result.outcome, Outcome::OutcomeUnknown as i32);
}
