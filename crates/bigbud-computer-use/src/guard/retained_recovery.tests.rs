use super::*;
use crate::guard::{
    LockError,
    test_support::{TestDirectory, armed},
};
use crate::owner::private_bootstrap::BootstrapPermit;
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
fn missing_state_is_durably_initial_not_permission_and_election_survives_drop() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    let mut recovery = elected.recover_retained();
    assert_eq!(recovery.record(), Some(&SafetyRecord::initial()));
    assert!(recovery.failure().is_none());
    assert!(recovery.verify_storage().is_ok());
    assert!(BootstrapPermit::verify().is_err());
    conflict(&directory);
    drop(recovery);
    conflict(&directory);
    assert_eq!(
        elected.journal().read().unwrap(),
        Some(SafetyRecord::initial())
    );
    drop(elected);
    let mut elected = lock(&directory);
    assert!(elected.recover_retained().verify_storage().is_ok());
}

#[test]
fn unclean_recovery_retains_every_root_binding_notice_and_armed_uncertainty() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    let prior = SafetyRecord {
        latched: false,
        ..armed()
    };
    elected.journal().replace(&prior).unwrap();
    let mut recovery = elected.recover_retained();
    let record = recovery.record().unwrap().clone();
    assert!(record.latched && record.armed && record.input_uncertain);
    assert_eq!(record.pause_epoch, prior.pause_epoch + 1);
    assert_eq!(record.reason, "unclean_recovery");
    assert_eq!(record.roots, prior.roots);
    assert_eq!(record.binding, prior.binding);
    assert_eq!(record.notice, prior.notice);
    assert!(matches!(
        recovery.verify_storage(),
        Err(RecoveryFailure::Unsettled)
    ));
    conflict(&directory);
    drop(recovery);
    assert_eq!(elected.journal().read().unwrap(), Some(record));
}

#[test]
fn recovered_armed_without_roots_still_requires_pause_and_input_recovery() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    let prior = SafetyRecord {
        roots: vec![],
        ..armed()
    };
    elected.journal().replace(&prior).unwrap();
    let mut recovery = elected.recover_retained();
    assert!(recovery.verify_storage().is_ok());
    let record = recovery.record().unwrap();
    assert!(record.latched && record.armed && record.input_uncertain);
    assert_eq!(record.pause_epoch, 1);
    assert!(BootstrapPermit::verify().is_err());
}

#[test]
fn clean_state_preserves_existing_latch_and_epoch_without_inventing_resume() {
    for latched in [true, false] {
        let directory = TestDirectory::new();
        let mut elected = lock(&directory);
        let prior = SafetyRecord {
            latched,
            pause_epoch: 7,
            reason: "clean".into(),
            ..SafetyRecord::initial()
        };
        elected.journal().replace(&prior).unwrap();
        let mut recovery = elected.recover_retained();
        assert_eq!(recovery.record(), Some(&prior));
        assert!(recovery.verify_storage().is_ok());
        assert!(BootstrapPermit::verify().is_err());
    }
}

#[test]
fn corrupt_state_is_preserved_and_failed_recovery_keeps_election() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    elected.journal().replace(&armed()).unwrap();
    overwrite(&directory, b"corrupt\n");
    let mut recovery = elected.recover_retained();
    assert!(recovery.record().is_none());
    assert!(matches!(
        recovery.failure(),
        Some(RecoveryFailure::Read(JournalError::Invalid))
    ));
    assert!(recovery.verify_storage().is_err());
    assert_eq!(
        fs::read(directory.0.join("safety.v1")).unwrap(),
        b"corrupt\n"
    );
    conflict(&directory);
}

#[test]
fn unexpected_creation_is_not_treated_as_missing_state() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    fs::write(directory.0.join("safety.v1"), b"foreign\n").unwrap();
    fs::set_permissions(
        directory.0.join("safety.v1"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let mut recovery = elected.recover_retained();
    assert!(recovery.record().is_none());
    assert!(recovery.verify_storage().is_err());
    assert_eq!(
        fs::read(directory.0.join("safety.v1")).unwrap(),
        b"foreign\n"
    );
    conflict(&directory);
}

#[test]
fn epoch_exhaustion_persists_revocation_but_never_becomes_ready() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    let prior = SafetyRecord {
        latched: false,
        pause_epoch: u64::MAX,
        ..armed()
    };
    elected.journal().replace(&prior).unwrap();
    let mut recovery = elected.recover_retained();
    let record = recovery.record().unwrap().clone();
    assert!(record.latched && record.input_uncertain && record.armed);
    assert_eq!(record.roots, prior.roots);
    assert_eq!(record.pause_epoch, u64::MAX);
    assert_eq!(record.reason, "epoch_exhausted");
    assert!(matches!(
        recovery.verify_storage(),
        Err(RecoveryFailure::Fence(FenceError::Invalid))
    ));
    conflict(&directory);
    drop(recovery);
    assert_eq!(elected.journal().read().unwrap(), Some(record));
}

