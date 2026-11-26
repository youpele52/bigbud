use super::Operation;

/// W2 T-files: workspace file verbs a production owner admits. Each carries
/// its own workspace root; the target's transport admits it only under the
/// production root rule (`transport::workspace::root_authority`). Guarded
/// writes, workspace Git, readiness and workspace-mode publication stay
/// fixture-only until they have production lanes of their own.
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
    )
}

/// W2 T-term / U16: the production-only terminal process snapshot and shell
/// inventory. Both run a fixed owner command over the target's own master.
pub(super) fn production_terminal_verb(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::TerminalInspect(_) | Operation::ListTerminalShells(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v1::{Empty, ProofWorkspaceGit, ProofWorkspaceList};

    #[test]
    fn admits_file_verbs_and_keeps_fixture_only_verbs_out() {
        assert!(production_workspace_verb(&Operation::WorkspaceList(
            ProofWorkspaceList::default()
        )));
        assert!(!production_workspace_verb(&Operation::WorkspaceGit(
            ProofWorkspaceGit::default()
        )));
        assert!(!production_workspace_verb(&Operation::Connect(Empty {})));
    }
}
