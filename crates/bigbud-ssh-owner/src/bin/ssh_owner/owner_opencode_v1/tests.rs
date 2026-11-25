use super::*;
use crate::v1::ErrorCode;
use std::{
    fs,
    os::unix::{fs::PermissionsExt, net::UnixListener},
};

const NONCE: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

fn scope() -> ProofProviderScope {
    ProofProviderScope {
        thread_id: "thread".into(),
        session_epoch: 8,
        cwd: "/tmp/bigbud-opencode-v1-AbC/work".into(),
        binary: "/tmp/bigbud-opencode-v1-AbC/bin/opencode'v1".into(),
        session_file: None,
    }
}

#[test]
fn admission_binds_all_scope_operands_and_rejects_non_fixture_paths() {
    let scope = scope();
    let recipe = Recipe::new(scope.clone(), "a".repeat(64)).expect("approved fixture");
    assert!(recipe.matches(&scope));
    for changed in [
        ProofProviderScope {
            cwd: format!("{}2", scope.cwd),
            ..scope.clone()
        },
        ProofProviderScope {
            binary: format!("{}2", scope.binary),
            ..scope.clone()
        },
        ProofProviderScope {
            thread_id: "different".into(),
            ..scope.clone()
        },
        ProofProviderScope {
            session_epoch: 9,
            ..scope.clone()
        },
    ] {
        assert!(!recipe.matches(&changed));
    }
    for cwd in [
        "/tmp/bigbud-opencode-v1-AbD/work",
        "/tmp/bigbud-opencode-v1-AbC/../work",
        "/tmp/bigbud-opencode-v1-AbC//work",
        "/tmp/bigbud-opencode-v1-AbC/work\n",
        "/tmp/bigbud-opencode-v1-AbC",
        "/tmp/bigbud-opencode-v1-/work",
        "/home/user/work",
    ] {
        assert!(
            Recipe::new(
                ProofProviderScope {
                    cwd: cwd.into(),
                    ..scope.clone()
                },
                "a".repeat(64)
            )
            .is_err()
        );
    }
    assert!(Recipe::new(scope, "A".repeat(64)).is_err());
    let command = recipe.remote_command(NONCE);
    assert!(command.contains("/bin/bash -o pipefail"));
    assert!(command.contains("'/tmp/bigbud-opencode-v1-AbC/bin/opencode'\\''v1'"));
    assert!(command.contains(" 127.0.0.1 4096 "));
    assert!(
        command.contains(
            "['/proc/self/fd/9', 'serve', '--hostname', host, '--port', port]"
                .replace('\'', "'\\''")
                .as_str()
        )
    );
}

#[test]
fn private_forward_directory_is_unique_and_removed_without_a_rebind_window() {
    let first = ForwardSocket::new().expect("private directory");
    let second = ForwardSocket::new().expect("second private directory");
    assert_ne!(first.path(), second.path());
    let directory = first.path().parent().expect("private parent").to_owned();
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(!first.path().exists());
    let listener = UnixListener::bind(first.path()).expect("bind private path");
    drop(listener);
    first.close().expect("remove socket and parent");
    assert!(!directory.exists());
    second.close().expect("remove unused parent");
}

#[test]
fn receipt_requires_exact_nonce_framing_and_owner_launch_signal() {
    let mut control = Control::new("bigbud-opencode-v1", NONCE);
    control.ingest(format!("prefix bigbud-opencode-v1 {NONCE} prepared\n").as_bytes());
    control.ingest(format!("bigbud-opencode-v1 {} prepared\n", "f".repeat(64)).as_bytes());
    assert!(!control.prepared());
    control.ingest(&[b'X'; 2_000]);
    let prepared = format!("\nbigbud-opencode-v1 {NONCE} prepared\n");
    for chunk in prepared.as_bytes().chunks(3) {
        control.ingest(chunk);
    }
    assert!(control.prepared());
    let actual = format!("bigbud-opencode-v1 {NONCE} exit 7\n");
    control.ingest(actual.as_bytes());
    assert_eq!(control.terminal(), None);
    control.note_launch();
    control.ingest(format!("bigbud-opencode-v1 {NONCE} exit 007\n").as_bytes());
    control.ingest(format!("bigbud-opencode-v1 {NONCE} exit 256\n").as_bytes());
    assert_eq!(control.terminal(), None);
    control.ingest(actual.as_bytes());
    assert_eq!(control.terminal().and_then(Receipt::exit_code), Some(7));
    control.ingest(format!("bigbud-opencode-v1 {NONCE} reaped\n").as_bytes());
    assert_eq!(control.terminal(), Some(Receipt::Exit(7)));
    assert_eq!(Receipt::Exit(-9).exit_code(), None);
    assert_eq!(Receipt::Reaped.exit_code(), None);
}

#[test]
fn cancellation_and_real_exit_cannot_be_inferred_from_transport_reap() {
    assert_eq!(
        settle(Outcome::Cancelled, false, false, None),
        Outcome::Cancelled
    );
    assert_eq!(
        settle(Outcome::Cancelled, true, true, None),
        Outcome::Unconfirmed
    );
    assert_eq!(
        settle(Outcome::Cancelled, true, true, Some(Receipt::Reaped)),
        Outcome::Cancelled
    );
    assert_eq!(settle(Outcome::Lost, true, true, None), Outcome::Lost);
    assert_eq!(
        settle(Outcome::Lost, true, true, Some(Receipt::Exit(7))),
        Outcome::Exited(7)
    );
    assert_eq!(
        settle(Outcome::Lost, true, true, Some(Receipt::Exit(-9))),
        Outcome::Lost
    );
    let refused = Outcome::Rejected(ErrorCode::TransportLost);
    assert_eq!(
        settle(refused, true, false, Some(Receipt::Exit(7))),
        refused
    );
    assert_eq!(
        settle(Outcome::Unconfirmed, true, true, Some(Receipt::Reaped)),
        Outcome::Unconfirmed
    );
}
