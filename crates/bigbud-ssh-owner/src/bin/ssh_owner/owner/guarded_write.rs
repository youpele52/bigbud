use std::{collections::HashSet, time::Instant};

use super::{ErrorCode, Operation, Outcome, Owner, guarded_write_stage::*};
use crate::{
    Token, random_token,
    v1::ProofWorkspaceGuardedWriteApply,
    v1::{
        Empty, ProofWorkspaceGuardedWriteBinding, ProofWorkspaceGuardedWriteStage,
        proof_workspace_guarded_write_stage as result,
    },
};

const MAX_FINALIZED: usize = 256;

/// Owner-scoped, not attachment-scoped. Never evict a finalized ID to admit
/// another edit. This proof makes no claim about replay across owner death.
pub(super) struct GuardedWrite {
    stage: Stage,
    finalized: HashSet<String>,
    apply_proof: bool,
}

impl GuardedWrite {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) fn for_fixture(
        opted_in: bool,
        config: &super::TransportConfig,
        lock: &std::path::Path,
        generation: Token,
    ) -> Option<Self> {
        if !opted_in
            || config.alias_config.is_some()
            || !super::workspace_readiness::matches_fixture(config, lock)
        {
            return None;
        }
        let root = config.workspace_root.as_deref()?.to_str()?;
        Some(Self {
            stage: Stage::new(generation, root).ok()?,
            finalized: HashSet::new(),
            apply_proof: false,
        })
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(super) fn for_apply_fixture(
        config: &super::TransportConfig,
        lock: &std::path::Path,
        generation: Token,
    ) -> Option<Self> {
        use std::path::Path;

        if config.ssh != Path::new("/usr/bin/ssh")
            || config.keyscan != Path::new("/usr/bin/ssh-keyscan")
        {
            return None;
        }
        let mut guarded = Self::for_fixture(true, config, lock, generation)?;
        guarded.apply_proof = true;
        Some(guarded)
    }

    pub(super) fn allows(&self, operation: &Operation) -> bool {
        self.apply_proof || !matches!(operation, Operation::ProofWorkspaceGuardedWriteApply(_))
    }

    pub(super) fn reset_attachment(&mut self, generation: Token) {
        self.stage.reset_attachment(generation);
    }

    fn admit_new(&self, operation_id: &str) -> Result<(), ErrorCode> {
        if self.finalized.contains(operation_id) {
            return Err(ErrorCode::OperationDenied);
        }
        if self.finalized.len() >= MAX_FINALIZED {
            return Err(ErrorCode::OwnerUnavailable);
        }
        Ok(())
    }

    fn take_verified(
        &mut self,
        binding: &Binding,
        lease: Lease,
        now: Instant,
    ) -> Result<Committed, ErrorCode> {
        self.admit_new(&binding.operation_id)?;
        let verified = self
            .stage
            .commit(binding, lease, now)
            .map_err(stage_error)?;
        // Claim before any dispatch (or validation reply). This bounded set is
        // never evicted and survives attachment and generation resets.
        if !self.finalized.insert(verified.binding.operation_id.clone()) {
            return Err(ErrorCode::OperationDenied);
        }
        Ok(verified)
    }

    fn execute(
        &mut self,
        generation: Token,
        operation: Operation,
    ) -> Result<result::Outcome, ErrorCode> {
        let now = Instant::now();
        match operation {
            Operation::ProofWorkspaceGuardedWriteBegin(begin) => {
                let binding = binding(generation, begin.binding)?;
                self.admit_new(&binding.operation_id)?;
                let nonce = random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
                let lease = self
                    .stage
                    .begin(&binding, nonce, now)
                    .map_err(stage_error)?;
                Ok(result::Outcome::Begun(lease.to_wire()))
            }
            Operation::ProofWorkspaceGuardedWriteChunk(chunk) => {
                let binding = binding(generation, chunk.binding)?;
                let lease = lease(&chunk.lease)?;
                let offset =
                    usize::try_from(chunk.offset).map_err(|_| ErrorCode::InvalidOperands)?;
                self.stage
                    .chunk(&binding, lease, offset, &chunk.data, now)
                    .map_err(stage_error)?;
                // Stage accepted both the offset and length within its 512 KiB cap.
                let next = u32::try_from(offset + chunk.data.len())
                    .map_err(|_| ErrorCode::InvalidOperands)?;
                Ok(result::Outcome::ChunkAccepted(next))
            }
            Operation::ProofWorkspaceGuardedWriteCommit(commit) => {
                let binding = binding(generation, commit.binding)?;
                let lease = lease(&commit.lease)?;
                // COMMIT is always validation-only, including in APPLY proof mode.
                drop(self.take_verified(&binding, lease, now)?);
                Ok(result::Outcome::ValidatedNotDispatched(Empty {}))
            }
            Operation::ProofWorkspaceGuardedWriteAbort(abort) => {
                let binding = binding(generation, abort.binding)?;
                let lease = lease(&abort.lease)?;
                self.stage
                    .abort(&binding, lease, now)
                    .map_err(stage_error)?;
                Ok(result::Outcome::Aborted(Empty {}))
            }
            _ => Err(ErrorCode::OperationDenied),
        }
    }
}

