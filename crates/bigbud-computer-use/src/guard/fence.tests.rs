use super::*;
use crate::{
    guard::{record::SafetyRecord, test_support::armed},
    worker::Observation,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone)]
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
fn sink() -> Sink {
    Sink {
        fail: Rc::new(RefCell::new(false)),
        records: Rc::new(RefCell::new(vec![])),
    }
}
#[test]
fn revoke_precedes_io_and_failure_never_reopens() {
    let storage = sink();
    let mut owner = GuardFence::from_recovered(armed(), storage.clone()).unwrap();
    *storage.fail.borrow_mut() = true;
    assert!(matches!(
        owner.revoke("control_lost"),
        Err(FenceError::Persistence(_))
    ));
    assert!(owner.record().latched && owner.record().input_uncertain && owner.persistence_failed());
    assert_eq!(owner.record().pause_epoch, 1);
    assert!(storage.records.borrow().is_empty());
}
#[test]
fn records_roots_before_any_future_execution_and_refuses_overlap() {
    let storage = sink();
    let mut owner = GuardFence::from_recovered(SafetyRecord::initial(), storage.clone()).unwrap();
    owner.record_execution_roots(armed().roots.clone()).unwrap();
    assert!(storage.records.borrow().first().unwrap().armed);
    assert!(matches!(
        owner.record_execution_roots(armed().roots),
        Err(FenceError::Unsettled)
    ));
    assert_eq!(
        owner
            .observe_retirement(&armed().roots, &[Observation::Unavailable])
            .unwrap(),
        1
    );
    assert!(matches!(
        owner.record_execution_roots(armed().roots),
        Err(FenceError::Unsettled)
    ));
    assert_eq!(
        owner
            .observe_retirement(&armed().roots, &[Observation::Gone])
            .unwrap(),
        0
    );
    assert!(owner.record().latched && owner.record().armed);
}
#[test]
fn epoch_overflow_and_bad_reason_cannot_open_a_fence() {
    let record = SafetyRecord {
        pause_epoch: u64::MAX,
        latched: false,
        ..armed()
    };
    let storage = sink();
    let mut owner = GuardFence::from_recovered(record, storage.clone()).unwrap();
    assert!(owner.revoke("stop").is_err());
    assert!(owner.record().latched && owner.record().input_uncertain);
    assert!(storage.records.borrow().last().unwrap().latched);
    let mut owner = GuardFence::from_recovered(armed(), storage.clone()).unwrap();
    assert!(owner.revoke("bad\nreason").is_err());
    assert!(owner.record().latched && owner.record().input_uncertain);
    assert!(storage.records.borrow().last().unwrap().latched);
}

#[test]
fn delayed_retirement_evidence_cannot_settle_a_replacement_root() {
    let storage = sink();
    let mut guard = GuardFence::from_recovered(armed(), storage.clone()).unwrap();
    let mut stale = armed().roots;
    stale.first_mut().unwrap().creation_identity = "earlier-birth".into();
    assert!(matches!(
        guard.observe_retirement(&stale, &[Observation::Gone]),
        Err(FenceError::Invalid)
    ));
    assert_eq!(guard.record().roots, armed().roots);
    assert!(storage.records.borrow().is_empty());
}
#[test]
fn settled_roots_are_exact_and_clear_armed_only_without_latch_or_uncertainty() {
    let root = armed().roots[0].clone();
    let mut stranger = root.clone();
    stranger.creation_identity = "birth-2".into();
    let storage = sink();
    let mut latched = GuardFence::from_recovered(armed(), storage.clone()).unwrap();
    assert!(matches!(
        latched.settle_roots(std::slice::from_ref(&stranger)),
        Err(FenceError::Invalid)
    ));
    assert!(matches!(
        latched.settle_roots(&[]),
        Err(FenceError::Invalid)
    ));
    assert!(storage.records.borrow().is_empty());
    assert_eq!(
        latched.settle_roots(std::slice::from_ref(&root)).unwrap(),
        0
    );
    assert!(latched.record().armed && latched.record().latched);
    let clean = SafetyRecord {
        latched: false,
        ..armed()
    };
    let mut active = GuardFence::from_recovered(clean.clone(), sink()).unwrap();
    active.settle_roots(std::slice::from_ref(&root)).unwrap();
    assert!(!active.record().armed && active.record().roots.is_empty());
    let uncertain = SafetyRecord {
        input_uncertain: true,
        ..clean
    };
    let mut held = GuardFence::from_recovered(uncertain, sink()).unwrap();
    held.settle_roots(std::slice::from_ref(&root)).unwrap();
    assert!(held.record().armed && held.record().input_uncertain);
}
