#![allow(clippy::unwrap_used)]
use super::control::*;

fn facts() -> ResumePrerequisites {
    ResumePrerequisites {
        retirement_confirmed: true,
        input_state_acknowledged: true,
        policy_acknowledged: true,
        control_healthy: true,
        feature_enabled: true,
    }
}
fn request(state: &ControlState, challenge: &str) -> ResumeRequest {
    ResumeRequest {
        expected_pause_epoch: state.pause_epoch(),
        challenge: challenge.into(),
        authority_id: "authority-1".into(),
        policy_revision: 7,
        episode_id: "episode-2".into(),
    }
}
fn current() -> ResumeContext {
    ResumeContext {
        authority_id: "authority-1".into(),
        policy_revision: 7,
        episode_id: "episode-2".into(),
    }
}
fn challenge(state: &mut ControlState, human: &HumanControl, now: u64) -> String {
    state
        .challenge(human, "authority-1", 7, "episode-2", [9; 16], now)
        .unwrap()
}

#[test]
fn stop_is_idempotent_unbounded_and_advances_epoch_first() {
    let mut state = ControlState::restored(3, false);
    let first = state.stop("stop-1");
    assert!(state.latched());
    assert_eq!(first.pause_epoch, 4);
    assert_eq!(state.stop("stop-1"), first);
    for index in 0..1_000 {
        state.stop(&format!("flood-{index}"));
    }
    assert!(state.latched() && state.pause_epoch() == 1_004);
    // Malformed IDs still stop, anonymously, and are never remembered.
    for bad in ["", "bad id", "x/y"] {
        let anonymous = state.stop(bad);
        assert!(anonymous.operation_id.is_empty());
    }
    assert_eq!(state.pause_epoch(), 1_007);
    assert_ne!(state.stop("bad id").pause_epoch, 1_007);
}

#[test]
fn exhausted_pause_epoch_stays_latched_and_never_resumes() {
    let human = HumanControl::fixture();
    let mut state = ControlState::restored(u64::MAX, false);
    let revoked = state.stop("stop-1");
    assert!(state.latched());
    assert_eq!(revoked.pause_epoch, u64::MAX);
    let value = challenge(&mut state, &human, 0);
    assert_eq!(
        state.resume(&human, &request(&state, &value), &current(), facts(), 1),
        Err(ResumeRefusal::StaleEpoch)
    );
    assert!(state.latched());
}

#[test]
fn policy_or_episode_change_after_issuance_refuses_resume() {
    let human = HumanControl::fixture();
    let mut state = ControlState::restored(0, true);
    let changes: [fn(&mut ResumeContext); 3] = [
        |c| c.policy_revision = 8,
        |c| c.episode_id = "episode-3".into(),
        |c| c.authority_id = "authority-2".into(),
    ];
    for change in changes {
        let value = challenge(&mut state, &human, 0);
        let mut now = current();
        change(&mut now);
        assert_eq!(
            state.resume(&human, &request(&state, &value), &now, facts(), 1),
            Err(ResumeRefusal::StateChanged)
        );
        assert!(state.latched());
    }
}

#[test]
fn ordinary_control_is_bounded_and_stop_is_not() {
    let mut ordinary = OrdinaryControl::default();
    for _ in 0..8 {
        ordinary.begin().unwrap();
    }
    assert_eq!(ordinary.begin(), Err(ControlBusy));
    let mut state = ControlState::restored(0, false);
    state.stop("stop-while-busy");
    assert!(state.latched());
    ordinary.finish();
    assert_eq!(ordinary.begin(), Ok(()));
}

#[test]
fn resume_needs_fresh_bound_challenge_and_every_prerequisite() {
    let human = HumanControl::fixture();
    let mut state = ControlState::restored(0, true);
    assert_eq!(
        state.resume(&human, &request(&state, "x"), &current(), facts(), 0),
        Err(ResumeRefusal::ChallengeMissing)
    );
    let value = challenge(&mut state, &human, 0);
    let mut wrong = request(&state, &value);
    wrong.policy_revision = 8;
    assert_eq!(
        state.resume(&human, &wrong, &current(), facts(), 1),
        Err(ResumeRefusal::ChallengeMismatch)
    );
    // One-use: the failed attempt consumed it.
    assert_eq!(
        state.resume(&human, &request(&state, &value), &current(), facts(), 1),
        Err(ResumeRefusal::ChallengeMissing)
    );
    let value = challenge(&mut state, &human, 0);
    assert_eq!(
        state.resume(
            &human,
            &request(&state, &value),
            &current(),
            facts(),
            CHALLENGE_TTL_NS
        ),
        Err(ResumeRefusal::ChallengeExpired)
    );
    for (mutate, refusal) in [
        (
            (|f: &mut ResumePrerequisites| f.retirement_confirmed = false) as fn(&mut _),
            ResumeRefusal::RetirementUnknown,
        ),
        (
            |f| f.input_state_acknowledged = false,
            ResumeRefusal::InputUnacknowledged,
        ),
        (
            |f| f.policy_acknowledged = false,
            ResumeRefusal::PolicyPending,
        ),
        (
            |f| f.control_healthy = false,
            ResumeRefusal::ControlUnavailable,
        ),
        (|f| f.feature_enabled = false, ResumeRefusal::Disabled),
    ] {
        let value = challenge(&mut state, &human, 0);
        let mut missing = facts();
        mutate(&mut missing);
        assert_eq!(
            state.resume(&human, &request(&state, &value), &current(), missing, 1),
            Err(refusal)
        );
        assert!(state.latched());
    }
    let value = challenge(&mut state, &human, 0);
    assert_eq!(
        state.resume(&human, &request(&state, &value), &current(), facts(), 1),
        Ok(0)
    );
    assert!(!state.latched());
}

#[test]
fn delayed_resume_cannot_clear_a_newer_stop() {
    let human = HumanControl::fixture();
    let mut state = ControlState::restored(5, true);
    let value = challenge(&mut state, &human, 0);
    let stale = request(&state, &value);
    state.stop("stop-new");
    assert_eq!(
        state.resume(&human, &stale, &current(), facts(), 1),
        Err(ResumeRefusal::ChallengeMissing)
    );
    let value = challenge(&mut state, &human, 2);
    let mut old_epoch = request(&state, &value);
    old_epoch.expected_pause_epoch = 5;
    assert_eq!(
        state.resume(&human, &old_epoch, &current(), facts(), 3),
        Err(ResumeRefusal::StaleEpoch)
    );
    assert!(state.latched());
}
