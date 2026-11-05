use super::*;
use crate::guard::record::{PolicyBinding, SafetyRecord};
use crate::guard::test_support::armed;
use crate::owner::admission::control::HumanControl;
use crate::owner::admission::human_recovery::{
    acknowledge_input_state, bind_first_controller, settlement_facts, take_over_controller,
};
use crate::worker::Observation;
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Default)]
struct Sink {
    fail: Rc<RefCell<bool>>,
    records: Rc<RefCell<Vec<SafetyRecord>>>,
}
impl SafetySink for Sink {
    type Error = &'static str;
    fn persist(&mut self, record: &SafetyRecord) -> Result<(), Self::Error> {
        if *self.fail.borrow() {
            return Err("disk failure");
        }
        self.records.borrow_mut().push(record.clone());
        Ok(())
    }
}

fn lease() -> ControllerLease {
    let binding = armed().binding.unwrap();
    ControllerLease {
        authority: binding.authority,
        controller_installation: binding.controller_installation,
        migration_binding: binding.migration_binding,
    }
}

fn binding(profile: &str, revision: &str, digest: char) -> PolicyBinding {
    PolicyBinding {
        profile_generation: profile.into(),
        revision: revision.into(),
        digest: digest.to_string().repeat(64),
        ..armed().binding.unwrap()
    }
}

/// Latched, uncertain and still running: the state after an interrupted input.
fn interrupted() -> SafetyRecord {
    SafetyRecord {
        input_uncertain: true,
        pause_epoch: 3,
        ..armed()
    }
}

fn refused<T: std::fmt::Debug, E: std::fmt::Debug>(
    result: Result<T, TransitionError<E>>,
) -> TransitionRefusal {
    match result {
        Err(TransitionError::Refused(refusal)) => refusal,
        other => panic!("{other:?}"),
    }
}

#[test]
fn revocation_retirement_and_input_uncertainty_are_distinct() {
    let human = HumanControl::fixture();
    let mut fence = GuardFence::from_recovered(interrupted(), Sink::default()).unwrap();
    assert_eq!(
        fence.settlement(),
        Settlement::RetirementUnknown { roots: 1 }
    );
    let facts = settlement_facts(&fence, true, true, true);
    assert!(!facts.retirement_confirmed && !facts.input_state_acknowledged);
    // Unconfirmed retirement prohibits the human acknowledgement.
    assert!(matches!(
        acknowledge_input_state(&mut fence, &human, 3),
        Err(TransitionError::Fence(FenceError::Unsettled))
    ));
    fence
        .observe_retirement(&armed().roots, &[Observation::Gone])
        .unwrap();
    assert_eq!(fence.settlement(), Settlement::InputUncertain);
    let facts = settlement_facts(&fence, true, true, true);
    assert!(facts.retirement_confirmed && !facts.input_state_acknowledged);
    // A prompt shown before a newer Stop cannot acknowledge the new state.
    assert_eq!(
        refused(acknowledge_input_state(&mut fence, &human, 2)),
        TransitionRefusal::StaleEpoch
    );
    acknowledge_input_state(&mut fence, &human, 3).unwrap();
    assert_eq!(fence.settlement(), Settlement::Revoked);
    assert!(
        fence.record().latched,
        "acknowledgement never clears the latch"
    );
    let facts = settlement_facts(&fence, true, true, true);
    assert!(facts.retirement_confirmed && facts.input_state_acknowledged);
    // Idempotent once acknowledged.
    acknowledge_input_state(&mut fence, &human, 3).unwrap();
}

#[test]
fn a_failed_write_claims_nothing_and_counts_as_unconfirmed() {
    let human = HumanControl::fixture();
    let settled = SafetyRecord {
        roots: vec![],
        ..interrupted()
    };
    let storage = Sink::default();
    let mut fence = GuardFence::from_recovered(settled, storage.clone()).unwrap();
    *storage.fail.borrow_mut() = true;
    assert!(matches!(
        acknowledge_input_state(&mut fence, &human, 3),
        Err(TransitionError::Fence(FenceError::Persistence(_)))
    ));
    assert!(fence.record().input_uncertain && fence.persistence_failed());
    assert!(!settlement_facts(&fence, true, true, true).retirement_confirmed);
    *storage.fail.borrow_mut() = false;
    acknowledge_input_state(&mut fence, &human, 3).unwrap();
    assert!(!fence.persistence_failed());
    assert_eq!(storage.records.borrow().len(), 1);
}

