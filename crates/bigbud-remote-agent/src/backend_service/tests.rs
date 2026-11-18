#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::cli::{apply, prerequisites};
use super::command::Manager;
use super::*;
use std::fs;
#[path = "tests.fixture.rs"]
pub(super) mod fixture;
use fixture::{FakeManager, Fixture, mode, write};

#[test]
fn cli_rejects_missing_unknown_or_unsafe_role_arguments_before_any_service_operation() {
    assert!(run_cli(Vec::<String>::new().into_iter()).is_err());
    assert!(
        run_cli(
            ["auto-enable-root", "/unused"]
                .into_iter()
                .map(str::to_owned)
        )
        .is_err()
    );
    assert!(run_cli(["run", "/unused", "rust"].into_iter().map(str::to_owned)).is_err());
    assert!(
        run_cli(
            ["run", "/unused", "replay-turn"]
                .into_iter()
                .map(str::to_owned)
        )
        .is_err()
    );
}

#[test]
#[cfg(unix)]
fn private_config_and_pins_validate_without_executing_fixture_artifacts() {
    let fixture = Fixture::new();
    let loaded = ServiceConfig::load(&fixture.config.config_path()).unwrap();
    assert_eq!(loaded.authority, fixture.config.authority);
    let command = loaded.command(ServiceRole::Backend).unwrap();
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        vec![fixture.config.backend_entry.as_os_str()]
    );
    assert!(!format!("{:?}", command.get_args().collect::<Vec<_>>()).contains("fixture-secret"));
    let environment: Vec<_> = command.get_envs().collect();
    assert!(
        environment
            .iter()
            .any(|(key, value)| key == &"BIGBUD_REMOTE_SERVICE_CONFIG"
                && value == &Some(loaded.config_path().as_os_str()))
    );
    assert!(
        environment
            .iter()
            .any(|(key, value)| key == &"BIGBUD_AUTH_TOKEN"
                && value == &Some(std::ffi::OsStr::new("fixture-secret-not-in-argv")))
    );
    assert!(
        !environment
            .iter()
            .any(|(key, _)| key.to_string_lossy().contains("DESKTOP"))
    );
}

#[test]
#[cfg(unix)]
fn rejects_unsafe_credentials_changed_artifacts_and_unmanaged_paths() {
    let mut fixture = Fixture::new();
    mode(&fixture.config.token_path(), 0o644);
    assert!(fixture.config.validate().is_err());
    mode(&fixture.config.token_path(), 0o600);
    fs::write(&fixture.config.rust_binary, b"changed").unwrap();
    assert!(fixture.config.validate().is_err());
    fixture.config.rust_binary = fixture.root.join("node");
    fixture.config.rust_sha256 = fixture.config.node_sha256.clone();
    assert!(fixture.config.validate().is_err());
}

#[test]
#[cfg(unix)]
fn rust_role_remains_independent_of_optional_backend_files_and_credentials() {
    let fixture = Fixture::new();
    fs::remove_file(&fixture.config.node_binary).unwrap();
    fs::remove_file(fixture.config.token_path()).unwrap();
    assert!(fixture.config.command(ServiceRole::Backend).is_err());
    assert!(fixture.config.validate_role(ServiceRole::Rust).is_ok());
    assert!(fixture.config.command(ServiceRole::Rust).is_err());
    let unit = super::unit::render_definition(&fixture.config).unwrap();
    assert!(!unit.rust.contains("BIGBUD_REMOTE_SERVICE_CONFIG"));
}

#[test]
#[cfg(unix)]
fn symlink_config_and_generation_bound_backend_state_are_refused() {
    let mut fixture = Fixture::new();
    let original = fixture.config.token_path();
    let copy = fixture.config.config_dir().join("token-copy");
    fs::rename(&original, &copy).unwrap();
    std::os::unix::fs::symlink(copy, original).unwrap();
    assert!(fixture.config.validate().is_err());
    fixture.config.backend_home = fixture.config.rust_state.clone();
    assert!(fixture.config.validate().is_err());
    assert!(ServiceConfig::parse(&(fixture.text() + "restart=no\n")).is_err());
}

