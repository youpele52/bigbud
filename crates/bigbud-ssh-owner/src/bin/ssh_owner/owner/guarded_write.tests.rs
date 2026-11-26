#![allow(clippy::panic_in_result_fn)] // Test assertions report failures while I/O errors propagate.

#[path = "guarded_write.apply.tests.rs"]
mod apply;
#[path = "guarded_write.test_support.rs"]
mod support;

use super::*;
use crate::{
    owner::{Pipe, Request},
    v1::{
        ProofStorageResult, ProofWorkspaceGuardedWriteAbort, ProofWorkspaceGuardedWriteBegin,
        ProofWorkspaceGuardedWriteChunk, ProofWorkspaceGuardedWriteCommit, Reply, frame::Payload,
    },
};
use prost::Message;
use sha2::{Digest, Sha256};
use std::{io, path::Path};
use support::*;

#[test]
fn grants_bind_packets_and_lost_commit_ack_does_not_allow_another_commit() -> TestResult {
    let fixture = Fixture::new("lostreply")?;
    let mut owner = fixture.owner()?;
    let binding = fixture.binding("edit-1");
    let config = fixture.config();
    let lock = fixture.0.join("owner.lock");
    assert!(GuardedWrite::for_fixture(false, &config, &lock, owner.generation).is_none());
    assert!(
        GuardedWrite::for_fixture(true, &config, Path::new("/wrong.lock"), owner.generation)
            .is_none()
    );
    // Do not depend on parent environment for the explicit fixture opt-in.
    owner.guarded_write = None;
    let disabled = request(&owner, 1, begin(&binding));
    assert_eq!(
        owner.issue(disabled).error,
        i32::from(ErrorCode::OperationDenied)
    );
    fixture.enable(&mut owner);
    let lease = begin_lease(&mut owner, 2, &binding)?;

    let valid = grant(&mut owner, 3, chunk(&binding, &lease));
    let mut altered = valid.clone();
    if let Some(Operation::WorkspaceGuardedWriteChunk(packet)) = &mut altered.operation {
        packet.data.push(b'!');
    }
    assert_error(
        owner.request(&mut Pipe::new(&[][..], Vec::new()), altered)?,
        ErrorCode::OperationDenied,
    );
    let ack = owner.request(&mut Pipe::new(&[][..], Vec::new()), valid)?;
    assert_eq!(
        stage_outcome(ack),
        binding.body_bytes.map(result::Outcome::ChunkAccepted)
    );

    let mut wrong = binding.clone();
    wrong.expected_sha256 = Sha256::digest(b"different base").to_vec();
    assert_error(
        send(&mut owner, 4, commit(&wrong, &lease))?,
        ErrorCode::OperationDenied,
    );
    let accepted = grant(&mut owner, 5, commit(&binding, &lease));
    let input = frames([Payload::Request(accepted.clone())])?;
    assert!(
        owner
            .serve_session(&mut Pipe::new(input.as_slice(), LostReply), |_| Ok(()))
            .is_err()
    );
    assert_error(
        owner.request(&mut Pipe::new(&[][..], Vec::new()), accepted.clone())?,
        ErrorCode::OperationDenied,
    );

    owner.park();
    let hydrate = frames([snapshot(1, false)])?;
    owner.rebind(&mut Pipe::new(hydrate.as_slice(), Vec::new()))?;
    assert_error(
        owner.request(&mut Pipe::new(&[][..], Vec::new()), accepted)?,
        ErrorCode::StaleGeneration,
    );
    for (id, op) in [commit(&binding, &lease), begin(&binding), begin(&wrong)]
        .into_iter()
        .enumerate()
    {
        assert_error(
            send(&mut owner, u8::try_from(id)?, op)?,
            ErrorCode::OperationDenied,
        );
    }
    assert!(!fixture.0.join("recorder.called").exists());
    assert!(!fixture.workspace().exists());
    Ok(())
}