#[test]
fn not_latched_state_cannot_be_acknowledged() {
    let record = SafetyRecord {
        latched: false,
        roots: vec![],
        ..armed()
    };
    let mut fence = GuardFence::from_recovered(record, Sink::default()).unwrap();
    assert_eq!(fence.settlement(), Settlement::Clear);
    assert_eq!(
        refused(fence.acknowledge_input_state(0)),
        TransitionRefusal::NotLatched
    );
}

#[test]
fn first_binding_is_human_only_once_minted_and_unacknowledged() {
    let human = HumanControl::fixture();
    let storage = Sink::default();
    let record = SafetyRecord {
        pause_epoch: 4,
        ..SafetyRecord::initial()
    };
    let mut fence = GuardFence::from_recovered(record, storage.clone()).unwrap();
    assert_eq!(
        refused(fence.acknowledge_revision(binding("ns4", "1", 'b'))),
        TransitionRefusal::Unbound
    );
    let mut invalid = lease();
    invalid.authority = "bad authority".into();
    assert!(matches!(
        bind_first_controller(&mut fence, &human, invalid),
        Err(TransitionError::Fence(FenceError::Invalid))
    ));
    let bound = bind_first_controller(&mut fence, &human, lease()).unwrap();
    assert_eq!(
        (bound.profile_generation.as_str(), bound.revision.as_str()),
        ("ns4", UNACKNOWLEDGED_REVISION)
    );
    assert_eq!(bound.digest, "0".repeat(64));
    assert!(fence.record().latched);
    // Nothing was acknowledged: the sentinel can never be acknowledged (with
    // or without real content), and the first real revision is new.
    assert_eq!(
        refused(fence.acknowledge_revision(binding("ns4", "0", 'b'))),
        TransitionRefusal::SentinelRevision
    );
    assert_eq!(
        refused(fence.acknowledge_revision(bound.clone())),
        TransitionRefusal::SentinelRevision
    );
    assert_eq!(
        refused(bind_first_controller(&mut fence, &human, lease())),
        TransitionRefusal::AlreadyBound
    );
    assert_eq!(storage.records.borrow().len(), 1);
}

#[test]
fn acknowledgement_is_monotonic_idempotent_and_lease_bound() {
    let settled = SafetyRecord {
        roots: vec![],
        ..armed()
    };
    let storage = Sink::default();
    let mut fence = GuardFence::from_recovered(settled, storage.clone()).unwrap();
    // armed() is bound at revision 42 with digest "a…".
    assert_eq!(
        fence
            .acknowledge_revision(binding("profile-1", "42", 'a'))
            .unwrap(),
        Acknowledged::Idempotent(42)
    );
    assert_eq!(
        refused(fence.acknowledge_revision(binding("profile-1", "42", 'b'))),
        TransitionRefusal::ConflictingDigest
    );
    assert_eq!(
        refused(fence.acknowledge_revision(binding("profile-1", "41", 'b'))),
        TransitionRefusal::StaleRevision
    );
    assert_eq!(
        refused(fence.acknowledge_revision(binding("profile-2", "43", 'b'))),
        TransitionRefusal::ForeignController
    );
    let mut other_installation = binding("profile-1", "43", 'b');
    other_installation.controller_installation = "installation-2".into();
    assert_eq!(
        refused(fence.acknowledge_revision(other_installation)),
        TransitionRefusal::ForeignController
    );
    assert!(storage.records.borrow().is_empty());
    assert_eq!(
        fence
            .acknowledge_revision(binding("profile-1", "43", 'b'))
            .unwrap(),
        Acknowledged::New(43)
    );
    assert_eq!(fence.record().binding.as_ref().unwrap().revision, "43");
    // A desired-ahead-of-ack crash replays the same revision: idempotent.
    assert_eq!(
        fence
            .acknowledge_revision(binding("profile-1", "43", 'b'))
            .unwrap(),
        Acknowledged::Idempotent(43)
    );
    assert_eq!(storage.records.borrow().len(), 1);
}