#[test]
#[cfg(unix)]
fn independent_units_limit_to_initial_plus_five_and_never_embed_credentials() {
    let mut fixture = Fixture::new();
    let units = render_units(&fixture.config).unwrap();
    assert!(
        units
            .backend
            .contains("StartLimitIntervalSec=300\nStartLimitBurst=6")
    );
    assert!(units.backend.contains("Restart=on-failure"));
    assert!(units.rust.contains("Restart=no"));
    // A settled signal stop (143) is clean for Rust only; crashes and exit 1 still fail.
    assert!(units.rust.contains("\nSuccessExitStatus=143\n"));
    assert!(!units.backend.contains("SuccessExitStatus"));
    // Only a clean backend stop flushes its own start-rate counter.
    assert_eq!(
        units
            .backend
            .lines()
            .filter(|line| line.starts_with("ExecStopPost="))
            .collect::<Vec<_>>(),
        [
            "ExecStopPost=-/bin/sh -c 'case $$SERVICE_RESULT in success) exec /usr/bin/systemctl --user --no-ask-password reset-failed $$1;; esac' sh %n"
        ]
    );
    assert!(!units.rust.contains("ExecStopPost="));
    assert!(!units.rust.contains("WantedBy="));
    assert!(units.backend.contains("WantedBy=default.target"));
    for unit in [&units.backend, &units.rust] {
        assert!(unit.contains("KillMode=control-group"));
        assert!(!unit.contains("PartOf="));
        assert!(!unit.contains("BindsTo="));
        assert!(!unit.contains("fixture-secret"));
        assert!(!unit.contains("BIGBUD_AUTH_TOKEN"));
    }
    fixture.config.restart = false;
    let disabled = render_units(&fixture.config).unwrap();
    assert!(disabled.backend.contains("Restart=no"));
    assert!(disabled.backend.contains("SendSIGKILL=yes"));
}

#[test]
#[cfg(unix)]
fn startup_requires_consent_and_prerequisites_without_enabling_linger_or_starting_units() {
    let fixture = Fixture::new();
    let manager = FakeManager::default();
    assert!(matches!(
        apply(
            &fixture.config,
            "stage",
            false,
            &manager,
            Prerequisites::Ready
        ),
        Err(ServiceError::ConsentRequired)
    ));
    apply(
        &fixture.config,
        "stage",
        true,
        &manager,
        Prerequisites::MissingLinger,
    )
    .unwrap();
    assert!(
        apply(
            &fixture.config,
            "enable",
            true,
            &manager,
            Prerequisites::MissingLinger
        )
        .is_err()
    );
    assert!(
        manager
            .calls
            .borrow()
            .iter()
            .all(|(program, _)| program.ends_with("bigbud-remote-agent"))
    );
    manager.calls.borrow_mut().clear();
    assert!(
        apply(
            &fixture.config,
            "enable",
            true,
            &manager,
            Prerequisites::Ready,
        )
        .is_err()
    );
    assert!(
        manager
            .calls
            .borrow()
            .iter()
            .all(|(program, _)| program.ends_with("bigbud-remote-agent"))
    );
    manager.calls.borrow_mut().clear();
    apply(
        &fixture.config,
        "disable",
        false,
        &manager,
        Prerequisites::Ready,
    )
    .unwrap();
    let calls = manager.calls.borrow();
    assert!(calls.iter().all(|(_, args)| {
        args.iter()
            .all(|arg| arg != "--now" && arg != "start" && arg != "stop" && arg != "enable-linger")
    }));
    assert!(fixture.config.config_path().exists());
}

