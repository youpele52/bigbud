#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::backend_service::tests::fixture::{FakeManager, Fixture, mode};
use std::{cell::RefCell, process::Command};
const CAP: &str =
    r#"{"schemaVersion":1,"backendVersion":"0.1.0-fixture","accountServicePreflight":1}"#;
struct Activation<'a> {
    system: FakeManager,
    probe: &'a str,
    fail_finite: bool,
    after_finite: Option<&'a dyn Fn()>,
    owned_calls: RefCell<Vec<String>>,
}
impl<'a> Activation<'a> {
    fn new(fixture: &Fixture) -> Self {
        Self {
            system: FakeManager {
                fragment: Some(
                    unit_directory(&fixture.config)
                        .join(render_definition(&fixture.config).unwrap().names.backend),
                ),
                ..Default::default()
            },
            probe: CAP,
            fail_finite: false,
            after_finite: None,
            owned_calls: RefCell::new(Vec::new()),
        }
    }
}
impl Manager for Activation<'_> {
    fn run(&self, program: &str, args: &[String]) -> Result<String> {
        self.system.run(program, args)
    }
    #[allow(clippy::panic_in_result_fn)] // Test double asserts the exact subprocess boundary.
    fn run_owned(&self, command: Command, deadline: Duration) -> Result<String> {
        let arguments = command.get_args().collect::<Vec<_>>();
        let env = command.get_envs().collect::<Vec<_>>();
        assert!(
            arguments
                .iter()
                .all(|value| !value.to_string_lossy().contains("fixture-secret"))
        );
        if arguments.len() == 2 {
            assert_eq!(arguments.last().unwrap(), &"--remote-service-capabilities");
            assert_eq!(deadline, Duration::from_secs(10));
            assert!(
                env.iter()
                    .all(|(key, _)| !key.to_string_lossy().starts_with("BIGBUD_")
                        && !key.to_string_lossy().starts_with("T3CODE_"))
            );
            self.owned_calls.borrow_mut().push("capability".into());
            return Ok(self.probe.into());
        }
        assert_eq!(arguments.len(), 1, "finite marker and token are env-only");
        assert_eq!(deadline, Duration::from_secs(120));
        for (key, value) in [
            ("BIGBUD_REMOTE_SERVICE_PREFLIGHT_ONLY", "1"),
            ("BIGBUD_MODE", "remote"),
            ("BIGBUD_NO_BROWSER", "true"),
            ("BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD", "false"),
        ] {
            assert!(
                env.iter()
                    .any(|(name, text)| name == &key && text == &Some(std::ffi::OsStr::new(value)))
            );
        }
        assert!(
            env.iter()
                .any(|(key, value)| key == &"BIGBUD_AUTH_TOKEN" && value.is_some())
        );
        assert!(
            env.iter()
                .any(|(key, value)| key == &"BIGBUD_REMOTE_SERVICE_CONFIG" && value.is_some())
        );
        self.owned_calls.borrow_mut().push("finite".into());
        if let Some(change) = self.after_finite {
            change();
        }
        if self.fail_finite {
            Err(ServiceError::Manager)
        } else {
            Ok(String::new())
        }
    }
}
fn staged(fixture: &Fixture) {
    let manager = FakeManager::default();
    crate::backend_service::cli::apply(
        &fixture.config,
        "stage",
        true,
        &manager,
        Prerequisites::Ready,
    )
    .unwrap();
}
fn changes(manager: &Activation<'_>) -> Vec<String> {
    manager
        .system
        .calls
        .borrow()
        .iter()
        .filter(|(program, _)| program == "/usr/bin/systemctl")
        .flat_map(|(_, args)| {
            args.iter()
                .filter(|arg| {
                    matches!(
                        arg.as_str(),
                        "enable" | "start" | "stop" | "disable" | "daemon-reload"
                    )
                })
                .cloned()
        })
        .collect()
}
#[test]
fn capability_shape_version_and_types_are_exact_and_bounded() {
    capability(CAP).unwrap();
    capability(
        r#"{ "backendVersion":"1.2.3+build", "accountServicePreflight":1, "schemaVersion":1 }"#,
    )
    .unwrap();
    for value in [
        "",
        "{}",
        r#"{"schemaVersion":1,"backendVersion":"1","accountServicePreflight":true}"#,
        r#"{"schemaVersion":2,"backendVersion":"1","accountServicePreflight":1}"#,
        r#"{"schemaVersion":1,"backendVersion":1,"accountServicePreflight":1}"#,
        r#"{"schemaVersion":1,"backendVersion":"","accountServicePreflight":1}"#,
        r#"{"schemaVersion":1,"backendVersion":"1","accountServicePreflight":1,"extra":1}"#,
        r#"{"schemaVersion":1,"schemaVersion":1,"backendVersion":"1","accountServicePreflight":1}"#,
    ] {
        assert!(capability(value).is_err());
    }
    assert!(capability(&CAP.replace("0.1.0-fixture", &"a".repeat(129))).is_err());
}
#[test]
fn only_backend_is_enabled_after_both_owned_checks_and_exact_loaded_fragment() {
    let fixture = Fixture::new();
    staged(&fixture);
    let manager = Activation::new(&fixture);
    enable(&fixture.config, &manager, Prerequisites::Ready).unwrap();
    assert_eq!(*manager.owned_calls.borrow(), ["capability", "finite"]);
    assert_eq!(changes(&manager), ["daemon-reload", "enable", "start"]);
    let names = render_definition(&fixture.config).unwrap().names;
    let calls = manager.system.calls.borrow();
    for (_, args) in calls
        .iter()
        .filter(|(_, args)| args.iter().any(|arg| arg == "enable" || arg == "start"))
    {
        assert_eq!(args.last(), Some(&names.backend));
        assert!(!args.contains(&names.rust));
    }
}
#[test]
fn old_backend_finite_failure_or_missing_prerequisite_cannot_change_boot_policy() {
    for (probe, fail, ready) in [
        ("old backend", false, Prerequisites::Ready),
        (CAP, true, Prerequisites::Ready),
        (CAP, false, Prerequisites::MissingLinger),
    ] {
        let fixture = Fixture::new();
        staged(&fixture);
        let mut manager = Activation::new(&fixture);
        manager.probe = probe;
        manager.fail_finite = fail;
        assert!(enable(&fixture.config, &manager, ready).is_err());
        assert!(changes(&manager).is_empty());
        if probe != "old backend" && ready == Prerequisites::Ready {
            assert_eq!(*manager.owned_calls.borrow(), ["capability", "finite"]);
        }
        if probe == "old backend" {
            assert_eq!(*manager.owned_calls.borrow(), ["capability"]);
        }
    }
}
#[test]
fn changed_credential_permission_or_artifact_after_finite_cannot_enable() {
    for artifact in [false, true] {
        let fixture = Fixture::new();
        staged(&fixture);
        let mutate = || {
            if artifact {
                std::fs::write(&fixture.config.backend_entry, b"changed").unwrap();
            } else {
                mode(&fixture.config.token_path(), 0o644);
            }
        };
        let mut manager = Activation::new(&fixture);
        manager.after_finite = Some(&mutate);
        assert!(enable(&fixture.config, &manager, Prerequisites::Ready).is_err());
        assert!(changes(&manager).is_empty());
    }
}
#[test]
fn wrong_loaded_fragment_never_enables_or_stops_an_existing_service() {
    let fixture = Fixture::new();
    staged(&fixture);
    let mut manager = Activation::new(&fixture);
    manager.system.fragment = Some(fixture.root.join("foreign.service"));
    assert!(enable(&fixture.config, &manager, Prerequisites::Ready).is_err());
    assert_eq!(changes(&manager), ["daemon-reload"]);
}

