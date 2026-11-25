use super::{
    MAX_ARTIFACT_BYTES, Operations, artifact_operand, failure_is_unknown, mutates,
    mutating_outcome_unknown, safe_label, valid_sha256, validate_operation_id,
};
use crate::v1::{AgentAction, AgentActionKind, AgentActionResult, ErrorCode};
use sha2::{Digest, Sha256};

fn sha(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

fn install_operand(bytes: &[u8]) -> AgentAction {
    AgentAction {
        action: AgentActionKind::Install as i32,
        operation_id: vec![7; 16],
        artifact_version: Some("0.3.3".into()),
        artifact_sha256: Some(sha(bytes)),
        artifact_size: Some(bytes.len() as u64),
        artifact_target_triple: Some("aarch64-unknown-linux-gnu".into()),
        artifact: Some(bytes.to_vec()),
        reattach: false,
    }
}

fn id() -> Vec<u8> {
    vec![9; 16]
}

#[test]
fn operation_ids_are_bounded() {
    assert_eq!(validate_operation_id(&[]), Err(ErrorCode::InvalidOperands));
    assert_eq!(
        validate_operation_id(&[1; 15]),
        Err(ErrorCode::InvalidOperands)
    );
    assert_eq!(validate_operation_id(&[1; 16]), Ok(()));
    assert_eq!(validate_operation_id(&[1; 64]), Ok(()));
    assert_eq!(
        validate_operation_id(&[1; 65]),
        Err(ErrorCode::InvalidOperands)
    );
}

#[test]
fn artifact_identity_is_validated_exactly() {
    let bytes = b"agent-bytes";
    let operand = install_operand(bytes);
    let artifact = artifact_operand(AgentActionKind::Install, &operand)
        .unwrap()
        .expect("install requires an artifact");
    assert_eq!(artifact.size, bytes.len());
    assert_eq!(artifact.version, "0.3.3");
    assert_eq!(artifact.bytes, bytes);

    for patch in [
        AgentAction {
            artifact_sha256: Some("b".repeat(64)),
            ..install_operand(bytes)
        },
        AgentAction {
            artifact_size: Some(bytes.len() as u64 + 1),
            ..install_operand(bytes)
        },
        AgentAction {
            artifact_version: Some("../escape".into()),
            ..install_operand(bytes)
        },
        AgentAction {
            artifact_target_triple: Some("bad triple".into()),
            ..install_operand(bytes)
        },
        AgentAction {
            artifact_sha256: None,
            ..install_operand(bytes)
        },
    ] {
        assert_eq!(
            artifact_operand(AgentActionKind::Install, &patch).err(),
            Some(ErrorCode::InvalidOperands)
        );
    }

    let oversized = vec![0u8; MAX_ARTIFACT_BYTES + 1];
    assert_eq!(
        artifact_operand(AgentActionKind::Install, &install_operand(&oversized)).err(),
        Some(ErrorCode::InvalidOperands),
        "oversize artifacts are refused before any remote work"
    );
}

#[test]
fn only_install_and_update_accept_artifact_fields() {
    for action in [
        AgentActionKind::PlatformProbe,
        AgentActionKind::Remove,
        AgentActionKind::Status,
        AgentActionKind::Start,
        AgentActionKind::Stop,
        AgentActionKind::Wake,
    ] {
        assert_eq!(
            artifact_operand(action, &install_operand(b"bytes")).err(),
            Some(ErrorCode::InvalidOperands),
            "{action:?} must not accept artifact bytes"
        );
        assert!(
            artifact_operand(
                action,
                &AgentAction {
                    action: action as i32,
                    operation_id: id(),
                    ..AgentAction::default()
                }
            )
            .unwrap()
            .is_none()
        );
    }
    assert_eq!(
        artifact_operand(AgentActionKind::Update, &install_operand(b"bytes"))
            .unwrap()
            .map(|artifact| artifact.bytes.len()),
        Some(5)
    );
}

#[test]
fn labels_and_digests_reject_unsafe_shapes() {
    assert!(safe_label("0.3.3-fix.9ffa9610"));
    assert!(safe_label("aarch64-unknown-linux-gnu"));
    assert!(!safe_label(""));
    assert!(!safe_label(".hidden"));
    assert!(!safe_label("a/b"));
    assert!(!safe_label(&"a".repeat(65)));
    assert!(valid_sha256(&"a".repeat(64)));
    assert!(!valid_sha256(&"A".repeat(64)));
    assert!(!valid_sha256(&"a".repeat(63)));
}

#[test]
fn mutations_are_ambiguous_only_when_the_result_is_unconfirmed() {
    assert!(mutates(AgentActionKind::Install));
    assert!(mutates(AgentActionKind::Stop));
    assert!(!mutates(AgentActionKind::Status));
    assert!(!mutates(AgentActionKind::PlatformProbe));

    for code in [None, Some(255)] {
        assert!(mutating_outcome_unknown(AgentActionKind::Install, code));
    }
    assert!(!mutating_outcome_unknown(AgentActionKind::Install, Some(0)));
    assert!(!mutating_outcome_unknown(
        AgentActionKind::Install,
        Some(66)
    ));
    assert!(!mutating_outcome_unknown(
        AgentActionKind::Status,
        Some(255)
    ));

    assert!(failure_is_unknown(
        AgentActionKind::Install,
        ErrorCode::ShellTimedOut
    ));
    assert!(failure_is_unknown(
        AgentActionKind::Remove,
        ErrorCode::TransportLost
    ));
    assert!(!failure_is_unknown(
        AgentActionKind::Status,
        ErrorCode::ShellTimedOut
    ));
    assert!(!failure_is_unknown(
        AgentActionKind::Install,
        ErrorCode::OwnerUnavailable
    ));
}

fn settled(action: AgentActionKind, exit_code: i32) -> AgentActionResult {
    AgentActionResult {
        action: action as i32,
        operation_id: id(),
        exit_code: Some(exit_code),
        stdout: b"done".to_vec(),
        stderr: Vec::new(),
        truncated: false,
        outcome_unknown: false,
        reattached: false,
    }
}

#[test]
fn a_recorded_operation_is_reattached_and_never_replayed() {
    let mut operations = Operations::default();
    operations
        .record(&id(), &settled(AgentActionKind::Install, 0))
        .unwrap();
    let replay = operations
        .known(&id(), AgentActionKind::Install)
        .expect("known operation reattaches");
    assert!(replay.reattached);
    assert_eq!(replay.exit_code, Some(0));
    // A different verb under the same id is not the same remote operation.
    assert!(operations.known(&id(), AgentActionKind::Remove).is_none());
    assert!(
        operations
            .known(&[8; 16], AgentActionKind::Install)
            .is_none()
    );
}

#[test]
fn an_unknown_outcome_stays_unknown_across_reattach() {
    let mut operations = Operations::default();
    let mut unknown = settled(AgentActionKind::Install, 0);
    unknown.exit_code = None;
    unknown.outcome_unknown = true;
    operations.record(&id(), &unknown).unwrap();
    let replay = operations
        .known(&id(), AgentActionKind::Install)
        .expect("unknown operation is still known");
    assert!(replay.outcome_unknown);
    assert!(replay.reattached);
    assert_eq!(operations.len(), 1);
}

#[test]
fn the_operation_table_is_bounded() {
    let mut operations = Operations::default();
    for index in 0..128u16 {
        let mut entry = settled(AgentActionKind::Status, 0);
        entry.operation_id = index.to_be_bytes().repeat(8);
        operations
            .record(&entry.operation_id.clone(), &entry)
            .unwrap();
    }
    assert_eq!(operations.len(), 128);
    assert_eq!(
        operations.record(&[0xff; 16], &settled(AgentActionKind::Status, 0)),
        Err(ErrorCode::OwnerUnavailable)
    );
    // An existing id is still addressable at capacity.
    assert!(
        operations
            .known(&[0u8; 16], AgentActionKind::Status)
            .is_some()
    );
}
