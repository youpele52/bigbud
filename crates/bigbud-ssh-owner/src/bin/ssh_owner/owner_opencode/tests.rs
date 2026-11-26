//! Shared lease plumbing: private forward socket, nonce-framed receipts and
//! confirmed settlement. Moved from the retired OpenCode v1 recipe tests.
use super::*;
use crate::v1::ErrorCode;
use std::{
    fs,
    os::unix::{fs::PermissionsExt, net::UnixListener},
};

const NONCE: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

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
    let mut control = Control::new("bigbud-opencode-v2", NONCE);
    control.ingest(format!("prefix bigbud-opencode-v2 {NONCE} prepared\n").as_bytes());
    control.ingest(format!("bigbud-opencode-v2 {} prepared\n", "f".repeat(64)).as_bytes());
    assert!(!control.prepared());
    control.ingest(&[b'X'; 2_000]);
    let prepared = format!("\nbigbud-opencode-v2 {NONCE} prepared\n");
    for chunk in prepared.as_bytes().chunks(3) {
        control.ingest(chunk);
    }
    assert!(control.prepared());
    let actual = format!("bigbud-opencode-v2 {NONCE} exit 7\n");
    control.ingest(actual.as_bytes());
    assert_eq!(control.terminal(), None);
    control.note_launch();
    control.ingest(format!("bigbud-opencode-v2 {NONCE} exit 007\n").as_bytes());
    control.ingest(format!("bigbud-opencode-v2 {NONCE} exit 256\n").as_bytes());
    assert_eq!(control.terminal(), None);
    control.ingest(actual.as_bytes());
    assert_eq!(control.terminal().and_then(Receipt::exit_code), Some(7));
    control.ingest(format!("bigbud-opencode-v2 {NONCE} reaped\n").as_bytes());
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
