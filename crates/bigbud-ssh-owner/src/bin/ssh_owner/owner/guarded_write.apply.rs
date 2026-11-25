use super::{Committed, Empty, Outcome};
use crate::{
    transport::{Transport, guarded_recipe as recipe},
    v1::{
        ProofGuardedWriteConflict, ProofWorkspaceGuardedWriteResult,
        proof_workspace_guarded_write_result::Outcome as ResultOutcome,
    },
};

/// The external coordinator must persist intent before requesting APPLY. This
/// owner cannot verify SQLite durability or deduplicate across owner death.
pub(super) fn dispatch(transport: &Transport, verified: &Committed) -> Outcome {
    let binding = &verified.binding;
    let result = recipe::execute(
        transport,
        &recipe::StagedWrite {
            root: &binding.root,
            path: &binding.path,
            operation_id: &binding.operation_id,
            base: &binding.expected_sha256,
            attempted: &binding.attempted_sha256,
            bytes: &verified.bytes,
        },
    );
    Outcome::ProofWorkspaceGuardedWriteResult(ProofWorkspaceGuardedWriteResult {
        outcome: Some(wire_outcome(result)),
    })
}

fn wire_outcome(result: Result<recipe::Outcome, super::ErrorCode>) -> ResultOutcome {
    match result {
        Ok(recipe::Outcome::Saved { sha256, .. }) => ResultOutcome::SavedSha256(sha256.to_vec()),
        Ok(recipe::Outcome::Conflict(conflict)) => {
            ResultOutcome::Conflict(ProofGuardedWriteConflict {
                current_sha256: match conflict {
                    recipe::Conflict::Hash(sha256) => Some(sha256.to_vec()),
                    recipe::Conflict::Missing | recipe::Conflict::Changed => None,
                },
            })
        }
        // The transport only returns an error when it knows it did not spawn.
        Ok(recipe::Outcome::Terminal(_)) | Err(_) => ResultOutcome::Terminal(Empty {}),
        Ok(recipe::Outcome::Unknown) => ResultOutcome::Unknown(Empty {}),
    }
}
