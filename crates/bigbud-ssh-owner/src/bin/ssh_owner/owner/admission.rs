use super::{ErrorCode, Operation, Owner, Request};

impl Owner {
    pub(super) fn validate(&self, request: &Request) -> Result<Operation, ErrorCode> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self
            .picker_cancel
            .as_ref()
            .is_some_and(super::picker_cancel::CancelInbox::cleanup_uncertain)
        {
            return Err(ErrorCode::OwnerUnavailable);
        }
        // The target and generation are resolved per request (see
        // `owner::targets`); this only bounds the envelope.
        if request.target_id.len() > 1_024
            || request.owner_epoch != self.epoch
            || request.request_id.is_empty()
            || request.request_id.len() > 128
        {
            return Err(ErrorCode::OperationDenied);
        }
        // A named generation must still be current for its exact target. The
        // pinned target lives in the owner's flat fields, other targets in the
        // registry; both fence a rotated generation before any grant work.
        let current = if request.target_id == self.target && self.transport.is_some() {
            Some(self.generation)
        } else {
            self.targets.generation(&request.target_id)
        };
        if let Some(generation) = current
            && generation != request.target_generation.as_slice()
            // An empty generation is first use only for a descriptor target;
            // the pinned target always has a generation to match.
            && (!request.target_generation.is_empty() || request.target_descriptor.is_none())
        {
            return Err(ErrorCode::StaleGeneration);
        }
        let operation = request
            .operation
            .clone()
            .ok_or(ErrorCode::OperationDenied)?;
        // Production admits the connection/health/discovery verbs only. Every
        // fixture-only verb stays refused before it can touch a bound target.
        if self.production && !production_verb(&operation) {
            return Err(ErrorCode::OperationDenied);
        }
        if self
            .agent_fixture
            .as_ref()
            .is_some_and(|fixture| !fixture.allows_scoped(&operation))
        {
            return Err(ErrorCode::OperationDenied);
        }
        #[cfg(target_os = "linux")]
        if let Some(jump) = &self.jump_picker
            && !(matches!(
                operation,
                Operation::Connect(_) | Operation::Disconnect(_) | Operation::ListFolders(_)
            ) || jump.allows_first_use()
                && matches!(
                    operation,
                    Operation::InspectTrust(_) | Operation::ApproveTrust(_)
                ))
        {
            return Err(ErrorCode::OperationDenied);
        }
        #[cfg(target_os = "linux")]
        if self.tracked_push.is_some()
            && !matches!(
                operation,
                Operation::ProofGitTrackedPush(_)
                    | Operation::InspectTrust(_)
                    | Operation::ApproveTrust(_)
                    | Operation::Connect(_)
                    | Operation::Disconnect(_)
            )
        {
            return Err(ErrorCode::OperationDenied);
        }
        #[cfg(target_os = "linux")]
        if !self.production
            && (self.opencode_recipe.is_some() || self.opencode_service.is_some())
            && !matches!(
                operation,
                Operation::ProofOpencodeOpen(_)
                    | Operation::ProofOpencodeStatus(_)
                    | Operation::ProofOpencodeClose(_)
                    | Operation::InspectTrust(_)
                    | Operation::ApproveTrust(_)
                    | Operation::Connect(_)
                    | Operation::Disconnect(_)
            )
        {
            return Err(ErrorCode::OperationDenied);
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self
            .lanes
            .master
            .as_ref()
            .is_some_and(super::posix_picker::MasterPicker::restricts_admission)
            && !matches!(
                operation,
                Operation::ListFolders(_)
                    | Operation::ProofUnlockSyntheticPosixPassword(_)
                    | Operation::InspectTrust(_)
                    | Operation::ApproveTrust(_)
                    | Operation::Connect(_)
                    | Operation::Disconnect(_)
            )
        {
            return Err(ErrorCode::OperationDenied);
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self.picker_cancel.is_some()
            && !matches!(
                operation,
                Operation::ListFolders(_)
                    | Operation::ProofSampleHealth(_)
                    | Operation::InspectTrust(_)
                    | Operation::ApproveTrust(_)
                    | Operation::Connect(_)
                    | Operation::Disconnect(_)
            )
        {
            return Err(ErrorCode::OperationDenied);
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(inbox) = &self.workspace_snapshot_cancel {
            if inbox.cleanup_uncertain() {
                return Err(ErrorCode::OwnerUnavailable);
            }
            if matches!(operation, Operation::ProofWorkspaceSnapshot(_)) {
                if request.request_id.len() != super::picker_cancel::ID_BYTES {
                    return Err(ErrorCode::InvalidOperands);
                }
            } else if self.snapshot_only_fixture
                && !matches!(operation, Operation::Connect(_) | Operation::Disconnect(_))
            {
                return Err(ErrorCode::OperationDenied);
            }
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if matches!(operation, Operation::ProofWorkspaceReadiness(_))
            && !self.workspace_readiness_fixture
        {
            return Err(ErrorCode::OperationDenied);
        }
        if super::guarded_write::is_guarded_write(&operation) {
            if !self
                .guarded_write
                .as_ref()
                .is_some_and(|guarded| guarded.allows(&operation))
            {
                return Err(ErrorCode::OperationDenied);
            }
            self.storage.allow_network()?;
        }
        Ok(operation)
    }
}

/// Verbs a production owner admits. Everything else is a fixture/proof verb
/// whose promotion is a separate change (plan W7).
///
/// Masters and PTY leases now have real per-target providers: production opens
/// a verified master under the owner's state root for folder listing and runs
/// the target's login shell for a reserved terminal. The agent proxy opens one
/// private mux session per target over that same master, and (on Linux) OpenCode
/// binds one owner-selected listener per target.
fn production_verb(operation: &Operation) -> bool {
    // Agent proxy leases are per target and require no startup-transferred pipe
    // set; they are admitted on every POSIX production host.
    let agent = matches!(
        operation,
        Operation::ProofAgentProxyOpen(_)
            | Operation::ProofAgentProxyStatus(_)
            | Operation::ProofAgentProxyClose(_)
    );
    // OpenCode remains platform-gated: only Linux has the product recipe.
    #[cfg(target_os = "linux")]
    let opencode = matches!(
        operation,
        Operation::ProofOpencodeOpen(_)
            | Operation::ProofOpencodeStatus(_)
            | Operation::ProofOpencodeClose(_)
    );
    #[cfg(not(target_os = "linux"))]
    let opencode = false;
    agent
        || opencode
        || matches!(
            operation,
            Operation::InspectTrust(_)
                | Operation::ApproveTrust(_)
                | Operation::Connect(_)
                | Operation::Disconnect(_)
                | Operation::ListFolders(_)
                | Operation::ListAliases(_)
                | Operation::ProofSampleHealth(_)
                | Operation::ProofPrepareTerminal(_)
                | Operation::ProofCancelTerminalReservation(_)
                | Operation::ProofOpenTerminal(_)
                | Operation::ProofTerminalStatus(_)
                | Operation::ProofTerminalReplay(_)
                | Operation::ProofTerminalInput(_)
                | Operation::ProofTerminalResize(_)
                | Operation::ProofTerminalCwd(_)
                | Operation::ProofCloseTerminal(_)
        )
}
