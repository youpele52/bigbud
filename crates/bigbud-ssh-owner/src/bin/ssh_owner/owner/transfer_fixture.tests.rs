use std::{
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use super::stream::StreamFixture;
use super::*;
use crate::v1::{self, ProofTransferOperands, ProofTransferScope};

pub(super) struct FixtureDirectory(PathBuf);

impl FixtureDirectory {
    pub(super) fn new() -> Self {
        let token = crate::random_token().expect("fixture nonce");
        let name = format!("bigbud-transfer-fixture-{:x}", Sha256::digest(token));
        let path = std::env::temp_dir()
            .canonicalize()
            .expect("canonical temp directory")
            .join(name);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .expect("private fixture directory");
        Self(path)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }

    pub(super) fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    pub(super) fn executable(&self, name: &str, script: &str) -> PathBuf {
        let path = self.join(name);
        fs::write(&path, script).expect("fixture file");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("private executable");
        path
    }
}

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn scope(auth_mode: i32) -> ProofTransferScope {
    ProofTransferScope {
        transfer_id: vec![0x11; TRANSFER_ID_BYTES],
        target_id: "fixture-target".into(),
        target_generation: vec![4],
        auth_mode,
    }
}

pub(super) fn grant(verb: TransferVerb, auth_mode: i32) -> TransferGrant {
    TransferGrant::issue("fixture-target", &[4], verb, &scope(auth_mode)).expect("transfer grant")
}

pub(super) fn operands(max_bytes: u64) -> TransferOperands {
    validate_operands(&ProofTransferOperands {
        source: "fixture/source".into(),
        destination: "fixture/destination".into(),
        max_bytes,
        max_entries: 8,
    })
    .expect("bounded operands")
}

pub(super) fn no_launch() -> LaunchAttempt {
    LaunchAttempt::default()
}

#[test]
fn transfer_fixture_stream_is_a_scoped_duplex_with_credits_and_half_close() {
    let mut stream =
        StreamFixture::open(grant(TransferVerb::Stream, 2), &operands(64), &no_launch())
            .expect("scoped stream");
    assert!(stream.protected().expect("descriptor flags"));
    assert_eq!(stream.send(b"no-credit"), Err(ErrorCode::InvalidOperands));
    assert_eq!(
        stream.grant_credit(MAX_CREDITS + 1),
        Err(ErrorCode::InvalidOperands)
    );
    assert_eq!(stream.grant_credit(16), Ok(16));
    let payload = b"fixture-duplex!!";
    assert_eq!(stream.send(payload), Ok(()));
    assert_eq!(stream.receive(), Ok(Some(payload.to_vec())));
    assert_eq!(stream.half_close(), Ok(()));
    // Half-close is write-only: no further send, reads still drain.
    assert_eq!(stream.send(b"x"), Err(ErrorCode::OperationDenied));
    assert!(stream.state().write_closed);
    // The native peer observes the write shutdown and closes its own side.
    assert_eq!(stream.receive(), Ok(None));
    assert!(stream.peer_eof());
    let exit = stream.finish().expect("peer exit");
    assert_eq!(exit.code, Some(0));
    assert!(!exit.cancelled);
    assert!(stream.state().exited);
    assert!(stream.exit().is_ok());
    // The explicit exit is reported exactly once.
    assert_eq!(stream.exit(), Err(ErrorCode::OperationDenied));
    assert_eq!(stream.transfer_id().len(), TRANSFER_ID_BYTES);
    assert_eq!(stream.lease().len(), TRANSFER_ID_BYTES);
}

#[test]
fn transfer_fixture_stream_bounds_bytes_without_writing() {
    let mut stream =
        StreamFixture::open(grant(TransferVerb::Stream, 2), &operands(4), &no_launch())
            .expect("scoped stream");
    // An attacker-sized credit cannot overflow the window.
    assert_eq!(
        stream.grant_credit(u64::MAX),
        Err(ErrorCode::InvalidOperands)
    );
    assert_eq!(stream.grant_credit(8), Ok(8));
    assert_eq!(stream.send(b"12345"), Err(ErrorCode::InvalidOperands));
    assert_eq!(stream.state().sent, 0);
    assert_eq!(stream.send(b"1234"), Ok(()));
    assert_eq!(stream.receive(), Ok(Some(b"1234".to_vec())));
    // The operand byte ceiling is already reached.
    assert_eq!(stream.send(b"5"), Err(ErrorCode::InvalidOperands));
    assert_eq!(stream.state().sent, 4);
}

#[test]
fn transfer_fixture_stream_cancels_by_exact_lease_and_never_replays() {
    let mut stream =
        StreamFixture::open(grant(TransferVerb::Stream, 2), &operands(64), &no_launch())
            .expect("scoped stream");
    let lease = stream.lease().to_vec();
    assert_eq!(stream.cancel(&[0; 32]), Err(ErrorCode::OperationDenied));
    assert_eq!(stream.cancel(&lease), Ok(()));
    assert!(stream.state().cancelled);
    // A settled lease is terminal: no second cancel and no replay.
    assert_eq!(stream.cancel(&lease), Err(ErrorCode::OperationDenied));
    let exit = stream.exit().expect("cancelled exit");
    assert!(exit.cancelled);
    assert_eq!(exit.signal, Some(libc::SIGKILL));
    assert_eq!(stream.exit(), Err(ErrorCode::OperationDenied));
}

#[test]
fn transfer_fixture_stream_unknown_outcome_is_terminal() {
    let mut stream =
        StreamFixture::open(grant(TransferVerb::Stream, 2), &operands(64), &no_launch())
            .expect("scoped stream");
    let lease = stream.lease().to_vec();
    stream.mark_transport_lost();
    assert_eq!(stream.exit(), Err(ErrorCode::OutcomeUnknown));
    assert_eq!(stream.finish(), Err(ErrorCode::OperationDenied));
    assert_eq!(stream.cancel(&lease), Err(ErrorCode::OperationDenied));
}

#[test]
fn transfer_fixture_stream_never_relays_content_through_control() {
    use prost::Message;

    let sentinel = b"bigbud-transfer-sentinel-0123456789";
    let mut stream =
        StreamFixture::open(grant(TransferVerb::Stream, 2), &operands(128), &no_launch())
            .expect("scoped stream");
    stream.grant_credit(64).expect("credit");
    stream.send(sentinel).expect("send");
    assert_eq!(stream.receive(), Ok(Some(sentinel.to_vec())));
    // Every control frame the worker may send, and the observed state, is
    // counters only: the content stayed on the native socket pair.
    let controls = [
        stream
            .control(v1::proof_transfer_stream_control::Action::GrantCredit(64))
            .encode_to_vec(),
        stream
            .control(v1::proof_transfer_stream_control::Action::HalfClose(true))
            .encode_to_vec(),
        stream
            .control(v1::proof_transfer_stream_control::Action::Cancel(true))
            .encode_to_vec(),
        stream.state().encode_to_vec(),
    ];
    for control in controls {
        assert!(
            !control
                .windows(sentinel.len())
                .any(|window| window == sentinel),
            "content bytes reached the control channel"
        );
    }
}

#[path = "transfer_fixture.tests.child.rs"]
mod child_tests;

#[path = "transfer_fixture.tests.grant.rs"]
mod grant_tests;
