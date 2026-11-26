use super::Operation;

/// W2 T-files: workspace file verbs a production owner admits. Each carries
/// its own workspace root; the target's transport admits it only under the
/// production root rule (`transport::workspace::root_authority`). Guarded
/// writes, workspace Git, readiness and workspace-mode publication stay
/// fixture-only until they have production lanes of their own.
pub(super) fn production_workspace_verb(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::ProofWorkspaceRead(_)
            | Operation::ProofWorkspaceList(_)
            | Operation::ProofWorkspaceSnapshot(_)
            | Operation::ProofWorkspaceIndex(_)
            | Operation::ProofWorkspaceContentSearch(_)
            | Operation::ProofWorkspaceWrite(_)
            | Operation::ProofWorkspaceWriteBegin(_)
            | Operation::ProofWorkspaceWriteChunk(_)
            | Operation::ProofWorkspaceWriteCommit(_)
            | Operation::ProofWorkspaceWriteAbort(_)
            | Operation::ProofWorkspaceCreate(_)
            | Operation::ProofWorkspaceCreateDirectory(_)
            | Operation::ProofWorkspaceDeleteEntry(_)
            // Session-FS and Copilot readiness: `uname` at the request's root.
            | Operation::ProofWorkspaceReadiness(_)
            // Guarded (hash-checked) save on the target's own lane; the server
            // journal claims the intent before APPLY.
            | Operation::ProofWorkspaceGuardedWriteBegin(_)
            | Operation::ProofWorkspaceGuardedWriteChunk(_)
            | Operation::ProofWorkspaceGuardedWriteCommit(_)
            | Operation::ProofWorkspaceGuardedWriteAbort(_)
            | Operation::ProofWorkspaceGuardedWriteApply(_)
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
        assert!(production_workspace_verb(&Operation::ProofWorkspaceList(
            ProofWorkspaceList::default()
        )));
        assert!(!production_workspace_verb(&Operation::ProofWorkspaceGit(
            ProofWorkspaceGit::default()
        )));
        assert!(!production_workspace_verb(&Operation::Connect(Empty {})));
    }
}
