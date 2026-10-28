use super::*;
use crate::guard::{
    LockError, RetirementCause,
    test_support::{TestDirectory, armed},
};
use std::{
    fs,
    io::{Seek, Write},
    os::unix::fs::PermissionsExt,
};

fn lock(directory: &TestDirectory) -> ControllingLock {
    ControllingLock::acquire_in_verified_directory(&directory.0).unwrap()
}
fn conflict(directory: &TestDirectory) {
    assert!(matches!(
        ControllingLock::acquire_in_verified_directory(&directory.0),
        Err(LockError::Conflict)
    ));
}
fn clean() -> SafetyRecord {
    SafetyRecord {
        latched: false,
        pause_epoch: 9,
        reason: "clean".into(),
        ..SafetyRecord::initial()
    }
}
fn overwrite(directory: &TestDirectory, bytes: &[u8]) {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .open(directory.0.join("safety.v1"))
        .unwrap();
    file.rewind().unwrap();
    file.write_all(bytes).unwrap();
    file.set_len(bytes.len() as u64).unwrap();
    file.sync_all().unwrap();
}

#[test]
fn every_cause_revokes_priority_then_durably_latches_same_election() {
    for cause in [
        SessionInvalidationCause::Locked,
        SessionInvalidationCause::Logout,
        SessionInvalidationCause::UserSwitched,
        SessionInvalidationCause::DesktopLost,
        SessionInvalidationCause::RemoteTransition,
        SessionInvalidationCause::IdentityChanged,
        SessionInvalidationCause::ObservationLost,
    ] {
        let directory = TestDirectory::new();
        let mut elected = lock(&directory);
        elected.journal().replace(&clean()).unwrap();
        let mut recovery = elected.recover_retained();
        assert!(recovery.verify_storage().is_ok());
        let events = recovery.session_invalidator();
        let priority = events.retirement_requests();
        assert_eq!(priority.take_causes(), 0);
        let before = fs::read(directory.0.join("safety.v1")).unwrap();
        events.invalidate(cause);
        assert!(priority.admission_closed());
        assert_eq!(
            priority.take_causes(),
            RetirementCause::SessionInvalidated as u8
        );
        assert_eq!(fs::read(directory.0.join("safety.v1")).unwrap(), before);
        assert_eq!(recovery.session_invalidation(), Some(cause));
        assert!(
            matches!(recovery.verify_storage(), Err(RecoveryFailure::SessionInvalidated(found)) if *found == cause)
        );
        let record = recovery.record().unwrap().clone();
        assert!(record.latched);
        assert_eq!(record.pause_epoch, 10);
        assert_eq!(record.reason, cause.reason());
        assert!(!record.armed && !record.input_uncertain);
        conflict(&directory);
        drop(recovery);
        conflict(&directory);
        assert_eq!(elected.journal().read().unwrap(), Some(record));
        assert!(crate::owner::private_bootstrap::BootstrapPermit::verify().is_err());
    }
}

#[test]
fn repeated_events_and_drained_wakeups_never_clear_or_repeat_persistence() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    elected.journal().replace(&clean()).unwrap();
    let mut recovery = elected.recover_retained();
    let events = recovery.session_invalidator();
    events.invalidate(SessionInvalidationCause::Locked);
    assert!(recovery.flush_session_invalidation().is_err());
    let record = recovery.record().unwrap().clone();
    let bytes = fs::read(directory.0.join("safety.v1")).unwrap();
    for _ in 0..1000 {
        events.invalidate(SessionInvalidationCause::IdentityChanged);
        let _causes = events.retirement_requests().take_causes();
    }
    drop(events);
    assert!(recovery.flush_session_invalidation().is_err());
    assert!(recovery.verify_storage().is_err());
    assert_eq!(
        recovery.session_invalidation(),
        Some(SessionInvalidationCause::Locked)
    );
    assert_eq!(recovery.record(), Some(&record));
    assert_eq!(fs::read(directory.0.join("safety.v1")).unwrap(), bytes);
    drop(recovery);
    let mut restarted = elected.recover_retained();
    // Storage success on restart does not clear the persisted pause or prove
    // that the desktop is unlocked. No identity sampler is being simulated.
    assert!(restarted.verify_storage().is_ok());
    assert_eq!(restarted.record(), Some(&record));
}

