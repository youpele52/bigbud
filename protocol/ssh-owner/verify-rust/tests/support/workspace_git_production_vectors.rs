//! C06 (B): production `workspace_git` read actions (diff panel, branch list).

use std::collections::BTreeMap;

use super::{assert_frame, request, v1};
use v1::{ProofWorkspaceGit, ProofWorkspaceGitAction, request::Operation};

pub(super) fn verify(values: &mut BTreeMap<&str, Vec<u8>>) {
    for (name, action, paths) in [
        (
            "workspace_git_diff_unstaged_path",
            ProofWorkspaceGitAction::DiffUnstaged,
            vec!["src/a.ts".to_string()],
        ),
        (
            "workspace_git_untracked_file_diff",
            ProofWorkspaceGitAction::UntrackedFileDiff,
            vec!["new.txt".to_string()],
        ),
        (
            "workspace_git_local_branches",
            ProofWorkspaceGitAction::LocalBranches,
            Vec::new(),
        ),
    ] {
        assert_frame(
            values,
            name,
            request(Operation::WorkspaceGit(ProofWorkspaceGit {
                workspace_root: "/home/fixture/project".into(),
                action: action.into(),
                paths,
                ..Default::default()
            })),
        );
    }
    assert_frame(
        values,
        "workspace_git_commit_log",
        request(Operation::WorkspaceGit(ProofWorkspaceGit {
            workspace_root: "/home/fixture/project".into(),
            action: ProofWorkspaceGitAction::CommitLog.into(),
            limit: 21,
            skip: 20,
            ..Default::default()
        })),
    );
    assert_frame(
        values,
        "workspace_git_commit_file_diff",
        request(Operation::WorkspaceGit(ProofWorkspaceGit {
            workspace_root: "/home/fixture/project".into(),
            action: ProofWorkspaceGitAction::CommitFileDiff.into(),
            paths: vec!["src/a.ts".into()],
            revision: "0123456789abcdef0123456789abcdef01234567".into(),
            max_output_bytes: 262_144,
            ..Default::default()
        })),
    );
    assert_frame(
        values,
        "workspace_git_commit_with_body",
        request(Operation::WorkspaceGit(ProofWorkspaceGit {
            workspace_root: "/home/fixture/project".into(),
            action: ProofWorkspaceGitAction::CommitWithBody.into(),
            operands: vec!["feat: subject".into(), "body".into()],
            ..Default::default()
        })),
    );
    assert_frame(
        values,
        "workspace_git_remote_add",
        request(Operation::WorkspaceGit(ProofWorkspaceGit {
            workspace_root: "/home/fixture/project".into(),
            action: ProofWorkspaceGitAction::RemoteAdd.into(),
            operands: vec!["upstream".into(), "git@example.invalid:o/r.git".into()],
            ..Default::default()
        })),
    );
}
