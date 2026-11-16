#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::backend_service::tests::fixture::{Fixture, write};
use std::fs;

fn prepared() -> Fixture {
    let fixture = Fixture::new();
    let root = &fixture.config.rust_state;
    write(&root.join("launch.lock"), b"", 0o600);
    write(
        &root.join("launch.intent"),
        fixture.config.launch_attempt.as_bytes(),
        0o600,
    );
    write(
        &root.join("launch.boot"),
        fixture.config.launch_boot.as_bytes(),
        0o600,
    );
    fixture
}
#[test]
fn only_exact_fresh_p4_reservation_can_hold_lifetime_lock_and_settle_receipt() {
    let fixture = prepared();
    let guard = LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).unwrap();
    assert!(LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).is_err());
    guard
        .run(|root| {
            assert_eq!(root, fixture.config.rust_state);
            write(&root.join("epoch"), b"1234", 0o700);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        fs::read(fixture.config.rust_state.join("launch.exit")).unwrap(),
        b"0"
    );
    assert!(LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).is_err());
}
#[test]
fn rejects_changed_boot_attempt_and_unprepared_existing_epoch() {
    let mut fixture = prepared();
    assert!(
        LaunchGuard::with_boot(&fixture.config, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee").is_err()
    );
    fixture.config.launch_attempt = "different".into();
    assert!(LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).is_err());
    fixture.config.launch_attempt = "fixture-attempt".into();
    write(&fixture.config.rust_state.join("epoch"), b"1234", 0o700);
    assert!(LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).is_err());
    fixture.config.prior_epoch = "5678".into();
    assert!(LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).is_err());
}
#[test]
fn changed_reservation_or_lock_never_receives_an_exit_receipt() {
    for replace_lock in [false, true] {
        let fixture = prepared();
        let guard = LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).unwrap();
        assert!(
            guard
                .run(|root| {
                    if replace_lock {
                        fs::rename(root.join("launch.lock"), root.join("old.lock")).unwrap();
                        write(&root.join("launch.lock"), b"", 0o600);
                    } else {
                        write(&root.join("launch.intent"), b"different-attempt", 0o600);
                    }
                    Ok(())
                })
                .is_err()
        );
        assert!(!fixture.config.rust_state.join("launch.exit").exists());
    }
}
#[test]
fn requires_exact_independent_service_pid_and_cgroup_not_environment_claims() {
    let name = "bigbud-rust-fixture.service";
    let group = format!("/user.slice/user-1000.slice/user@1000.service/app.slice/{name}");
    let fragment =
        std::path::Path::new("/home/fixture/.config/systemd/user/bigbud-rust-fixture.service");
    let status = format!(
        "MainPID=42\nControlGroup={group}\nFragmentPath={}\n",
        fragment.display()
    );
    assert!(verify_owner(&status, &format!("0::{group}\n"), name, fragment, 1000, 42).is_ok());
    assert!(verify_owner(&status, &format!("0::{group}\n"), name, fragment, 1000, 43).is_err());
    assert!(
        verify_owner(
            &status,
            "0::/user.slice/backend.service\n",
            name,
            fragment,
            1000,
            42
        )
        .is_err()
    );
    assert!(
        verify_owner(
            &(status.clone() + "MainPID=42\n"),
            &format!("0::{group}\n"),
            name,
            fragment,
            1000,
            42
        )
        .is_err()
    );
}

#[test]
fn failed_supervisor_settles_failure_without_claiming_admission_or_success() {
    let fixture = prepared();
    let guard = LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).unwrap();
    assert!(guard.run(|_| Err(ServiceError::Supervisor)).is_err());
    assert_eq!(
        fs::read(fixture.config.rust_state.join("launch.exit")).unwrap(),
        b"1"
    );
}

