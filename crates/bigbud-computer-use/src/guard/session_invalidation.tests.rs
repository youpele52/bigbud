use super::*;
use crate::guard::{
    ControllingLock, RecoveryFailure, RetainedRecovery, record::SafetyRecord,
    test_support::TestDirectory,
};
use std::{
    sync::{Mutex, mpsc},
    thread,
    time::Duration,
};

// Rendezvous at each actual publication boundary, not a copied algorithm. The
// timeout only bounds a broken fixture; elapsed time never makes a test pass.
fn checkpoints(events: &mut SessionInvalidator) -> (mpsc::Receiver<()>, mpsc::SyncSender<()>) {
    let (arrived, consumer) = mpsc::sync_channel(0);
    let (resume, producer) = mpsc::sync_channel(0);
    let producer = Mutex::new(producer);
    events.checkpoint = Some(Arc::new(move || {
        arrived.send(()).unwrap();
        producer
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
    }));
    (consumer, resume)
}

fn consume(recovery: &mut RetainedRecovery<'_>, requests: &PriorityRetirement) -> usize {
    assert!(requests.admission_closed());
    let bits = requests.take_causes();
    if bits == 0 {
        return 0;
    }
    assert_eq!(bits, RetirementCause::SessionInvalidated as u8);
    let retained = recovery.session_invalidation();
    // Flush while the producer is still suspended, not after invalidate returns.
    let flushed = matches!(
        recovery.flush_session_invalidation(),
        Err(RecoveryFailure::SessionInvalidated(
            SessionInvalidationCause::Locked
        ))
    );
    assert!(
        retained == Some(SessionInvalidationCause::Locked) && flushed,
        "consumed notification: retained={retained:?}, flush latched={flushed}"
    );
    let record = recovery.record().unwrap();
    assert!(record.latched);
    assert_eq!(record.pause_epoch, 10);
    assert_eq!(record.reason, "session_locked");
    1
}

fn elected(directory: &TestDirectory) -> ControllingLock {
    let lock = ControllingLock::acquire_in_verified_directory(&directory.0).unwrap();
    lock.journal()
        .replace(&SafetyRecord {
            latched: false,
            pause_epoch: 9,
            reason: "clean".into(),
            ..SafetyRecord::initial()
        })
        .unwrap();
    lock
}

#[test]
fn concurrent_consumer_flushes_every_published_notification() {
    let directory = TestDirectory::new();
    let mut lock = elected(&directory);
    let mut recovery = lock.recover_retained();
    assert!(recovery.verify_storage().is_ok());
    let mut events = recovery.session_invalidator();
    let requests = events.retirement_requests();
    thread::scope(|scope| {
        // Keep channels inside the scope body so panic drops them before join.
        let (arrived, resume) = checkpoints(&mut events);
        let producer = scope.spawn(move || {
            events.invalidate(SessionInvalidationCause::Locked);
            events.invalidate(SessionInvalidationCause::Logout);
        });
        let mut notifications = 0;
        for _ in 0..6 {
            arrived.recv_timeout(Duration::from_secs(5)).unwrap();
            notifications += consume(&mut recovery, &requests);
            resume.send(()).unwrap();
        }
        producer.join().unwrap();
        assert_eq!(notifications, 2);
    });
    // No polling flush after join may rescue a missed notification. The record
    // must already be latched once by notification-driven processing alone.
    assert_eq!(requests.take_causes(), 0);
    let record = recovery.record().unwrap().clone();
    assert!(record.latched);
    assert_eq!(record.pause_epoch, 10);
    drop(recovery);
    assert_eq!(lock.journal().read().unwrap(), Some(record));
}

#[test]
fn racing_producer_notifies_with_first_cause_before_first_producer_returns() {
    let directory = TestDirectory::new();
    let mut lock = elected(&directory);
    let mut recovery = lock.recover_retained();
    assert!(recovery.verify_storage().is_ok());
    let mut first = recovery.session_invalidator();
    let second = recovery.session_invalidator();
    let requests = first.retirement_requests();
    thread::scope(|scope| {
        let (arrived, resume) = checkpoints(&mut first);
        let producer = scope.spawn(move || first.invalidate(SessionInvalidationCause::Locked));
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(consume(&mut recovery, &requests), 0);
        assert_eq!(recovery.session_invalidation(), None);
        resume.send(()).unwrap();
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        // First cause retained, but first producer has not published its bit.
        assert_eq!(consume(&mut recovery, &requests), 0);
        assert_eq!(
            recovery.session_invalidation(),
            Some(SessionInvalidationCause::Locked)
        );
        second.invalidate(SessionInvalidationCause::Logout);
        assert_eq!(consume(&mut recovery, &requests), 1);
        resume.send(()).unwrap();
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(consume(&mut recovery, &requests), 1);
        resume.send(()).unwrap();
        producer.join().unwrap();
    });
    assert_eq!(requests.take_causes(), 0);
    let record = recovery.record().unwrap().clone();
    drop(recovery);
    assert_eq!(lock.journal().read().unwrap(), Some(record));
}