pub(super) fn is_guarded_write(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::ProofWorkspaceGuardedWriteBegin(_)
            | Operation::ProofWorkspaceGuardedWriteChunk(_)
            | Operation::ProofWorkspaceGuardedWriteCommit(_)
            | Operation::ProofWorkspaceGuardedWriteAbort(_)
            | Operation::ProofWorkspaceGuardedWriteApply(_)
    )
}

impl Owner {
    pub(super) fn reset_guarded_write(&mut self) {
        if let Some(guarded) = &mut self.guarded_write {
            guarded.reset_attachment(self.generation);
        }
    }

    pub(super) fn execute_guarded_write(
        &mut self,
        operation: Operation,
    ) -> Result<Outcome, ErrorCode> {
        let guarded = self
            .guarded_write
            .as_mut()
            .ok_or(ErrorCode::OperationDenied)?;
        if !guarded.allows(&operation) {
            return Err(ErrorCode::OperationDenied);
        }
        if let Operation::ProofWorkspaceGuardedWriteApply(apply) = operation {
            return self.apply_guarded_write(apply);
        }
        let outcome = guarded.execute(self.generation, operation)?;
        Ok(Outcome::ProofWorkspaceGuardedWriteStage(
            ProofWorkspaceGuardedWriteStage {
                outcome: Some(outcome),
            },
        ))
    }

    fn apply_guarded_write(
        &mut self,
        apply: ProofWorkspaceGuardedWriteApply,
    ) -> Result<Outcome, ErrorCode> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let guarded = self
                .guarded_write
                .as_mut()
                .filter(|guarded| guarded.apply_proof)
                .ok_or(ErrorCode::OperationDenied)?;
            let binding = binding(self.generation, apply.binding)?;
            let lease = lease(&apply.lease)?;
            let verified = guarded.take_verified(&binding, lease, Instant::now())?;
            Ok(apply_proof::dispatch(&self.transport, &verified))
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = apply;
            Err(ErrorCode::OperationDenied)
        }
    }
}

fn binding(
    generation: Token,
    wire: Option<ProofWorkspaceGuardedWriteBinding>,
) -> Result<Binding, ErrorCode> {
    let wire = wire.ok_or(ErrorCode::InvalidOperands)?;
    let body_bytes = wire.body_bytes.ok_or(ErrorCode::InvalidOperands)?;
    Ok(Binding {
        generation,
        operation_id: wire.operation_id,
        root: wire.workspace_root,
        path: wire.relative_path,
        expected_sha256: wire
            .expected_sha256
            .try_into()
            .map_err(|_| ErrorCode::InvalidOperands)?,
        attempted_sha256: wire
            .attempted_sha256
            .try_into()
            .map_err(|_| ErrorCode::InvalidOperands)?,
        body_bytes: usize::try_from(body_bytes).map_err(|_| ErrorCode::InvalidOperands)?,
    })
}

fn lease(wire: &[u8]) -> Result<Lease, ErrorCode> {
    Lease::from_wire(wire).ok_or(ErrorCode::InvalidOperands)
}

fn stage_error(error: StageError) -> ErrorCode {
    match error {
        StageError::BindingMismatch
        | StageError::LeaseMismatch
        | StageError::NoDraft
        | StageError::Busy => ErrorCode::OperationDenied,
        StageError::LeaseUnavailable => ErrorCode::OwnerUnavailable,
        StageError::InvalidOperands
        | StageError::InvalidChunkSize
        | StageError::InvalidOffset
        | StageError::SizeMismatch
        | StageError::DigestMismatch
        | StageError::InvalidText => ErrorCode::InvalidOperands,
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
#[path = "guarded_write.tests.rs"]
mod tests;

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "guarded_write.apply.rs"]
mod apply_proof;

/// Startup blockers that make the guarded-write fixture unavailable.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) struct Blockers {
    pub agent_fixture: bool,
    pub identity_agent: bool,
    pub stage: bool,
    pub posix_picker: bool,
    pub connector: bool,
    pub snapshot_cancel: bool,
    pub tracked_push_or_opencode: bool,
    /// Production mode never selects a fixture guarded-write installation.
    pub production: bool,
}

/// Fixture-only guarded-write selection, kept out of `bootstrap`.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn for_startup(
    config: &super::TransportConfig,
    lock: &std::path::Path,
    generation: crate::Token,
    blockers: Blockers,
) -> Option<GuardedWrite> {
    if blockers.agent_fixture
        || blockers.identity_agent
        || blockers.stage
        || blockers.posix_picker
        || blockers.connector
        || blockers.snapshot_cancel
        || blockers.tracked_push_or_opencode
        || blockers.production
    {
        return None;
    }
    let stage_proof = std::env::var_os("BIGBUD_SSH_OWNER_GUARDED_WRITE_STAGE_PROOF").as_deref()
        == Some(std::ffi::OsStr::new("1"));
    let apply_proof = std::env::var_os("BIGBUD_SSH_OWNER_GUARDED_WRITE_APPLY_PROOF").as_deref()
        == Some(std::ffi::OsStr::new("approved-disposable"));
    if apply_proof {
        GuardedWrite::for_apply_fixture(config, lock, generation)
    } else {
        GuardedWrite::for_fixture(stage_proof, config, lock, generation)
    }
}
