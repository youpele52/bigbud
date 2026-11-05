use super::*;
use crate::guard::{Journal, LockError};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
const LIMIT: Duration = Duration::from_secs(5);

#[test]
fn actual_blocked_journal_cannot_suppress_independent_signal_progress() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let calls = attach(&mut recovery);
    let before = recovery.record().unwrap().clone();
    recovery
        .session_invalidator()
        .invalidate(crate::guard::SessionInvalidationCause::Locked);
    let (mut signal, mut storage) = recovery.split_retirement();
    let journal_lock = storage.lock;
    let (entered, at_journal) = mpsc::sync_channel(1);
    let (completed, completion) = mpsc::sync_channel(1);
    let statuses = thread::scope(|scope| {
        // Local to scope callback: unwinding drops this gate BEFORE scoped join.
        let gate = journal_lock.journal_file.lock().unwrap();
        let storage_thread = scope.spawn(move || {
            Journal::fixture_before_state(move || {
                // One retained notification, not a potentially blocking queue.
                let _notification = entered.try_send(());
            });
            let result = storage.flush();
            completed.send(result.is_ok()).unwrap();
        });
        // Wait until the storage path reaches the actual held journal mutex,
        // then make independent TERM/KILL/deadline progress on another thread.
        let signal_thread = scope.spawn(move || {
            at_journal.recv_timeout(LIMIT).unwrap();
            let first = signal.sample(Ok(90));
            let before_kill = signal.sample(Ok(250_000_089));
            let kill = signal.sample(Ok(250_000_090));
            let unknown = signal.sample(Ok(2_000_000_090));
            (first, before_kill, kill, unknown)
        });
        let result = signal_thread.join();
        let still_blocked = matches!(completion.try_recv(), Err(mpsc::TryRecvError::Empty));
        drop(gate);
        storage_thread.join().unwrap();
        (still_blocked, result.unwrap())
    });
    assert!(!completion.recv_timeout(LIMIT).unwrap());
    assert!(statuses.0);
    let (first, before_kill, kill, unknown) = statuses.1;
    assert_eq!(first.unwrap().term_sent, 1);
    assert_eq!(before_kill.unwrap().kill_sent, 0);
    assert_eq!(kill.unwrap().kill_sent, 1);
    assert!(unknown.unwrap().unknown);
    assert_eq!(signals(&calls[0]), ["TERM", "KILL"]);
    assert_eq!(recovery.record().unwrap().roots, before.roots);
    assert!(recovery.verify_storage().is_err());
}

#[test]
fn storage_flushes_while_signal_syscall_fixture_is_blocked() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let calls = attach(&mut recovery);
    let before = recovery.record().unwrap().clone();
    let (entered, entry) = mpsc::sync_channel(1);
    let (release, released) = mpsc::sync_channel(1);
    let released = Mutex::new(released);
    if let Target::Fixture(fixture) = &mut recovery.retirement.as_mut().unwrap().targets[0] {
        fixture.before_signal = Some(Arc::new(move || {
            entered.send(()).unwrap();
            released.lock().unwrap().recv_timeout(LIMIT).unwrap();
        }));
    }
    let (mut signal, mut storage) = recovery.split_retirement();
    let status = thread::scope(|scope| {
        let worker = scope.spawn(move || signal.sample(Ok(1)));
        entry.recv_timeout(LIMIT).unwrap();
        // No dispatch-state borrow/lock required, even while a signal stalls.
        let result = storage.flush().is_ok();
        release.send(()).unwrap();
        (result, worker.join().unwrap())
    });
    assert!(status.0);
    assert_eq!(status.1.unwrap().term_sent, 1);
    assert_eq!(signals(&calls[0]), ["TERM"]);
    let after = recovery.record().unwrap();
    assert_eq!(after.pause_epoch, before.pause_epoch + 1);
    assert_eq!(after.roots, before.roots);
}

#[test]
fn repeated_lane_handback_keeps_exclusive_capacity_election_and_original_deadlines() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let calls = attach(&mut recovery);
    let roots = recovery.record().unwrap().roots.clone();
    for index in 0..100 {
        let (mut signals, mut storage) = recovery.split_retirement();
        let status = signals.sample(Ok(index)).unwrap();
        assert_eq!(status.term_sent, 1);
        assert!(storage.flush().is_ok());
        // Returning either borrow does NOT drop any underlying owner or election.
        drop(storage);
        drop(signals);
        assert!(matches!(
            ControllingLock::acquire_in_verified_directory(&directory.0),
            Err(LockError::Conflict)
        ));
        assert!(matches!(
            recovery.attach_retirement(vec![]),
            Err(AttachRetirementError {
                failure: AttachRetirementFailure::AlreadyAttached,
                ..
            })
        ));
    }
    assert_eq!(step(&mut recovery, 249_999_999).kill_sent, 0);
    assert_eq!(step(&mut recovery, 250_000_000).kill_sent, 1);
    assert!(step(&mut recovery, 2_000_000_000).unknown);
    assert_eq!(signals(&calls[0]), ["TERM", "KILL"]);
    assert_eq!(recovery.record().unwrap().roots, roots);
}

#[test]
fn signal_panic_join_failure_returns_borrows_and_preserves_exact_owners() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let calls = attach(&mut recovery);
    let roots = recovery.record().unwrap().roots.clone();
    let once = AtomicBool::new(false);
    if let Target::Fixture(fixture) = &mut recovery.retirement.as_mut().unwrap().targets[0] {
        fixture.before_signal = Some(Arc::new(move || {
            assert!(once.swap(true, Ordering::SeqCst), "fixture signal unwind");
        }));
    }
    let (mut signal, mut storage) = recovery.split_retirement();
    let join_failed =
        thread::scope(|scope| scope.spawn(move || signal.sample(Ok(19))).join().is_err());
    assert!(join_failed);
    assert!(matches!(storage.flush(), Err(RecoveryFailure::Interrupted)));
    drop(storage);
    let status = step(&mut recovery, 250_000_019);
    assert!(status.unknown);
    assert_eq!(status.kill_sent, 1);
    assert_eq!(signals(&calls[0]), ["TERM", "KILL"]);
    assert_eq!(recovery.record().unwrap().roots, roots);
    assert_eq!(
        recovery.retirement.as_ref().unwrap().targets[0].root(),
        &roots[0]
    );
    assert!(matches!(
        recovery.verify_storage(),
        Err(RecoveryFailure::Interrupted)
    ));
}

#[test]
fn no_owner_case_is_never_readiness_or_a_production_permit() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let (mut signal, mut storage) = recovery.split_retirement();
    assert!(signal.sample(Ok(u64::MAX)).is_none());
    assert!(storage.verify().is_err());
    assert!(crate::owner::private_bootstrap::BootstrapPermit::verify().is_err());
}

#[path = "lanes.fault_tests.rs"]
mod fault_tests;
