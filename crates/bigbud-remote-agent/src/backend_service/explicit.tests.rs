#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::backend_service::cli::apply;
use crate::backend_service::tests::fixture::{FakeManager, Fixture, write};
use crate::backend_service::unit::UnitNames;

fn staged(fixture: &Fixture) {
    apply(
        &fixture.config,
        "stage",
        true,
        &FakeManager::default(),
        Prerequisites::MissingLinger,
    )
    .unwrap();
}
fn manager(fixture: &Fixture, active: &'static str) -> FakeManager {
    FakeManager {
        fragment_dir: Some(unit_directory(&fixture.config)),
        unit_active: Some(active),
        ..Default::default()
    }
}
fn systemctl_calls(manager: &FakeManager) -> Vec<Vec<String>> {
    manager
        .calls
        .borrow()
        .iter()
        .filter(|(program, _)| program == SYSTEMCTL)
        .map(|(_, args)| args.clone())
        .collect()
}
fn assert_boot_policy_untouched(manager: &FakeManager) {
    for (program, args) in manager.calls.borrow().iter() {
        assert!(
            !program.ends_with("loginctl"),
            "linger must not be read or changed"
        );
        assert!(
            args.iter().all(|arg| !matches!(
                arg.as_str(),
                "enable" | "disable" | "--now" | "enable-linger" | "disable-linger" | "reenable"
            )),
            "{args:?}"
        );
    }
}

#[test]
fn start_does_not_enable_or_touch_linger() {
    let fixture = Fixture::new();
    staged(&fixture);
    let manager = FakeManager {
        active_after_job: Some("active"),
        ..manager(&fixture, "inactive")
    };
    let outcome = run(
        &fixture.config,
        Explicit::Start,
        &manager,
        Prerequisites::MissingLinger,
    )
    .unwrap();
    assert!(!outcome.already_running);
    let observed = outcome.observed;
    assert_boot_policy_untouched(&manager);
    let names = UnitNames::new(&fixture.config);
    let jobs: Vec<_> = systemctl_calls(&manager)
        .into_iter()
        .filter(|args| args.iter().any(|arg| arg == "start" || arg == "stop"))
        .collect();
    // Only the backend is started; it starts the Rust unit under a fresh P4 reservation.
    assert_eq!(jobs, vec![args(&["start", &names.backend])]);
    // Loaded, unchanged units are not reloaded: a reload would reset the crash-loop limit.
    assert!(!reloaded(&manager));
    assert!(
        manager.calls.borrow()[0].0.ends_with("bigbud-remote-agent"),
        "the verified artifact identity is checked before any manager call"
    );
    assert_eq!(observed[0].0, names.backend);
    assert_eq!(observed[0].1.state, ServiceState::Active);
}

#[test]
fn stop_reports_success_and_preserves_data() {
    let fixture = Fixture::new();
    staged(&fixture);
    // A changed artifact blocks start but never blocks stopping already-running work.
    write(&fixture.config.rust_binary, b"replaced", 0o700);
    let manager = manager(&fixture, "inactive");
    let observed = run(
        &fixture.config,
        Explicit::Stop,
        &manager,
        Prerequisites::Ready,
    )
    .unwrap()
    .observed;
    assert_boot_policy_untouched(&manager);
    let names = UnitNames::new(&fixture.config);
    let jobs: Vec<_> = systemctl_calls(&manager)
        .into_iter()
        .filter(|args| args.iter().any(|arg| arg == "start" || arg == "stop"))
        .collect();
    assert_eq!(jobs, vec![args(&["stop", &names.backend, &names.rust])]);
    assert!(
        observed
            .iter()
            .all(|(_, status)| status.state == ServiceState::Disabled)
    );
    for path in [
        fixture.config.config_path(),
        fixture.config.token_path(),
        fixture.config.backend_home.join("state"),
        fixture.config.rust_state.clone(),
        unit_directory(&fixture.config).join(&names.backend),
        unit_directory(&fixture.config).join(&names.rust),
    ] {
        assert!(path.exists(), "{} must be preserved", path.display());
    }
    assert!(
        run(
            &fixture.config,
            Explicit::Start,
            &manager,
            Prerequisites::Ready
        )
        .is_err(),
        "start keeps strict artifact pins"
    );
}

#[test]
fn start_and_stop_refuse_when_units_are_not_staged() {
    let fixture = Fixture::new();
    for operation in [Explicit::Start, Explicit::Stop] {
        let manager = manager(&fixture, "inactive");
        let error = run(&fixture.config, operation, &manager, Prerequisites::Ready).unwrap_err();
        assert!(error.to_string().contains("not staged"), "{error}");
        assert!(manager.calls.borrow().is_empty());
    }
}