#[test]
fn disconnect_and_rebind_clear_drafts_without_evicting_finalized_ids() -> TestResult {
    let fixture = Fixture::new("lifecycle")?;
    let mut owner = fixture.owner()?;
    fixture.enable(&mut owner);
    let binding = fixture.binding("validated");
    let lease = begin_lease(&mut owner, 1, &binding)?;
    let _ack = send(&mut owner, 2, chunk(&binding, &lease))?;
    assert_eq!(
        stage_outcome(send(&mut owner, 3, commit(&binding, &lease))?),
        Some(result::Outcome::ValidatedNotDispatched(Empty {}))
    );
    let pending = fixture.binding("pending");
    let pending_lease = begin_lease(&mut owner, 4, &pending)?;
    let disconnect = grant(&mut owner, 5, Operation::Disconnect(Empty {}));
    let ack = frames([Payload::ProofStorageResult(ProofStorageResult {
        request_id: disconnect.request_id.clone(),
        seq: 2,
        committed: true,
        error: 0,
    })])?;
    let reply = owner.request(&mut Pipe::new(ack.as_slice(), Vec::new()), disconnect)?;
    assert!(matches!(reply.outcome, Some(Outcome::Connection(_))));
    let detached = super::binding(owner.generation, Some(pending.clone()))
        .map_err(|_| io::Error::other("invalid fixture binding"))?;
    let lease = Lease::from_wire(&pending_lease)
        .ok_or_else(|| io::Error::other("invalid fixture lease"))?;
    let guarded = owner
        .guarded_write
        .as_mut()
        .ok_or_else(|| io::Error::other("expected guarded fixture"))?;
    assert_eq!(
        guarded.stage.commit(&detached, lease, Instant::now()).err(),
        Some(StageError::NoDraft)
    );
    let denied = request(&owner, 6, commit(&pending, &pending_lease));
    assert_eq!(
        owner.issue(denied).error,
        i32::from(ErrorCode::TargetDisconnected)
    );

    let connect = grant(&mut owner, 7, Operation::Connect(Empty {}));
    let ack = frames([Payload::ProofStorageResult(ProofStorageResult {
        request_id: connect.request_id.clone(),
        seq: 3,
        committed: true,
        error: 0,
    })])?;
    let reply = owner.request(&mut Pipe::new(ack.as_slice(), Vec::new()), connect)?;
    assert!(matches!(reply.outcome, Some(Outcome::Connection(_))));
    assert_error(
        send(&mut owner, 8, chunk(&pending, &pending_lease))?,
        ErrorCode::OperationDenied,
    );
    assert_error(
        send(&mut owner, 9, begin(&binding))?,
        ErrorCode::OperationDenied,
    );

    let lease = begin_lease(&mut owner, 10, &pending)?;
    owner.park();
    assert_error(
        send(&mut owner, 11, chunk(&pending, &lease))?,
        ErrorCode::OperationDenied,
    );
    let lease = begin_lease(&mut owner, 12, &pending)?;
    let hydrate = frames([snapshot(3, false)])?;
    owner.rebind(&mut Pipe::new(hydrate.as_slice(), Vec::new()))?;
    assert_error(
        send(&mut owner, 13, chunk(&pending, &lease))?,
        ErrorCode::OperationDenied,
    );
    let lease = begin_lease(&mut owner, 14, &pending)?;
    let abort = Operation::WorkspaceGuardedWriteAbort(ProofWorkspaceGuardedWriteAbort {
        binding: Some(pending.clone()),
        lease: lease.clone(),
    });
    assert_eq!(
        stage_outcome(send(&mut owner, 15, abort)?),
        Some(result::Outcome::Aborted(Empty {}))
    );
    assert_error(
        send(&mut owner, 16, commit(&pending, &lease))?,
        ErrorCode::OperationDenied,
    );

    let guarded = owner
        .guarded_write
        .as_mut()
        .ok_or_else(|| io::Error::other("expected guarded fixture"))?;
    guarded
        .finalized
        .extend((1..MAX_FINALIZED).map(|index| index.to_string()));
    owner.park();
    assert_error(
        send(&mut owner, 17, begin(&pending))?,
        ErrorCode::OwnerUnavailable,
    );
    assert_error(
        send(&mut owner, 18, begin(&binding))?,
        ErrorCode::OperationDenied,
    );
    assert!(!fixture.0.join("recorder.called").exists());
    Ok(())
}

#[test]
fn maximum_chunk_and_binding_fit_the_client_frame() -> TestResult {
    let binding = ProofWorkspaceGuardedWriteBinding {
        operation_id: "a".repeat(128),
        workspace_root: format!("/{}", "b".repeat(4096)),
        relative_path: "c".repeat(4096),
        expected_sha256: vec![1; 32],
        attempted_sha256: vec![2; 32],
        body_bytes: Some(512 * 1024),
    };
    let operation = Operation::WorkspaceGuardedWriteChunk(ProofWorkspaceGuardedWriteChunk {
        binding: Some(binding),
        lease: vec![3; 40],
        offset: 512 * 1024 - 48 * 1024,
        data: vec![b'a'; 48 * 1024],
    });
    let request = Request {
        request_id: vec![4; 128],
        owner_epoch: vec![5; 32],
        target_generation: vec![6; 32],
        target_id: "d".repeat(1024),
        grant: vec![7; 32],
        target_descriptor: None,
        operation: Some(operation),
    };
    let frame = frames([Payload::Request(request)])?;
    assert!(frame.len() <= 64 * 1024 + 4);
    Ok(())
}

#[test]
fn wire_tags_and_optional_empty_body_match_contract() {
    for (operation, tag) in [
        (
            Operation::WorkspaceGuardedWriteBegin(ProofWorkspaceGuardedWriteBegin::default()),
            0xba,
        ),
        (
            Operation::WorkspaceGuardedWriteChunk(ProofWorkspaceGuardedWriteChunk::default()),
            0xc2,
        ),
        (
            Operation::WorkspaceGuardedWriteCommit(ProofWorkspaceGuardedWriteCommit::default()),
            0xca,
        ),
        (
            Operation::WorkspaceGuardedWriteAbort(ProofWorkspaceGuardedWriteAbort::default()),
            0xd2,
        ),
    ] {
        assert_eq!(
            Request {
                operation: Some(operation),
                ..Request::default()
            }
            .encode_to_vec(),
            [tag, 3, 0]
        );
    }
    let reply = Reply {
        outcome: Some(Outcome::ProofWorkspaceGuardedWriteStage(
            ProofWorkspaceGuardedWriteStage {
                outcome: Some(result::Outcome::ValidatedNotDispatched(Empty {})),
            },
        )),
        ..Reply::default()
    };
    assert_eq!(reply.encode_to_vec(), [0xa2, 2, 2, 0x1a, 0]);
    assert_eq!(
        ProofWorkspaceGuardedWriteBinding {
            body_bytes: Some(0),
            ..ProofWorkspaceGuardedWriteBinding::default()
        }
        .encode_to_vec(),
        [0x30, 0]
    );
}
