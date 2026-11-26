use super::*;
use std::os::unix::process::ExitStatusExt;
use std::process::ExitStatus;

fn output(exit: i32, stderr: &str) -> process::Output {
    process::Output {
        status: ExitStatus::from_raw(exit << 8),
        stdout: Vec::new(),
        stderr: stderr.as_bytes().to_vec(),
        truncated: false,
    }
}

#[test]
fn reports_success_and_explicit_connection_failure_for_the_probed_endpoint() {
    let decode = |exit, stderr: &str| super::decode(output(exit, stderr), "127.0.0.1", 2222);
    assert_eq!(decode(0, ""), Ok(v1::ProofHealth { reachable: true }));
    let refused = "ssh: connect to host 127.0.0.1 port 2222: Connection refused\n";
    assert_eq!(
        decode(255, refused),
        Ok(v1::ProofHealth { reachable: false })
    );
    assert_eq!(
        decode(255, &refused.replace("2222", "2223")),
        Err(ErrorCode::TransportLost)
    );
    assert_eq!(decode(1, refused), Err(ErrorCode::OwnerUnavailable));
    assert_eq!(
        decode(255, "unknown failure"),
        Err(ErrorCode::TransportLost)
    );
}

#[test]
fn rejects_trust_auth_config_and_excess_output_as_unavailable() {
    let decode = |output| super::decode(output, "127.0.0.1", 2222);
    for (stderr, error) in [
        ("Host key verification failed.", ErrorCode::HostKeyChanged),
        ("no matching host key type found", ErrorCode::HostKeyChanged),
        (
            "fixture@127.0.0.1: Permission denied (publickey).",
            ErrorCode::AuthRequired,
        ),
        (
            "Warning: Identity file /fixture/id not accessible: No such file or directory.",
            ErrorCode::AuthRequired,
        ),
        (
            "Load key \"/fixture/id\": invalid format",
            ErrorCode::AuthRequired,
        ),
        (
            "command-line: line 0: Bad configuration option: bad",
            ErrorCode::ConfigUnsupported,
        ),
    ] {
        assert_eq!(decode(output(255, stderr)), Err(error));
    }
    let mut oversized = output(0, &"x".repeat(CAPTURE_LIMIT));
    oversized.stdout.push(b'x');
    assert_eq!(decode(oversized), Err(ErrorCode::OwnerUnavailable));
    let mut truncated = output(0, "");
    truncated.truncated = true;
    assert_eq!(decode(truncated), Err(ErrorCode::OwnerUnavailable));
}

#[cfg(target_os = "macos")]
#[test]
fn cancellable_health_prechecks_before_pin_preparation() {
    use crate::transport::{TransportConfig, write_identity_fixture};
    use std::fs::{self, DirBuilder};
    use std::net::Ipv4Addr;
    use std::os::unix::fs::DirBuilderExt;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _removed = fs::remove_dir_all(&self.0);
        }
    }

    let path = std::env::temp_dir()
        .canonicalize()
        .expect("fixture parent")
        .join(format!("bb-health-cancel-{}", std::process::id()));
    DirBuilder::new()
        .mode(0o700)
        .create(&path)
        .expect("fixture directory");
    let fixture = Fixture(path);
    let transport = Transport::new(TransportConfig {
        ssh: fixture.0.join("must-not-spawn"),
        keyscan: fixture.0.join("must-not-scan"),
        host: Ipv4Addr::LOCALHOST.into(),
        port: 2222,
        user: "fixture".into(),
        identity: write_identity_fixture(&fixture.0),
        known_hosts: fixture.0.join("known_hosts"),
        alias_config: None,
        system_config: None,
        workspace_root: None,
        dev_interactive_terminal: false,
        host_identity: Default::default(),
    })
    .expect("valid test transport");
    assert_eq!(
        transport.sample_health_cancellable(|| true),
        Err(ErrorCode::HealthCancelled)
    );
    assert_eq!(
        transport.sample_health_cancellable(|| false),
        Err(ErrorCode::TrustRequired)
    );
}

#[cfg(target_os = "macos")]
#[test]
fn cancellable_health_maps_confirmed_and_unconfirmed_cleanup_distinctly() {
    use process::{Failure, PickerFailure};
    for (failure, expected) in [
        (PickerFailure::Cancelled, ErrorCode::HealthCancelled),
        (PickerFailure::CleanupUnconfirmed, ErrorCode::OutcomeUnknown),
        (
            PickerFailure::Process(Failure::TimedOut),
            ErrorCode::TransportLost,
        ),
        (
            PickerFailure::Process(Failure::Spawn),
            ErrorCode::OwnerUnavailable,
        ),
        (
            PickerFailure::Process(Failure::Io),
            ErrorCode::OwnerUnavailable,
        ),
    ] {
        assert_eq!(cancellable_failure(failure), expected);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn cancellable_health_preserves_the_combined_capture_budget() {
    use std::process::Command;
    let mut command = Command::new("/bin/sh");
    // Both pipes are individually below the limit but together exceed it.
    command.args(["-c", "printf '%03072d' 0; printf '%03072d' 0 >&2"]);
    let output = process::run_with_combined_output_limit_cancellable(
        command,
        Instant::now() + TIMEOUT,
        CAPTURE_LIMIT,
        || false,
    )
    .map_err(cancellable_failure)
    .expect("local capture fixture completes");
    assert_eq!(output.stdout.len() + output.stderr.len(), CAPTURE_LIMIT);
    assert!(output.truncated);
    assert_eq!(
        decode(output, "127.0.0.1", 2222),
        Err(ErrorCode::OwnerUnavailable)
    );
}