#[test]
fn refuses_missing_manager_foreign_fragment_consent_and_unsettled_jobs() {
    let fixture = Fixture::new();
    staged(&fixture);
    for readiness in [
        Prerequisites::Unsupported,
        Prerequisites::MissingUserManager,
        Prerequisites::UnsupportedManagerVersion,
    ] {
        let manager = manager(&fixture, "active");
        assert!(run(&fixture.config, Explicit::Start, &manager, readiness).is_err());
        assert!(manager.calls.borrow().is_empty());
    }
    let foreign = FakeManager {
        fragment_dir: Some(fixture.root.join("elsewhere")),
        unit_active: Some("active"),
        ..Default::default()
    };
    assert!(
        run(
            &fixture.config,
            Explicit::Stop,
            &foreign,
            Prerequisites::Ready
        )
        .is_err()
    );
    assert!(
        systemctl_calls(&foreign)
            .iter()
            .all(|args| !args.iter().any(|arg| arg == "stop"))
    );
    let manager = manager(&fixture, "active");
    assert!(
        report(
            &fixture.config,
            Explicit::Start,
            true,
            &manager,
            Prerequisites::Ready,
            1000
        )
        .is_err()
    );
    assert!(manager.calls.borrow().is_empty());
    // A stop that leaves a unit active, or a failed job, is reported as a failure.
    assert!(matches!(
        run(
            &fixture.config,
            Explicit::Stop,
            &manager,
            Prerequisites::Ready
        ),
        Err(ServiceError::Manager)
    ));
    let failing = FakeManager {
        fail_jobs: true,
        ..self::manager(&fixture, "inactive")
    };
    assert!(
        run(
            &fixture.config,
            Explicit::Start,
            &failing,
            Prerequisites::Ready
        )
        .is_err()
    );
    let starting_failed = FakeManager {
        fragment_dir: Some(unit_directory(&fixture.config)),
        unit_active: Some("failed"),
        ..Default::default()
    };
    assert!(matches!(
        run(
            &fixture.config,
            Explicit::Start,
            &starting_failed,
            Prerequisites::Ready
        ),
        Err(ServiceError::Invalid(_))
    ));
    let started_then_failed = FakeManager {
        active_after_job: Some("failed"),
        ..self::manager(&fixture, "inactive")
    };
    assert!(matches!(
        run(
            &fixture.config,
            Explicit::Start,
            &started_then_failed,
            Prerequisites::Ready
        ),
        Err(ServiceError::Manager)
    ));
}

fn reloaded(manager: &FakeManager) -> bool {
    systemctl_calls(manager)
        .iter()
        .any(|args| args.iter().any(|arg| arg == "daemon-reload"))
}
fn jobs(manager: &FakeManager) -> usize {
    systemctl_calls(manager)
        .iter()
        .filter(|args| args.iter().any(|arg| arg == "start" || arg == "stop"))
        .count()
}

#[test]
fn start_refuses_units_that_need_repair_without_reloading_their_start_limit() {
    let fixture = Fixture::new();
    staged(&fixture);
    for (active, result) in [("failed", "exit-code"), ("inactive", "start-limit-hit")] {
        let manager = FakeManager {
            unit_result: Some(result),
            need_reload: true,
            ..manager(&fixture, active)
        };
        let error = run(
            &fixture.config,
            Explicit::Start,
            &manager,
            Prerequisites::Ready,
        )
        .unwrap_err();
        assert!(error.to_string().contains("needs repair"), "{error}");
        assert!(!reloaded(&manager), "a reload would reset the start limit");
        assert_eq!(jobs(&manager), 0);
    }
}

#[test]
fn start_is_idempotent_while_running_and_reloads_only_changed_units() {
    let fixture = Fixture::new();
    staged(&fixture);
    let running = manager(&fixture, "active");
    let outcome = run(
        &fixture.config,
        Explicit::Start,
        &running,
        Prerequisites::Ready,
    )
    .unwrap();
    assert!(outcome.already_running);
    assert_eq!(jobs(&running), 0);
    assert!(!reloaded(&running));
    let changed = FakeManager {
        need_reload: true,
        active_after_job: Some("active"),
        ..manager(&fixture, "inactive")
    };
    assert!(
        !run(
            &fixture.config,
            Explicit::Start,
            &changed,
            Prerequisites::Ready
        )
        .unwrap()
        .already_running
    );
    assert!(reloaded(&changed));
    assert_eq!(jobs(&changed), 1);
}

#[test]
fn cli_accepts_start_and_stop_but_rejects_unexpected_arguments() {
    for operation in ["start", "stop"] {
        assert!(
            run_cli_rejects([operation, "/unused", "--force"]),
            "{operation} must reject unknown flags"
        );
    }
}
fn run_cli_rejects(arguments: [&str; 3]) -> bool {
    crate::backend_service::run_cli(arguments.into_iter().map(str::to_owned)).is_err()
}
