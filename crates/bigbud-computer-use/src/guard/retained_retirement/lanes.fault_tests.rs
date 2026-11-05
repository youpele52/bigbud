use super::*;
use std::{fs, os::unix::fs::PermissionsExt};

#[test]
#[allow(clippy::panic)] // Deliberate fixture unwind; never production journal behavior.
fn storage_unwind_keeps_live_signal_borrow_and_sticky_unknown_without_retry() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let calls = attach(&mut recovery);
    let before = recovery.record().unwrap().clone();
    let bytes = fs::read(directory.0.join("safety.v1")).unwrap();
    recovery
        .session_invalidator()
        .invalidate(crate::guard::SessionInvalidationCause::Locked);
    let (mut signal, mut storage) = recovery.split_retirement();
    let failed = thread::scope(|scope| {
        scope
            .spawn(move || {
                Journal::fixture_before_state(|| panic!("fixture storage unwind"));
                let _result = storage.flush();
            })
            .join()
            .is_err()
    });
    assert!(failed);
    assert!(signal.sample(Ok(7)).unwrap().unknown);
    assert_eq!(signal.sample(Ok(250_000_007)).unwrap().kill_sent, 1);
    drop(signal);
    for _ in 0..100 {
        assert!(matches!(
            recovery.flush_retirement_invalidation(),
            Err(RecoveryFailure::Interrupted)
        ));
        assert!(matches!(
            recovery.verify_storage(),
            Err(RecoveryFailure::Interrupted)
        ));
    }
    assert_eq!(recovery.record().unwrap().roots, before.roots);
    assert!(recovery.record().unwrap().latched);
    assert_eq!(fs::read(directory.0.join("safety.v1")).unwrap(), bytes);
    assert_eq!(signals(&calls[0]), ["TERM", "KILL"]);
}

#[test]
fn storage_error_reborrows_do_not_replace_targets_or_extend_original_deadline() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let calls = attach(&mut recovery);
    let roots = recovery.record().unwrap().roots.clone();
    let path = directory.0.join("safety.v1");
    let bytes = fs::read(&path).unwrap();
    let (mut signal, mut storage) = recovery.split_retirement();
    assert_eq!(signal.sample(Ok(10)).unwrap().term_sent, 1);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    assert!(matches!(storage.flush(), Err(RecoveryFailure::Read(_))));
    assert!(signal.sample(Ok(11)).unwrap().unknown);
    drop(storage);
    drop(signal);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    for _ in 0..100 {
        let (mut signal, mut storage) = recovery.split_retirement();
        assert!(matches!(storage.flush(), Err(RecoveryFailure::Read(_))));
        assert_eq!(signal.sample(Ok(250_000_009)).unwrap().kill_sent, 0);
    }
    assert_eq!(step(&mut recovery, 250_000_010).kill_sent, 1);
    assert!(step(&mut recovery, 2_000_000_010).unknown);
    assert_eq!(recovery.record().unwrap().roots, roots);
    assert_eq!(
        recovery.retirement.as_ref().unwrap().targets[0].root(),
        &roots[0]
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert_eq!(signals(&calls[0]), ["TERM", "KILL"]);
}

#[test]
fn returning_lanes_and_cancelled_scoped_consumer_keeps_service_ownership() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory, armed());
    let mut recovery = elected.recover_retained();
    let calls = attach(&mut recovery);
    for _ in 0..100 {
        let (mut signal, storage) = recovery.split_retirement();
        thread::scope(|scope| {
            let (cancel, cancelled) = mpsc::sync_channel(1);
            cancel.send(()).unwrap();
            scope
                .spawn(move || {
                    cancelled.recv_timeout(LIMIT).unwrap();
                    let _status = signal.sample(Ok(0));
                    // Returning is cancellation of this fixture consumer ONLY, not
                    // shutdown/death of any process or cancellation of retirement.
                })
                .join()
                .unwrap();
        });
        drop(storage);
    }
    assert_eq!(step(&mut recovery, 250_000_000).kill_sent, 1);
    assert!(step(&mut recovery, 2_000_000_000).unknown);
    assert_eq!(signals(&calls[0]), ["TERM", "KILL"]);
    assert!(matches!(
        ControllingLock::acquire_in_verified_directory(&directory.0),
        Err(LockError::Conflict)
    ));
}
