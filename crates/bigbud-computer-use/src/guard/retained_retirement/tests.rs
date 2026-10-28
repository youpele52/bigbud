#![allow(clippy::unwrap_used)]
//! Private deterministic signal adapter. Never constructs an AnchoredGroup or
//! production permit and never executes child/spawn/signal/wait/reap operations.
use super::*;
use crate::{
    guard::{
        ControllingLock,
        record::SafetyRecord,
        test_support::{TestDirectory, armed},
    },
    worker::{ExecutionRoot, unix::RetirementSignal},
};
use std::{
    io,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub(super) struct Calls {
    pub(super) signals: Vec<&'static str>,
    fail_term: bool,
    fail_kill: bool,
    /// Fixture closure state: settles only when explicitly marked exited.
    pub(super) closure_settled: bool,
    pub(super) fail_settle: bool,
    pub(super) fail_closure: bool,
}
pub(super) struct Fixture {
    pub(super) root: ExecutionRoot,
    calls: Arc<Mutex<Calls>>,
    pub(super) before_signal: Option<Arc<dyn Fn() + Send + Sync>>,
}
impl Fixture {
    pub(super) fn signal(&self, signal: RetirementSignal) -> io::Result<()> {
        if let Some(checkpoint) = &self.before_signal {
            checkpoint();
        }
        let mut calls = self.calls.lock().unwrap();
        let fail = match signal {
            RetirementSignal::Terminate => {
                calls.signals.push("TERM");
                calls.fail_term
            }
            RetirementSignal::Kill => {
                calls.signals.push("KILL");
                calls.fail_kill
            }
        };
        if fail {
            Err(io::Error::other("fixture signal failure"))
        } else {
            Ok(())
        }
    }
    pub(super) fn closure(&self) -> io::Result<crate::worker::unix::ClosureState> {
        use crate::worker::unix::ClosureState;
        let calls = self.calls.lock().unwrap();
        if calls.fail_closure {
            return Err(io::Error::from_raw_os_error(libc::ECHILD));
        }
        Ok(if calls.closure_settled {
            ClosureState::Settled
        } else {
            ClosureState::LeaderLive
        })
    }
    pub(super) fn settle(&self) -> io::Result<()> {
        if self.calls.lock().unwrap().fail_settle {
            return Err(io::Error::other("fixture reap failure"));
        }
        Ok(())
    }
}
fn fixture(root: ExecutionRoot) -> (Target, Arc<Mutex<Calls>>) {
    let calls = Arc::new(Mutex::new(Calls::default()));
    (
        Target::Fixture(Fixture {
            root,
            calls: calls.clone(),
            before_signal: None,
        }),
        calls,
    )
}
pub(super) fn lock(directory: &TestDirectory, record: SafetyRecord) -> ControllingLock {
    let lock = ControllingLock::acquire_in_verified_directory(&directory.0).unwrap();
    lock.journal().replace(&record).unwrap();
    lock
}
pub(super) fn attach(recovery: &mut RetainedRecovery<'_>) -> Vec<Arc<Mutex<Calls>>> {
    let roots = recovery.record().unwrap().roots.clone();
    assert!(recovery.check_retirement_targets(roots.iter()).is_ok());
    let (targets, calls) = roots.into_iter().map(fixture).unzip();
    recovery.retirement = Some(OwnedRetirement::new(targets));
    calls
}
fn step(recovery: &mut RetainedRecovery<'_>, ns: u64) -> RetirementStatus {
    recovery.service_retirement_sample(Ok(ns)).unwrap()
}
fn signals(calls: &Arc<Mutex<Calls>>) -> Vec<&'static str> {
    calls.lock().unwrap().signals.clone()
}

#[test]
fn original_deadlines_coalescing_and_no_settlement_after_signals() {
    let directory = TestDirectory::new();
    let mut lock = lock(&directory, armed());
    let mut recovery = lock.recover_retained();
    let calls = attach(&mut recovery);
    let before = recovery.record().unwrap().clone();
    assert!(signals(&calls[0]).is_empty());
    let priority = recovery.session.retirement_requests();
    for _ in 0..10_000 {
        priority.raise(RetirementCause::OwnerLost);
    }
    let start = 9_000_000_000;
    let status = step(&mut recovery, start);
    assert_eq!(status.term_sent, 1);
    assert!(!status.unknown);
    assert!(priority.admission_closed());
    priority.raise(RetirementCause::WorkerLost);
    assert_eq!(step(&mut recovery, start + 249_999_999).kill_sent, 0);
    assert_eq!(signals(&calls[0]), ["TERM"]);
    assert_eq!(step(&mut recovery, start + 250_000_000).kill_sent, 1);
    assert!(!step(&mut recovery, start + 1_999_999_999).unknown);
    priority.raise(RetirementCause::OwnerLost);
    let status = step(&mut recovery, start + 2_000_000_000);
    assert!(status.unknown);
    assert_eq!(
        status.causes,
        RetirementCause::OwnerLost as u8 | RetirementCause::WorkerLost as u8
    );
    assert_eq!(signals(&calls[0]), ["TERM", "KILL"]);
    assert!(step(&mut recovery, start + 20_000_000_000).unknown);
    assert_eq!(recovery.record().unwrap(), &before);
    assert_eq!(
        recovery.retirement.as_ref().unwrap().targets[0].root(),
        &before.roots[0]
    );
    recovery.flush_retirement_invalidation().unwrap();
    let record = recovery.record().unwrap().clone();
    assert_eq!(record.roots, before.roots);
    assert!(record.armed && record.latched && record.input_uncertain);
    assert_eq!(record.pause_epoch, before.pause_epoch + 1);
    assert!(record.binding == before.binding && record.notice == before.notice);
    priority.raise(RetirementCause::GuardLost);
    step(&mut recovery, start + 21_000_000_000);
    recovery.flush_retirement_invalidation().unwrap();
    assert_eq!(recovery.record(), Some(&record));
    drop(recovery); // Does not prove physical retirement or release caller's lock.
    assert_eq!(lock.journal().read().unwrap(), Some(record));
}

