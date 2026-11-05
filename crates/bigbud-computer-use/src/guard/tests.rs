use super::record::SafetyRecord;
use super::test_support::{TestDirectory, armed};
use super::*;
use crate::worker::Observation;
#[cfg(unix)]
use std::fs;
use std::path::Path;

fn environment<'a>(home: &'a Path, xdg: Option<&'a Path>) -> RootEnvironment<'a> {
    RootEnvironment {
        home: Some(home),
        xdg_state_home: xdg,
        local_app_data: None,
    }
}
#[test]
fn root_is_per_user_not_profile_or_release() {
    let home = std::env::temp_dir();
    assert_eq!(
        resolve_root(UserPlatform::MacOs, environment(&home, None)),
        Some(home.join("Library/Application Support/bigbud/computer-use"))
    );
    assert_eq!(
        resolve_root(UserPlatform::Linux, environment(&home, None)),
        Some(home.join(".local/state/bigbud/computer-use"))
    );
    let xdg = home.join("xdg");
    assert_eq!(
        resolve_root(UserPlatform::Linux, environment(&home, Some(&xdg))),
        Some(xdg.join("bigbud/computer-use"))
    );
    assert!(
        resolve_root(
            UserPlatform::Linux,
            environment(&home, Some(Path::new("relative")))
        )
        .is_none()
    );
    assert!(resolve_root(UserPlatform::Windows, environment(&home, None)).is_none());
}
#[test]
fn exclusive_os_lock_refuses_duplicate_handle_until_drop() {
    let directory = TestDirectory::new();
    let first = ControllingLock::acquire_in_verified_directory(&directory.0).unwrap();
    assert!(matches!(
        ControllingLock::acquire_in_verified_directory(&directory.0),
        Err(LockError::Conflict)
    ));
    drop(first);
    let _second = ControllingLock::acquire_in_verified_directory(&directory.0).unwrap();
}
#[test]
#[cfg(unix)]
fn rejects_symlink_roots_and_lock_files() {
    use std::os::unix::fs::symlink;
    let directory = TestDirectory::new();
    symlink(&directory.0, directory.0.join("alias")).unwrap();
    assert!(matches!(
        ControllingLock::acquire_in_verified_directory(&directory.0.join("alias")),
        Err(LockError::InvalidRoot)
    ));
    fs::write(directory.0.join("other"), b"untouched").unwrap();
    symlink(
        directory.0.join("other"),
        directory.0.join("controller.lock"),
    )
    .unwrap();
    assert!(matches!(
        ControllingLock::acquire_in_verified_directory(&directory.0),
        Err(LockError::InvalidRoot)
    ));
    assert_eq!(fs::read(directory.0.join("other")).unwrap(), b"untouched");
}
#[test]
fn armed_recovery_fences_and_retains_uncertain_notice_and_input() {
    let prior = armed();
    let recovery = recover(prior.clone(), &[Observation::Unavailable]).unwrap();
    assert!(recovery.record.latched && recovery.record.armed && recovery.record.input_uncertain);
    assert_eq!(recovery.record.pause_epoch, 1);
    assert_eq!(recovery.record.notice, prior.notice);
    assert_eq!(recovery.unsettled_roots, 1);
    let reused = recover(
        prior,
        &[Observation::Alive {
            creation_identity: "birth-2".into(),
        }],
    )
    .unwrap();
    assert_eq!(reused.unsettled_roots, 0);
    assert!(reused.record.latched && reused.record.armed && reused.record.input_uncertain);
}
#[test]
fn recovery_cannot_wrap_epoch_or_invent_missing_evidence() {
    assert!(recover(armed(), &[]).is_none());
    let record = SafetyRecord {
        pause_epoch: u64::MAX,
        ..armed()
    };
    assert!(recover(record, &[Observation::Gone]).is_none());
    assert!(SafetyRecord::initial().latched);
}

#[test]
#[cfg(unix)]
fn private_root_and_single_link_lock_are_required() {
    use std::os::unix::fs::PermissionsExt;
    let directory = TestDirectory::new();
    fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(
        ControllingLock::acquire_in_verified_directory(&directory.0),
        Err(LockError::InvalidRoot)
    ));
    assert!(!directory.0.join("controller.lock").exists());
    fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o700)).unwrap();
    let first = ControllingLock::acquire_in_verified_directory(&directory.0).unwrap();
    drop(first);
    fs::hard_link(
        directory.0.join("controller.lock"),
        directory.0.join("alias"),
    )
    .unwrap();
    assert!(matches!(
        ControllingLock::acquire_in_verified_directory(&directory.0),
        Err(LockError::InvalidRoot)
    ));
}
