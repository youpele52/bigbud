//! Proves managed Start waits for the original mobile gateway bind.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]
use bigbud_remote_agent::service_lease::{
    Binding, Controller, Launch, LeaseOwner, SecretEnvironment, State,
};
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

#[test]
#[ignore = "requires a separately built bigbud-mobile-gateway executable"]
fn start_acknowledges_only_after_original_gateway_binds_loopback() {
    let root =
        std::env::temp_dir().join(format!("bigbud-gateway-readiness-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let executable = root.join("gateway");
    std::fs::copy(
        std::env::var_os("BIGBUD_MOBILE_GATEWAY_TEST_BINARY").unwrap(),
        &executable,
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let digest = Sha256::digest(std::fs::read(&executable).unwrap()).into();
    let monitor = PathBuf::from(std::env::var_os("BIGBUD_SERVICE_LEASE_TEST_BINARY").unwrap());
    let mut owner = LeaseOwner::with_monitor(monitor, "readiness-test-epoch".into()).unwrap();
    let binding = Binding {
        authority: "a".repeat(32),
        installation: format!("sha256:{}", "b".repeat(64)),
        native_epoch: "readiness-test-epoch".into(),
        nonce: format!("gateway-readiness-{}", std::process::id()),
        publication_sha256: [1; 32],
        executable_sha256: digest,
        assets_sha256: [2; 32],
        configuration_sha256: [3; 32],
        guard_sha256: [0; 32],
    };
    let grant = owner
        .start(
            binding.clone(),
            Controller::current().unwrap(),
            &[7; 32],
            Launch {
                executable,
                args: vec![
                    "--listen".into(),
                    "127.0.0.1:0".into(),
                    "--upstream".into(),
                    "127.0.0.1:9".into(),
                    "--external-origin".into(),
                    "https://desk.ts.net".into(),
                    "--stdin-lifeline".into(),
                ],
                environment: SecretEnvironment(vec![(
                    "BIGBUD_MOBILE_GATEWAY_UPSTREAM_CREDENTIAL".into(),
                    "c".repeat(32),
                )]),
                guard: None,
                assets: None,
            },
        )
        .unwrap();
    assert_eq!(grant.snapshot.state, State::Spawned);
    assert!(grant.snapshot.original_child_pid > 1);
    assert_eq!(
        owner
            .revoke(
                &binding,
                &[7; 32],
                &Controller::current().unwrap(),
                grant.generation(),
            )
            .unwrap()
            .state,
        State::Exited
    );
    std::fs::remove_dir_all(root).unwrap();
}