#[test]
#[cfg(unix)]
fn existing_user_unit_is_never_overwritten() {
    let fixture = Fixture::new();
    let manager = FakeManager::default();
    apply(
        &fixture.config,
        "stage",
        true,
        &manager,
        Prerequisites::Ready,
    )
    .unwrap();
    let name = UnitNames::new(&fixture.config).backend;
    let unit = fixture.root.join(".config/systemd/user").join(name);
    write(&unit, b"user-managed-unit", 0o600);
    assert!(
        apply(
            &fixture.config,
            "stage",
            true,
            &manager,
            Prerequisites::Ready
        )
        .is_err()
    );
    assert!(
        apply(
            &fixture.config,
            "enable",
            true,
            &manager,
            Prerequisites::Ready
        )
        .is_err()
    );
    assert_eq!(fs::read(unit).unwrap(), b"user-managed-unit");
    assert!(
        manager
            .calls
            .borrow()
            .iter()
            .all(|(program, _)| program.ends_with("bigbud-remote-agent"))
    );
}

#[test]
#[cfg(unix)]
fn old_verified_artifact_is_not_given_unknown_service_flags() {
    let fixture = Fixture::new();
    let manager = FakeManager {
        old_artifact: true,
        ..FakeManager::default()
    };
    assert!(
        apply(
            &fixture.config,
            "stage",
            true,
            &manager,
            Prerequisites::Ready
        )
        .is_err()
    );
    assert!(!fixture.root.join(".config").exists());
    assert!(
        manager
            .calls
            .borrow()
            .iter()
            .all(|(_, args)| args == &["--check", "--capabilities"])
    );
}

#[test]
fn exact_status_and_remediation_never_infer_logout_support_from_a_process() {
    let missing = FakeManager {
        missing: true,
        ..FakeManager::default()
    };
    assert_eq!(
        prerequisites(&missing, 1000, true),
        Prerequisites::MissingUserManager
    );
    let no_linger = FakeManager::default();
    assert_eq!(
        prerequisites(&no_linger, 1000, true),
        Prerequisites::MissingLinger
    );
    assert!(
        Prerequisites::MissingLinger
            .remediation(1000)
            .contains("loginctl enable-linger 1000")
    );
    assert_eq!(
        prerequisites(&no_linger, 0, true),
        Prerequisites::Unsupported
    );
    let status = UnitStatus::parse("LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=start-limit-hit\nUnitFileState=enabled\nNRestarts=5\n").unwrap();
    assert_eq!(status.state, ServiceState::NeedsRepair);
    assert_eq!(status.restarts, 5);
    assert!(UnitStatus::parse("ActiveState=active\n").is_err());
    assert_eq!(UnitStatus::parse("LoadState=loaded\nActiveState=inactive\nResult=success\nUnitFileState=static\nNRestarts=0\n").unwrap().state, ServiceState::Stopped);
    assert_eq!(
        UnitStatus::parse("LoadState=not-found\n").unwrap().state,
        ServiceState::NotInstalled
    );
}

#[test]
fn user_bus_requires_private_owned_directory_and_real_socket() {
    let fixture = Fixture::new();
    let bus = fixture.root.join("bus");
    let listener = std::os::unix::net::UnixListener::bind(&bus).unwrap();
    let mut command = std::process::Command::new("/usr/bin/systemctl");
    command
        .env("DBUS_SESSION_BUS_ADDRESS", "tcp:untrusted")
        .env("XDG_RUNTIME_DIR", "/untrusted");
    super::command::user_bus(&mut command, &fixture.root).unwrap();
    assert!(command.get_envs().any(|(key, value)| key == "XDG_RUNTIME_DIR"
        && value == Some(fixture.root.as_os_str())));
    let expected_bus = format!("unix:path={}", bus.display());
    assert!(
        command
            .get_envs()
            .any(|(key, value)| key == "DBUS_SESSION_BUS_ADDRESS"
                && value == Some(std::ffi::OsStr::new(&expected_bus)))
    );
    drop(listener);
    fs::remove_file(&bus).unwrap();
    write(&bus, b"not-a-bus", 0o600);
    assert!(super::command::user_bus(&mut command, &fixture.root).is_err());
    fs::remove_file(&bus).unwrap();
    let _listener = std::os::unix::net::UnixListener::bind(&bus).unwrap();
    mode(&fixture.root, 0o755);
    assert!(super::command::user_bus(&mut command, &fixture.root).is_err());
}