#[test]
fn armed_session_invalidation_preserves_roots_binding_notice_and_uncertainty() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    elected.journal().replace(&armed()).unwrap();
    let mut recovery = elected.recover_retained();
    let previous = recovery.record().unwrap().clone();
    recovery
        .session_invalidator()
        .invalidate(SessionInvalidationCause::DesktopLost);
    assert!(recovery.flush_session_invalidation().is_err());
    let record = recovery.record().unwrap().clone();
    assert!(record.latched && record.armed && record.input_uncertain);
    assert_eq!(record.pause_epoch, previous.pause_epoch + 1);
    assert_eq!(record.roots, previous.roots);
    assert_eq!(record.binding, previous.binding);
    assert_eq!(record.notice, previous.notice);
    drop(recovery);
    assert_eq!(elected.journal().read().unwrap(), Some(record));
}

#[test]
fn changed_bytes_are_preserved_but_memory_is_latched_before_storage_failure() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    elected.journal().replace(&clean()).unwrap();
    let mut recovery = elected.recover_retained();
    assert!(!recovery.record().unwrap().latched);
    let before = fs::read(directory.0.join("safety.v1")).unwrap();
    let changed = String::from_utf8(before.clone())
        .unwrap()
        .replace("clean", "other");
    overwrite(&directory, changed.as_bytes());
    recovery
        .session_invalidator()
        .invalidate(SessionInvalidationCause::Logout);
    assert!(matches!(
        recovery.flush_session_invalidation(),
        Err(RecoveryFailure::Changed)
    ));
    assert!(recovery.record().unwrap().latched);
    assert_eq!(
        fs::read(directory.0.join("safety.v1")).unwrap(),
        changed.as_bytes()
    );
    overwrite(&directory, &before);
    assert!(matches!(
        recovery.verify_storage(),
        Err(RecoveryFailure::Changed)
    ));
    assert_eq!(fs::read(directory.0.join("safety.v1")).unwrap(), before);
    conflict(&directory);
}

#[test]
fn unreadable_storage_and_later_repair_never_acknowledge_invalidation() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    elected.journal().replace(&clean()).unwrap();
    let mut recovery = elected.recover_retained();
    let before = fs::read(directory.0.join("safety.v1")).unwrap();
    fs::set_permissions(
        directory.0.join("safety.v1"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    recovery
        .session_invalidator()
        .invalidate(SessionInvalidationCause::ObservationLost);
    assert!(matches!(
        recovery.flush_session_invalidation(),
        Err(RecoveryFailure::Read(_))
    ));
    assert!(recovery.record().unwrap().latched);
    fs::set_permissions(
        directory.0.join("safety.v1"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(matches!(
        recovery.verify_storage(),
        Err(RecoveryFailure::Read(_))
    ));
    assert_eq!(fs::read(directory.0.join("safety.v1")).unwrap(), before);
}

#[test]
fn corrupt_recovery_retains_first_failure_and_priority_request_without_repair() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    elected.journal().replace(&clean()).unwrap();
    overwrite(&directory, b"corrupt\n");
    let mut recovery = elected.recover_retained();
    let events = recovery.session_invalidator();
    events.invalidate(SessionInvalidationCause::UserSwitched);
    assert!(matches!(
        recovery.flush_session_invalidation(),
        Err(RecoveryFailure::Read(JournalError::Invalid))
    ));
    assert!(recovery.record().is_none());
    assert_eq!(
        events.retirement_requests().take_causes(),
        RetirementCause::SessionInvalidated as u8
    );
    assert_eq!(
        fs::read(directory.0.join("safety.v1")).unwrap(),
        b"corrupt\n"
    );
    conflict(&directory);
}

#[test]
fn epoch_overflow_is_durably_latched_not_successfully_acknowledged() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    elected
        .journal()
        .replace(&SafetyRecord {
            pause_epoch: u64::MAX,
            ..clean()
        })
        .unwrap();
    let mut recovery = elected.recover_retained();
    recovery
        .session_invalidator()
        .invalidate(SessionInvalidationCause::RemoteTransition);
    assert!(matches!(
        recovery.flush_session_invalidation(),
        Err(RecoveryFailure::Fence(FenceError::Invalid))
    ));
    let record = recovery.record().unwrap().clone();
    assert!(record.latched);
    assert_eq!(record.reason, "epoch_exhausted");
    assert_eq!(record.pause_epoch, u64::MAX);
    assert!(recovery.verify_storage().is_err());
    drop(recovery);
    assert_eq!(elected.journal().read().unwrap(), Some(record));
}

#[test]
fn old_handles_cannot_invalidate_a_new_recovery_or_release_its_election() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    let recovery = elected.recover_retained();
    let old = recovery.session_invalidator();
    drop(recovery);
    let mut next = elected.recover_retained();
    old.invalidate(SessionInvalidationCause::Locked);
    assert_eq!(next.session_invalidation(), None);
    assert!(next.verify_storage().is_ok());
    conflict(&directory);
    // The eventual observer must be rebound before readiness. This test proves
    // isolation only, not event subscription coverage across recovery restart.
}