#[test]
fn late_tick_escalates_despite_partial_failure_and_never_discards_roots() {
    let directory = TestDirectory::new();
    let mut record = armed();
    let mut second = record.roots[0].clone();
    second.pid = std::num::NonZeroU32::new(43).unwrap();
    second.generation = "worker-2".into();
    record.roots.push(second);
    let mut lock = lock(&directory, record);
    let mut recovery = lock.recover_retained();
    let calls = attach(&mut recovery);
    let roots = recovery.record().unwrap().roots.clone();
    calls[0].lock().unwrap().fail_term = true;
    calls[0].lock().unwrap().fail_kill = true;
    recovery
        .session
        .retirement_requests()
        .raise(RetirementCause::GuardLost);
    assert_eq!(step(&mut recovery, 0).term_sent, 2);
    let status = step(&mut recovery, 3_000_000_000);
    assert!(status.unknown);
    assert_eq!(status.kill_sent, 2);
    assert_eq!(signals(&calls[0]), ["TERM", "TERM", "KILL"]);
    assert_eq!(signals(&calls[1]), ["TERM", "KILL"]);
    calls[0].lock().unwrap().fail_term = false;
    calls[0].lock().unwrap().fail_kill = false;
    let status = step(&mut recovery, 3_000_000_001);
    assert!(status.unknown);
    assert_eq!(status.kill_sent, 3);
    assert_eq!(recovery.record().unwrap().roots, roots);
    assert_eq!(recovery.retirement.as_ref().unwrap().targets.len(), 2);
}

#[test]
fn clock_errors_regression_and_large_times_do_not_invent_elapsed_proof() {
    let directory = TestDirectory::new();
    let mut lock = lock(&directory, armed());
    let mut recovery = lock.recover_retained();
    let calls = attach(&mut recovery);
    recovery
        .session
        .retirement_requests()
        .raise(RetirementCause::OwnerLost);
    let error = recovery
        .service_retirement_sample(Err(io::Error::other("clock")))
        .unwrap();
    assert!(error.unknown && error.term_sent == 1 && error.kill_sent == 0);
    assert_eq!(signals(&calls[0]), ["TERM"]);
    let start = u64::MAX - 2_000_000_000;
    assert_eq!(step(&mut recovery, start).kill_sent, 0);
    assert_eq!(step(&mut recovery, start - 1).kill_sent, 0);
    assert_eq!(step(&mut recovery, start + 249_999_999).kill_sent, 0);
    assert_eq!(step(&mut recovery, start + 250_000_000).kill_sent, 1);
    assert!(step(&mut recovery, u64::MAX).unknown);
    assert_eq!(signals(&calls[0]), ["TERM", "KILL"]);
}

#[test]
fn exact_attachment_rejects_missing_wrong_generation_order_and_changed_storage() {
    let directory = TestDirectory::new();
    let mut lock = lock(&directory, armed());
    let mut recovery = lock.recover_retained();
    let roots = recovery.record().unwrap().roots.clone();
    assert!(
        matches!(recovery.attach_retirement(vec![]), Err(AttachRetirementError { anchors, failure: AttachRetirementFailure::RootMismatch }) if anchors.is_empty())
    );
    let mut wrong = roots.clone();
    wrong[0].generation = "other".into();
    assert!(matches!(
        recovery.check_retirement_targets(wrong.iter()),
        Err(AttachRetirementFailure::RootMismatch)
    ));
    assert!(recovery.check_retirement_targets(roots.iter()).is_ok());
    let calls = attach(&mut recovery);
    assert!(matches!(
        recovery.check_retirement_targets(roots.iter()),
        Err(AttachRetirementFailure::AlreadyAttached)
    ));
    assert!(signals(&calls[0]).is_empty());
    assert!(crate::owner::private_bootstrap::BootstrapPermit::verify().is_err());
}

#[path = "recovery_tests.rs"]
mod recovery_tests;

#[path = "lanes.tests.rs"]
mod lanes_tests;
