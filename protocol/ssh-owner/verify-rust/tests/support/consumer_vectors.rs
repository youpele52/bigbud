use std::collections::BTreeMap;

use super::{assert_frame, reply, request, v1};
use v1::{
    Empty, Error, ErrorCode, ProofHealth, ProofWorkspaceContentMatches,
    ProofWorkspaceContentSearch, ProofWorkspaceGit, ProofWorkspaceGitAction,
    ProofWorkspaceGitOutcome, ProofWorkspaceGitResult, ProofWorkspaceIndex,
    ProofWorkspaceIndexResult, ProofWorkspaceIndexedEntry, ProofWorkspaceList, ProofWorkspaceMatch,
    ProofWorkspaceSnapshotResult, ProofWorkspaceWrite, reply::Outcome, request::Operation,
};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    let worktree = "/tmp/bigbud-picker-linux-Fixture/client";
    let git_dir = format!("{worktree}/.git");
    assert_frame(
        values,
        "proof_git_tracked_push",
        request(Operation::GitTrackedPush(Box::new(
            v1::ProofGitTrackedPush {
                repository: Some(v1::ProofGitPushRepository {
                    worktree: worktree.into(),
                    git_dir: git_dir.clone(),
                    common_dir: git_dir,
                }),
                remote_name: "origin".into(),
                source_ref: "refs/heads/main".into(),
                destination_ref: "refs/heads/main".into(),
                source_oid: "1".repeat(40),
                destination: Some(v1::ProofGitPushDestination {
                    effective_url: "ssh://picker@127.0.0.1:22222/receive.git".into(),
                    execution_target_id: "ssh:fixture-target".into(),
                    target_generation: vec![82; 32],
                    host: "127.0.0.1".into(),
                    user: "picker".into(),
                    port: 22222,
                    repository_path: "/receive.git".into(),
                    expected_old_oid: "2".repeat(40),
                }),
                timeout_ms: 30_000,
            },
        ))),
    );
    assert_frame(
        values,
        "proof_git_tracked_push_reply",
        reply(Outcome::ProofGitTrackedPush(
            v1::ProofGitTrackedPushReceipt {
                status: v1::ProofGitTrackedPushStatus::Accepted.into(),
            },
        )),
    );
    assert_frame(
        values,
        "proof_deployment_completion_request",
        request(Operation::DeploymentCompletion(
            v1::ProofDeploymentCompletion {
                deployment_request_id: "2e789a0b-6e7b-411b-8d34-4107f1c18902".into(),
                authority_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            },
        )),
    );
    assert_frame(
        values,
        "proof_deployment_request",
        request(Operation::DeploymentHostProbe(
            v1::ProofDeploymentHostProbe {
                deployment_request_id: "2e789a0b-6e7b-411b-8d34-4107f1c18902".into(),
            },
        )),
    );
    assert_frame(
        values,
        "proof_deployment_reply",
        reply(Outcome::ProofDeploymentHostResult(
            v1::ProofDeploymentHostResult {
                code: Some(70),
                stdout: String::new(),
                stderr: "synthetic failure\n".into(),
                state: 0,
            },
        )),
    );
    assert_frame(
        values,
        "proof_deployment_action",
        request(Operation::DeploymentAction(v1::ProofDeploymentAction {
            request_id: "2e789a0b-6e7b-411b-8d34-4107f1c18902".into(),
            kind: v1::ProofDeploymentActionKind::Publish.into(),
            install_name: "1.2.3-aarch64-unknown-linux-gnu-0011223344556677".into(),
            archive_sha256: "a".repeat(64),
            manifest_sha256: "b".repeat(64),
            url: String::new(),
            max_bytes: 0,
            contents: Vec::new(),
            authority_id: String::new(),
            enable_boot: false,
            node_path: "bin/node".into(),
            entry_path: "app/entry.mjs".into(),
            pins: vec![v1::ProofDeploymentPinnedFile {
                path: "bin/node".into(),
                sha256: "d".repeat(64),
            }],
        })),
    );
    assert_frame(
        values,
        "proof_deployment_action_result",
        reply(Outcome::ProofDeploymentHostResult(
            v1::ProofDeploymentHostResult {
                code: Some(0),
                stdout: "published\n".into(),
                stderr: String::new(),
                state: v1::ProofDeploymentOperationState::Completed.into(),
            },
        )),
    );
    for (name, code) in [
        (
            "error_proof_deployment_timeout",
            ErrorCode::ProofDeploymentTimeout,
        ),
        (
            "error_proof_deployment_output_limit",
            ErrorCode::ProofDeploymentOutputLimit,
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
    for (name, action) in [
        (
            "proof_git_status",
            ProofWorkspaceGitAction::StatusPorcelainV2,
        ),
        (
            "proof_git_inside",
            ProofWorkspaceGitAction::IsInsideWorkTree,
        ),
        (
            "proof_git_staged_numstat",
            ProofWorkspaceGitAction::StagedNumstat,
        ),
        (
            "proof_git_unstaged_numstat",
            ProofWorkspaceGitAction::UnstagedNumstat,
        ),
        (
            "proof_git_origin_default",
            ProofWorkspaceGitAction::OriginDefaultRef,
        ),
        (
            "proof_git_origin_url",
            ProofWorkspaceGitAction::OriginRemoteUrl,
        ),
    ] {
        assert_frame(
            values,
            name,
            request(Operation::WorkspaceGit(ProofWorkspaceGit {
                workspace_root: "/fixture/root".into(),
                action: action.into(),
                paths: Vec::new(),
                ..Default::default()
            })),
        );
    }
    for (name, action, paths) in [
        (
            "proof_git_status_nul",
            ProofWorkspaceGitAction::StatusPorcelainV2Nul,
            Vec::new(),
        ),
        (
            "proof_git_show_toplevel",
            ProofWorkspaceGitAction::ShowToplevel,
            Vec::new(),
        ),
        (
            "proof_git_restore_paths",
            ProofWorkspaceGitAction::RestoreTrackedPaths,
            vec!["a.txt".to_string(), "nested/b.txt".to_string()],
        ),
        (
            "proof_git_clean_paths",
            ProofWorkspaceGitAction::CleanUntrackedPaths,
            vec!["new.txt".to_string()],
        ),
        (
            "proof_git_stage_paths",
            ProofWorkspaceGitAction::StagePaths,
            vec!["a.txt".to_string()],
        ),
        (
            "proof_git_untracked_numstat",
            ProofWorkspaceGitAction::UntrackedNumstat,
            vec!["new.txt".to_string()],
        ),
    ] {
        assert_frame(
            values,
            name,
            request(Operation::WorkspaceGit(ProofWorkspaceGit {
                workspace_root: "/tmp/bigbud-picker-linux-Fixture/client".into(),
                action: action.into(),
                paths,
                ..Default::default()
            })),
        );
    }
    for (name, code, stdout, stderr) in [
        ("proof_git_success", 0, "true\n", ""),
        ("proof_git_exit", 128, "", "synthetic failure\n"),
    ] {
        assert_frame(
            values,
            name,
            reply(Outcome::ProofWorkspaceGit(ProofWorkspaceGitResult {
                code: Some(code),
                stdout: stdout.into(),
                stderr: stderr.into(),
                outcome: 0,
                ..Default::default()
            })),
        );
    }
    for (name, outcome) in [
        (
            "proof_git_outcome_unknown",
            ProofWorkspaceGitOutcome::OutcomeUnknown,
        ),
        (
            "proof_git_outcome_cancelled",
            ProofWorkspaceGitOutcome::Cancelled,
        ),
    ] {
        assert_frame(
            values,
            name,
            reply(Outcome::ProofWorkspaceGit(ProofWorkspaceGitResult {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                outcome: outcome as i32,
                ..Default::default()
            })),
        );
    }
    for (name, operation) in [
        (
            "proof_snapshot_request",
            Operation::WorkspaceSnapshot(ProofWorkspaceList {
                workspace_root: "/fixture/root".into(),
                relative_dir: "watched".into(),
            }),
        ),
        (
            "proof_index_request",
            Operation::WorkspaceIndex(ProofWorkspaceIndex {
                workspace_root: "/fixture/root".into(),
            }),
        ),
        (
            "proof_write_request",
            Operation::WorkspaceWrite(ProofWorkspaceWrite {
                workspace_root: "/fixture/root".into(),
                relative_path: "dir/a.txt".into(),
                contents: b"a\0b".to_vec(),
            }),
        ),
        (
            "proof_search_request",
            Operation::WorkspaceContentSearch(ProofWorkspaceContentSearch {
                workspace_root: "/fixture/root".into(),
                query: "abc.(".into(),
                limit: 5,
            }),
        ),
        ("proof_health_request", Operation::SampleHealth(Empty {})),
    ] {
        assert_frame(values, name, request(operation));
    }
    for (name, outcome) in [
        (
            "proof_snapshot_reply",
            Outcome::ProofWorkspaceSnapshot(ProofWorkspaceSnapshotResult {
                digest: "a".repeat(64),
            }),
        ),
        (
            "proof_index_reply",
            Outcome::ProofWorkspaceIndex(ProofWorkspaceIndexResult {
                entries: vec![
                    ProofWorkspaceIndexedEntry {
                        path: "dir".into(),
                        directory: true,
                    },
                    ProofWorkspaceIndexedEntry {
                        path: "dir/a.txt".into(),
                        directory: false,
                    },
                ],
                truncated: true,
            }),
        ),
        (
            "proof_write_reply",
            Outcome::ProofWorkspaceWritten(Empty {}),
        ),
        (
            "proof_search_reply",
            Outcome::ProofWorkspaceContentMatches(ProofWorkspaceContentMatches {
                matches: vec![ProofWorkspaceMatch {
                    path: "dir/a.txt".into(),
                    line: 2,
                    column: Some(1),
                    line_text: "abc.( sample".into(),
                }],
                truncated: true,
            }),
        ),
        (
            "proof_health_success",
            Outcome::ProofHealth(ProofHealth { reachable: true }),
        ),
        (
            "proof_health_unreachable",
            Outcome::ProofHealth(ProofHealth { reachable: false }),
        ),
        (
            "error_workspace_write_failed",
            Outcome::Error(Error {
                code: ErrorCode::WorkspaceWriteFailed.into(),
                jump_failure: None,
            }),
        ),
        (
            "error_proof_ripgrep_unavailable",
            Outcome::Error(Error {
                code: ErrorCode::ProofRipgrepUnavailable.into(),
                jump_failure: None,
            }),
        ),
    ] {
        assert_frame(values, name, reply(outcome));
    }
}