#[test]
fn persistence_failure_retains_revoked_snapshot_and_is_not_retried_after_repair() {
    let directory = TestDirectory::new();
    let elected = lock(&directory);
    elected.journal().replace(&armed()).unwrap();
    let record = elected.journal().read().unwrap().unwrap();
    let before = fs::read(directory.0.join("safety.v1")).unwrap();
    // Exercise the actual private post-read transition; inject a storage fault
    // between load and persist without racing a thread or touching user data.
    let mut recovery = RetainedRecovery {
        identity: super::super::interactive_identity::IdentityBinding::default(),
        lock: &elected,
        fence: None,
        failure: None,
        session: SessionInvalidator::new(),
        session_attempted: false,
        retirement: None,
        retirement_attempted: false,
        retirement_observation: retirement::Observation::default(),
    };
    fs::set_permissions(
        directory.0.join("safety.v1"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    recovery.restore(record);
    recovery
        .session_invalidator()
        .invalidate(SessionInvalidationCause::ObservationLost);
    assert!(matches!(
        recovery.flush_session_invalidation(),
        Err(RecoveryFailure::Fence(FenceError::Persistence(_)))
    ));
    assert_eq!(
        recovery.session_invalidation(),
        Some(SessionInvalidationCause::ObservationLost)
    );
    assert!(matches!(
        recovery.failure(),
        Some(RecoveryFailure::Fence(FenceError::Persistence(_)))
    ));
    assert!(recovery.fence.as_ref().unwrap().persistence_failed());
    let record = recovery.record().unwrap();
    assert!(record.latched && record.input_uncertain);
    assert_eq!(record.roots, armed().roots);
    assert_eq!(record.pause_epoch, 1);
    fs::set_permissions(
        directory.0.join("safety.v1"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(recovery.verify_storage().is_err());
    assert_eq!(fs::read(directory.0.join("safety.v1")).unwrap(), before);
    conflict(&directory);
}

#[test]
fn same_inode_valid_content_change_fences_and_restoration_cannot_clear_failure() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    let mut recovery = elected.recover_retained();
    assert!(recovery.verify_storage().is_ok());
    let before = fs::read(directory.0.join("safety.v1")).unwrap();
    let changed = String::from_utf8(before.clone())
        .unwrap()
        .replace("initial", "changed");
    overwrite(&directory, changed.as_bytes());
    assert!(matches!(
        recovery.verify_storage(),
        Err(RecoveryFailure::Changed)
    ));
    assert_eq!(recovery.record(), Some(&SafetyRecord::initial()));
    overwrite(&directory, &before);
    assert!(matches!(
        recovery.verify_storage(),
        Err(RecoveryFailure::Changed)
    ));
    conflict(&directory);
}

#[test]
fn journal_replacement_refuses_even_identical_bytes_and_preserves_both_names() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    let mut recovery = elected.recover_retained();
    let bytes = fs::read(directory.0.join("safety.v1")).unwrap();
    fs::rename(directory.0.join("safety.v1"), directory.0.join("old")).unwrap();
    fs::write(directory.0.join("safety.v1"), &bytes).unwrap();
    fs::set_permissions(
        directory.0.join("safety.v1"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(recovery.verify_storage().is_err());
    assert_eq!(fs::read(directory.0.join("old")).unwrap(), bytes);
    assert_eq!(fs::read(directory.0.join("safety.v1")).unwrap(), bytes);
    conflict(&directory);
}

#[test]
fn election_name_replacement_invalidates_prior_storage_success() {
    let directory = TestDirectory::new();
    let mut elected = lock(&directory);
    let mut recovery = elected.recover_retained();
    assert!(recovery.verify_storage().is_ok());
    fs::rename(
        directory.0.join("controller.lock"),
        directory.0.join("old-lock"),
    )
    .unwrap();
    fs::write(directory.0.join("controller.lock"), b"replacement").unwrap();
    fs::set_permissions(
        directory.0.join("controller.lock"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(recovery.verify_storage().is_err());
    assert_eq!(
        fs::read(directory.0.join("controller.lock")).unwrap(),
        b"replacement"
    );
}
