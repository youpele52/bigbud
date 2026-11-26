use super::Operation;

/// W2 T-files: workspace file verbs a production owner admits. Each carries
/// its own workspace root; the target's transport admits it only under the
/// production root rule (`transport::workspace::root_authority`).
pub(super) fn production_workspace_verb(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::WorkspaceRead(_)
            | Operation::WorkspaceList(_)
            | Operation::WorkspaceSnapshot(_)
            | Operation::WorkspaceIndex(_)
            | Operation::WorkspaceContentSearch(_)
            | Operation::WorkspaceWrite(_)
            | Operation::WorkspaceWriteBegin(_)
            | Operation::WorkspaceWriteChunk(_)
            | Operation::WorkspaceWriteCommit(_)
            | Operation::WorkspaceWriteAbort(_)
            | Operation::WorkspaceCreate(_)
            | Operation::WorkspaceCreateDirectory(_)
            | Operation::WorkspaceDeleteEntry(_)
            // Session-FS and Copilot readiness: `uname` at the request's root.
            | Operation::WorkspaceReadiness(_)
            // Guarded (hash-checked) save on the target's own lane; the server
            // journal claims the intent before APPLY.
            | Operation::WorkspaceGuardedWriteBegin(_)
            | Operation::WorkspaceGuardedWriteChunk(_)
            | Operation::WorkspaceGuardedWriteCommit(_)
            | Operation::WorkspaceGuardedWriteAbort(_)
            | Operation::WorkspaceGuardedWriteApply(_)
            // Session-FS entry info, rename and bounded append (Request 122–124).
            | Operation::WorkspaceEntryInfo(_)
            | Operation::WorkspaceRename(_)
            | Operation::WorkspaceAppend(_)
            // W7 workspace-mode reservation: the request's own root, resolved again
            // on the host; the single-use observation lives in the target's lanes.
            | Operation::WorkspaceModeInspect(_)
            | Operation::WorkspaceModePublish(_)
            // C06 (B): fixed workspace Git recipes under the request's own
            // root (`transport/workspace/git.rs`, production guard).
            | Operation::WorkspaceGit(_)
    )
}

/// W2 T-term / U16 / W7: the production-only terminal process snapshot, shell
/// inventory and system stats sample. Each runs a fixed owner command over the
/// target's own master.
pub(super) fn production_terminal_verb(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::TerminalInspect(_)
            | Operation::ListTerminalShells(_)
            | Operation::SampleSystemStatus(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v1::{Empty, ProofWorkspaceGit, ProofWorkspaceList};

    #[test]
    fn admits_file_and_git_verbs_and_keeps_fixture_only_verbs_out() {
        assert!(production_workspace_verb(&Operation::WorkspaceList(
            ProofWorkspaceList::default()
        )));
        assert!(production_workspace_verb(&Operation::WorkspaceGit(
            ProofWorkspaceGit::default()
        )));
        assert!(!production_workspace_verb(&Operation::Connect(Empty {})));
    }

    #[test]
    fn admits_w7_workspace_mode_and_system_status_in_production() {
        assert!(production_workspace_verb(&Operation::WorkspaceModeInspect(
            crate::v1::ProofWorkspaceModeInspect::default()
        )));
        assert!(production_workspace_verb(&Operation::WorkspaceModePublish(
            crate::v1::ProofWorkspaceModePublish::default()
        )));
        assert!(production_terminal_verb(&Operation::SampleSystemStatus(
            crate::v1::SampleSystemStatus {}
        )));
        assert!(!production_workspace_verb(&Operation::SampleSystemStatus(
            crate::v1::SampleSystemStatus {}
        )));
    }
}
