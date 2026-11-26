use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{
    Empty, Error, ErrorCode, ProofFileRange, ProofWorkspaceCreateDirectory,
    ProofWorkspaceDeleteEntry, ProofWorkspaceDirectory, ProofWorkspaceEntry,
    ProofWorkspaceEntryMutation, ProofWorkspaceFile, ProofWorkspaceList, ProofWorkspaceRead,
    ProofWorkspaceWriteAbort, ProofWorkspaceWriteBegin, ProofWorkspaceWriteBinding,
    ProofWorkspaceWriteChunk, ProofWorkspaceWriteCommit, ProofWorkspaceWriteStage,
    proof_workspace_entry_mutation, proof_workspace_read::Read, proof_workspace_write_stage,
    reply::Outcome, request::Operation,
};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    for (name, relative_dir) in [
        ("proof_directory_root", ""),
        ("proof_directory_nested", "folder with space"),
    ] {
        assert_frame(
            values,
            name,
            request(Operation::WorkspaceList(ProofWorkspaceList {
                workspace_root: "/fixture/root".into(),
                relative_dir: relative_dir.into(),
            })),
        );
    }
    assert_frame(
        values,
        "proof_directory_result",
        reply(Outcome::ProofWorkspaceDirectory(ProofWorkspaceDirectory {
            entries: vec![
                ProofWorkspaceEntry {
                    name: "hidden".into(),
                    directory: true,
                },
                ProofWorkspaceEntry {
                    name: "name\twith-tab".into(),
                    directory: false,
                },
            ],
            truncated: true,
        })),
    );
    for (name, read) in [
        ("proof_workspace_preview", Read::Preview(Empty {})),
        (
            "proof_workspace_range",
            Read::Range(ProofFileRange {
                offset: 31,
                max_bytes: 2,
            }),
        ),
    ] {
        assert_frame(
            values,
            name,
            request(Operation::WorkspaceRead(ProofWorkspaceRead {
                workspace_root: "/fixture/root".into(),
                relative_path: "data.bin".into(),
                read: Some(read),
            })),
        );
    }
    assert_frame(
        values,
        "proof_workspace_result",
        reply(Outcome::ProofWorkspaceFile(ProofWorkspaceFile {
            data: vec![0, 255],
            size_bytes: 34,
            truncated: true,
            sha256: None,
        })),
    );
    for (name, operation) in [
        (
            "proof_workspace_guarded_write_begin",
            Operation::WorkspaceGuardedWriteBegin(Default::default()),
        ),
        (
            "proof_workspace_guarded_write_chunk",
            Operation::WorkspaceGuardedWriteChunk(Default::default()),
        ),
        (
            "proof_workspace_guarded_write_commit",
            Operation::WorkspaceGuardedWriteCommit(Default::default()),
        ),
        (
            "proof_workspace_guarded_write_abort",
            Operation::WorkspaceGuardedWriteAbort(Default::default()),
        ),
        (
            "proof_workspace_guarded_write_apply",
            Operation::WorkspaceGuardedWriteApply(Default::default()),
        ),
        (
            "proof_workspace_create",
            Operation::WorkspaceCreate(Default::default()),
        ),
        (
            "proof_workspace_readiness",
            Operation::WorkspaceReadiness(Default::default()),
        ),
    ] {
        // Empty operands: these vectors are syntactic, not admission proofs.
        assert_frame(values, name, request(operation));
    }
    let binding = ProofWorkspaceWriteBinding {
        operation_id: "op-1".into(),
        workspace_root: "/fixture/root".into(),
        relative_path: "a.txt".into(),
        body_bytes: Some(3),
    };
    let lease: Vec<u8> = (0..40).collect();
    for (name, operation) in [
        (
            "proof_workspace_create_directory",
            Operation::WorkspaceCreateDirectory(ProofWorkspaceCreateDirectory {
                workspace_root: "/fixture/root".into(),
                relative_path: "new folder".into(),
            }),
        ),
        (
            "proof_workspace_delete_entry",
            Operation::WorkspaceDeleteEntry(ProofWorkspaceDeleteEntry {
                workspace_root: "/fixture/root".into(),
                relative_path: "old.txt".into(),
                expected_directory: true,
            }),
        ),
        (
            "proof_workspace_write_begin",
            Operation::WorkspaceWriteBegin(ProofWorkspaceWriteBegin {
                binding: Some(binding.clone()),
            }),
        ),
        (
            "proof_workspace_write_chunk",
            Operation::WorkspaceWriteChunk(ProofWorkspaceWriteChunk {
                binding: Some(binding.clone()),
                lease: lease.clone(),
                offset: 0,
                data: b"abc".to_vec(),
            }),
        ),
        (
            "proof_workspace_write_commit",
            Operation::WorkspaceWriteCommit(ProofWorkspaceWriteCommit {
                binding: Some(binding.clone()),
                lease: lease.clone(),
            }),
        ),
        (
            "proof_workspace_write_abort",
            Operation::WorkspaceWriteAbort(ProofWorkspaceWriteAbort {
                binding: Some(binding),
                lease: lease.clone(),
            }),
        ),
    ] {
        assert_frame(values, name, request(operation));
    }
    for (name, outcome) in [
        (
            "proof_workspace_readiness_result",
            Outcome::ProofWorkspaceReadiness(Default::default()),
        ),
        (
            "proof_workspace_guarded_write_stage",
            Outcome::ProofWorkspaceGuardedWriteStage(Default::default()),
        ),
        (
            "proof_workspace_guarded_write_result",
            Outcome::ProofWorkspaceGuardedWriteResult(Default::default()),
        ),
        (
            "proof_workspace_create_result",
            Outcome::ProofWorkspaceCreateResult(Default::default()),
        ),
        (
            "proof_workspace_entry_mutation",
            Outcome::ProofWorkspaceEntryMutation(ProofWorkspaceEntryMutation {
                outcome: Some(proof_workspace_entry_mutation::Outcome::Created(Empty {})),
            }),
        ),
        (
            "proof_workspace_write_stage",
            Outcome::ProofWorkspaceWriteStage(ProofWorkspaceWriteStage {
                outcome: Some(proof_workspace_write_stage::Outcome::Begun(lease)),
            }),
        ),
    ] {
        assert_frame(values, name, reply(outcome));
    }
    for (name, code) in [
        (
            "error_workspace_path_denied",
            ErrorCode::WorkspacePathDenied,
        ),
        (
            "error_workspace_read_failed",
            ErrorCode::WorkspaceReadFailed,
        ),
        (
            "error_workspace_file_too_large",
            ErrorCode::WorkspaceFileTooLarge,
        ),
    ] {
        assert_frame(
            values,
            name,
            reply(Outcome::Error(Error {
                code: code.into(),
                jump_failure: None,
            })),
        );
    }
}