#[test]
fn valid_but_rebound_backend_graph_after_probe_is_refused() {
    use sha2::{Digest, Sha256};
    let fixture = Fixture::new();
    staged(&fixture);
    let mutate = || {
        let replacement = b"new but independently pinned node bytes";
        std::fs::write(&fixture.config.node_binary, replacement).unwrap();
        let digest = format!("{:x}", Sha256::digest(replacement));
        let receipt = std::fs::read_to_string(fixture.config.receipt_path())
            .unwrap()
            .lines()
            .map(|line| {
                if line.ends_with("\t700\tnode") {
                    format!("file={digest}\t{}\t700\tnode", replacement.len())
                } else {
                    line.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(fixture.config.receipt_path(), &receipt).unwrap();
        let receipt_sha = format!("{:x}", Sha256::digest(receipt.as_bytes()));
        let text = fixture
            .text()
            .replace(
                &format!("node_sha256={}", fixture.config.node_sha256),
                &format!("node_sha256={digest}"),
            )
            .replace(
                &format!("receipt_sha256={}", fixture.config.receipt_sha256),
                &format!("receipt_sha256={receipt_sha}"),
            );
        std::fs::write(fixture.config.config_path(), text).unwrap();
        ServiceConfig::load(&fixture.config.config_path()).unwrap();
    };
    let mut manager = Activation::new(&fixture);
    manager.after_finite = Some(&mutate);
    assert!(enable(&fixture.config, &manager, Prerequisites::Ready).is_err());
    assert!(changes(&manager).is_empty());
}

#[test]
fn finite_p4_projection_changes_are_reloaded_without_rebinding_artifacts() {
    let fixture = Fixture::new();
    staged(&fixture);
    let mutate = || {
        let text = fixture.text().replace(
            &format!("launch_attempt={}", fixture.config.launch_attempt),
            "launch_attempt=finite-reconciled-attempt",
        );
        std::fs::write(fixture.config.config_path(), text).unwrap();
    };
    let mut manager = Activation::new(&fixture);
    manager.after_finite = Some(&mutate);
    enable(&fixture.config, &manager, Prerequisites::Ready).unwrap();
    assert_eq!(changes(&manager), ["daemon-reload", "enable", "start"]);
}