#[test]
fn explicit_service_start_requires_consent_capability_and_only_starts_rust_unit() {
    use crate::backend_service::{
        Prerequisites, UnitNames, cli::apply, tests::fixture::FakeManager,
    };
    let fixture = prepared();
    let manager = FakeManager {
        fragment: Some(
            super::super::unit::unit_directory(&fixture.config)
                .join(UnitNames::new(&fixture.config).rust),
        ),
        ..FakeManager::default()
    };
    apply(
        &fixture.config,
        "stage",
        true,
        &manager,
        Prerequisites::Ready,
    )
    .unwrap();
    manager.calls.borrow_mut().clear();
    assert!(
        apply(
            &fixture.config,
            "start-rust",
            false,
            &manager,
            Prerequisites::Ready
        )
        .is_err()
    );
    assert!(
        apply(
            &fixture.config,
            "start-rust",
            true,
            &manager,
            Prerequisites::MissingLinger
        )
        .is_err()
    );
    assert!(manager.calls.borrow().is_empty());
    apply(
        &fixture.config,
        "start-rust",
        true,
        &manager,
        Prerequisites::Ready,
    )
    .unwrap();
    let calls = manager.calls.borrow();
    assert!(
        calls
            .iter()
            .any(|(_, args)| args.iter().any(|arg| arg == "start"))
    );
    let backend = UnitNames::new(&fixture.config).backend;
    assert!(calls.iter().all(|(_, args)| !args.contains(&backend)));
    let old = FakeManager {
        old_artifact: true,
        ..FakeManager::default()
    };
    assert!(
        apply(
            &fixture.config,
            "start-rust",
            true,
            &old,
            Prerequisites::Ready
        )
        .is_err()
    );
    assert!(
        old.calls
            .borrow()
            .iter()
            .all(|(_, args)| args == &["--check", "--capabilities"])
    );
}

#[test]
fn prepared_replacement_matches_old_epoch_and_never_retries_a_changed_epoch() {
    for mode in [0o600, 0o700] {
        let mut fixture = prepared();
        fixture.config.prior_epoch = "1234".into();
        let root = &fixture.config.rust_state;
        write(&root.join("epoch"), b"1234", mode);
        write(&root.join("operations.journal"), b"fixture-journal", 0o600);
        let guard = LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).unwrap();
        guard
            .run(|root| {
                write(&root.join("epoch"), b"5678", 0o700);
                Ok(())
            })
            .unwrap();
        fs::remove_file(root.join("launch.exit")).unwrap();
        assert!(LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).is_err());
        assert_eq!(fs::read(root.join("epoch")).unwrap(), b"5678");
    }
}

#[test]
fn replacement_preserves_unsafe_or_unsettled_evidence_without_starting() {
    let mut fixture = prepared();
    fixture.config.prior_epoch = "1234".into();
    let root = &fixture.config.rust_state;
    write(&root.join("epoch"), b"1234", 0o700);
    write(&root.join("operations.journal"), b"fixture-journal", 0o644);
    assert!(LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).is_err());
    fs::remove_file(root.join("operations.journal")).unwrap();
    write(&root.join("launch.exit"), b"0", 0o600);
    assert!(LaunchGuard::with_boot(&fixture.config, &fixture.config.launch_boot).is_err());
    assert_eq!(fs::read(root.join("launch.exit")).unwrap(), b"0");
}

#[test]
fn backend_and_rust_service_roles_reject_each_others_or_an_ordinary_process_owner() {
    for (actual, expected) in [
        (
            "bigbud-rust-fixture.service",
            "bigbud-backend-fixture.service",
        ),
        (
            "bigbud-backend-fixture.service",
            "bigbud-rust-fixture.service",
        ),
    ] {
        let group = format!("/user.slice/user-1000.slice/user@1000.service/app.slice/{actual}");
        let fragment =
            std::path::PathBuf::from(format!("/home/fixture/.config/systemd/user/{expected}"));
        let status = format!(
            "MainPID=42\nControlGroup={group}\nFragmentPath={}\n",
            fragment.display()
        );
        assert!(
            verify_owner(
                &status,
                &format!("0::{group}\n"),
                expected,
                &fragment,
                1000,
                42
            )
            .is_err()
        );
        assert!(
            verify_owner(
                &status,
                "0::/user.slice/ordinary-process.scope\n",
                expected,
                &fragment,
                1000,
                42
            )
            .is_err()
        );
    }
}

#[test]
fn running_launcher_must_match_both_pinned_path_and_kernel_inode() {
    let fixture = prepared();
    let expected = &fixture.config.rust_binary;
    let original = fs::metadata(expected).unwrap();
    assert!(evidence::same_executable(expected, expected, &original).is_ok());
    assert!(evidence::same_executable(expected, &fixture.config.node_binary, &original).is_err());
    let replaced = expected.with_extension("replacement");
    write(&replaced, b"other-generation", 0o700);
    fs::rename(&replaced, expected).unwrap();
    assert!(evidence::same_executable(expected, expected, &original).is_err());
    let deleted = std::path::PathBuf::from(format!("{} (deleted)", expected.display()));
    assert!(evidence::same_executable(expected, &deleted, &original).is_err());
    fs::remove_file(expected).unwrap();
    assert!(evidence::same_executable(expected, expected, &original).is_err());
}
