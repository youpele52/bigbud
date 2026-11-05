#![allow(clippy::unwrap_used)]
use super::egress::EgressRefusal;
use super::restoration::*;
use super::ticket::Delivery;

#[test]
fn restoration_needs_a_permitted_prior_context() {
    use PriorContext::*;
    for prior in [
        Permitted,
        Disallowed,
        Protected,
        Unresolved,
        EstablishedByPrelude,
    ] {
        // A route that does not restore never consults the prior context.
        assert_eq!(
            check_prior_context(false, Delivery::Background, prior),
            Ok(())
        );
    }
    for prior in [Disallowed, Protected, Unresolved] {
        for delivery in [Delivery::Foreground, Delivery::Background] {
            let refused = check_prior_context(true, delivery, prior).unwrap_err();
            assert_eq!(refused.code(), "restoration_blocked");
        }
    }
    assert_eq!(
        check_prior_context(true, Delivery::Background, Permitted),
        Ok(())
    );
    assert_eq!(
        check_prior_context(true, Delivery::Foreground, EstablishedByPrelude),
        Ok(())
    );
    // Background cannot secretly focus to establish a prior context.
    assert_eq!(
        check_prior_context(true, Delivery::Background, EstablishedByPrelude),
        Err(RestorationBlocked)
    );
}

fn target() -> RetainedTarget {
    RetainedTarget {
        pid: 42,
        creation_identity: "birth-1".into(),
        window: 7,
    }
}

#[test]
fn a_returned_call_is_not_settled_until_the_old_generation_retires() {
    let mut settlement = DelayedSettlement::new(Completion::Unknown, target(), "worker-1", false);
    assert!(settlement.settled().is_none());
    assert_eq!(
        settlement.retirement_confirmed("worker-0"),
        Err(SettlementRefusal::Unexpected)
    );
    assert!(settlement.settled().is_none());
    settlement.retirement_confirmed("worker-1").unwrap();
    let settled = settlement.settled().unwrap();
    assert_eq!(settled.completion, Completion::Unknown);
    assert_eq!(settled.retired_generation, "worker-1");
    assert_eq!(settled.capture, None);
    assert_eq!(
        settlement.retirement_confirmed("worker-1"),
        Err(SettlementRefusal::Unexpected)
    );
}

#[test]
fn capture_after_runs_on_a_revalidated_replacement_only() {
    let mut settlement = DelayedSettlement::new(Completion::Completed, target(), "worker-1", true);
    // No replacement or capture before retirement is confirmed.
    assert!(settlement.replacement_ready("worker-2", &target()).is_err());
    settlement.retirement_confirmed("worker-1").unwrap();
    assert!(settlement.settled().is_none());
    // The old generation can never serve the capture.
    assert!(settlement.replacement_ready("worker-1", &target()).is_err());
    settlement.replacement_ready("worker-2", &target()).unwrap();
    assert!(
        settlement
            .capture_result("worker-3", Ok("cap".into()))
            .is_err()
    );
    settlement
        .capture_result("worker-2", Ok("capture-2".into()))
        .unwrap();
    let settled = settlement.settled().unwrap();
    assert_eq!(settled.completion, Completion::Completed);
    let fresh = settled.capture.clone().unwrap().unwrap();
    assert_eq!(
        (fresh.generation.as_str(), fresh.capture_id.as_str()),
        ("worker-2", "capture-2")
    );
}

#[test]
fn identity_changes_and_capture_failures_keep_the_mutation_result() {
    let mut reused = target();
    reused.creation_identity = "birth-2".into(); // pid reuse
    for observed in [
        reused,
        RetainedTarget {
            window: 8,
            ..target()
        },
    ] {
        let mut settlement =
            DelayedSettlement::new(Completion::Completed, target(), "worker-1", true);
        settlement.retirement_confirmed("worker-1").unwrap();
        settlement.replacement_ready("worker-2", &observed).unwrap();
        let settled = settlement.settled().unwrap();
        assert_eq!(settled.completion, Completion::Completed);
        assert_eq!(settled.capture, Some(Err("target_stale")));
    }
    let mut settlement = DelayedSettlement::new(Completion::Completed, target(), "worker-1", true);
    settlement.retirement_confirmed("worker-1").unwrap();
    settlement.replacement_ready("worker-2", &target()).unwrap();
    settlement
        .capture_result("worker-2", Err(EgressRefusal::ProvenanceUnproven))
        .unwrap();
    let settled = settlement.settled().unwrap();
    assert_eq!(settled.completion, Completion::Completed);
    assert_eq!(settled.capture, Some(Err("capture_provenance_unproven")));
}

#[test]
fn an_unknown_outcome_is_never_followed_by_a_capture() {
    let mut settlement = DelayedSettlement::new(Completion::Unknown, target(), "worker-1", true);
    settlement.retirement_confirmed("worker-1").unwrap();
    let settled = settlement.settled().unwrap().clone();
    assert_eq!(settled.completion, Completion::Unknown);
    assert_eq!(settled.capture, Some(Err(UNKNOWN_OUTCOME_CAPTURE_ERROR)));
    assert_eq!(UNKNOWN_OUTCOME_CAPTURE_ERROR, "observation_stale");
    // No replacement capture can follow.
    assert!(settlement.replacement_ready("worker-2", &target()).is_err());
    assert!(
        settlement
            .capture_result("worker-2", Ok("cap".into()))
            .is_err()
    );
    assert_eq!(settlement.settled(), Some(&settled));
}

#[test]
fn invalidation_abandons_the_capture_but_never_skips_retirement() {
    let mut early = DelayedSettlement::new(Completion::Completed, target(), "worker-1", true);
    early.invalidate(Invalidation::Stop);
    assert!(early.settled().is_none(), "retirement is still required");
    early.invalidate(Invalidation::PolicyChanged); // the first cause is kept
    early.retirement_confirmed("worker-1").unwrap();
    assert_eq!(early.settled().unwrap().capture, Some(Err("paused")));
    for (cause, code) in [
        (Invalidation::PolicyChanged, "policy_pending"),
        (Invalidation::ControlLost, "control_unavailable"),
        (Invalidation::DeadlineExceeded, "deadline_exceeded"),
    ] {
        let mut late = DelayedSettlement::new(Completion::Completed, target(), "worker-1", true);
        late.retirement_confirmed("worker-1").unwrap();
        late.replacement_ready("worker-2", &target()).unwrap();
        late.invalidate(cause);
        let settled = late.settled().unwrap().clone();
        assert_eq!(settled.capture, Some(Err(code)));
        assert_eq!(settled.completion, Completion::Completed);
        // A capture finishing after invalidation cannot replace the error.
        assert!(late.capture_result("worker-2", Ok("late".into())).is_err());
        assert_eq!(late.settled(), Some(&settled));
    }
    // Without a requested capture, invalidation changes nothing visible.
    let mut plain = DelayedSettlement::new(Completion::Completed, target(), "worker-1", false);
    plain.invalidate(Invalidation::Stop);
    plain.retirement_confirmed("worker-1").unwrap();
    assert_eq!(plain.settled().unwrap().capture, None);
}

#[test]
fn an_invalidation_before_retirement_wins_over_an_unknown_outcome() {
    let mut settlement = DelayedSettlement::new(Completion::Unknown, target(), "worker-1", true);
    settlement.invalidate(Invalidation::ControlLost);
    settlement.retirement_confirmed("worker-1").unwrap();
    let settled = settlement.settled().unwrap();
    assert_eq!(settled.completion, Completion::Unknown);
    assert_eq!(settled.capture, Some(Err("control_unavailable")));
}