#[test]
fn enforcement_is_acknowledged_only_after_old_execution_settled() {
    let mut fence = GuardFence::from_recovered(armed(), Sink::default()).unwrap();
    assert!(matches!(
        fence.acknowledge_revision(binding("profile-1", "43", 'b')),
        Err(TransitionError::Fence(FenceError::Unsettled))
    ));
    assert_eq!(fence.record().binding.as_ref().unwrap().revision, "42");
}

#[test]
fn takeover_fences_first_needs_settlement_and_mints_a_fresh_namespace() {
    let human = HumanControl::fixture();
    let ready = SafetyRecord {
        latched: false,
        pause_epoch: 5,
        ..armed()
    };
    let storage = Sink::default();
    let mut fence = GuardFence::from_recovered(ready, storage.clone()).unwrap();
    // Old execution still running: the fence still latches, durably.
    assert!(matches!(
        take_over_controller(&mut fence, &human, lease()),
        Err(TransitionError::Fence(FenceError::Unsettled))
    ));
    assert!(fence.record().latched && fence.record().pause_epoch == 6);
    assert_eq!(storage.records.borrow().len(), 1);
    assert_eq!(
        fence.record().binding.as_ref().unwrap().profile_generation,
        "profile-1"
    );
    fence
        .observe_retirement(&armed().roots, &[Observation::Gone])
        .unwrap();
    let first = take_over_controller(&mut fence, &human, lease()).unwrap();
    assert_eq!(fence.record().pause_epoch, 7);
    assert_eq!(first.profile_generation, "ns7");
    assert_eq!(first.revision, UNACKNOWLEDGED_REVISION);
    let record = fence.record();
    assert!(record.latched, "the new controller needs a fresh Resume");
    assert_eq!(record.notice, armed().notice, "notice identity is kept");
    // The old controller's acknowledgement is now foreign.
    assert_eq!(
        refused(fence.acknowledge_revision(binding("profile-1", "44", 'd'))),
        TransitionRefusal::ForeignController
    );
    // Taking over again (even back to the same server) never reuses a
    // namespace, so revisions of an earlier lease stay foreign.
    let second = take_over_controller(&mut fence, &human, lease()).unwrap();
    assert_eq!(second.profile_generation, "ns8");
    assert_eq!(
        refused(fence.acknowledge_revision(binding("ns7", "1", 'e'))),
        TransitionRefusal::ForeignController
    );
    assert_eq!(
        fence
            .acknowledge_revision(binding("ns8", "1", 'e'))
            .unwrap(),
        Acknowledged::New(1)
    );
}

#[test]
fn a_failed_takeover_mints_nothing_and_the_next_namespace_is_higher() {
    let human = HumanControl::fixture();
    let settled = SafetyRecord {
        roots: vec![],
        pause_epoch: 5,
        ..armed()
    };
    let storage = Sink::default();
    let mut fence = GuardFence::from_recovered(settled, storage.clone()).unwrap();
    // The revoke write fails: latched in memory, nothing bound or minted.
    *storage.fail.borrow_mut() = true;
    assert!(matches!(
        take_over_controller(&mut fence, &human, lease()),
        Err(TransitionError::Fence(FenceError::Persistence(_)))
    ));
    assert!(fence.record().latched && fence.persistence_failed());
    assert_eq!(fence.record().binding, armed().binding);
    // The revoke persists but the binding commit fails: still the old lease.
    struct FailSecond(Rc<RefCell<u32>>);
    impl SafetySink for FailSecond {
        type Error = ();
        fn persist(&mut self, _: &SafetyRecord) -> Result<(), ()> {
            *self.0.borrow_mut() += 1;
            if *self.0.borrow() == 2 {
                Err(())
            } else {
                Ok(())
            }
        }
    }
    let writes = Rc::new(RefCell::new(0));
    let record = fence.record().clone();
    let mut fence = GuardFence::from_recovered(record, FailSecond(writes.clone())).unwrap();
    assert!(matches!(
        take_over_controller(&mut fence, &human, lease()),
        Err(TransitionError::Fence(FenceError::Persistence(())))
    ));
    assert_eq!(fence.record().pause_epoch, 7);
    assert_eq!(fence.record().binding, armed().binding);
    let minted = take_over_controller(&mut fence, &human, lease()).unwrap();
    assert_eq!(minted.profile_generation, "ns8");
}
