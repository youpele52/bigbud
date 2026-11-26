use super::{ErrorCode, Operation, Owner, Request};

impl Owner {
    pub(super) fn validate(&self, request: &Request) -> Result<Operation, ErrorCode> {
        // Admission stays closed until the owner acknowledged the exact restart
        // reconciliation round. The typed refusal is reported, never softened.
        if self.admission_error != ErrorCode::Unspecified {
            return Err(self.admission_error);
        }
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
                Operation::GitTrackedPush(_)
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
            && self.opencode_v2.is_some()
            && !matches!(
                operation,
                Operation::OpencodeOpen(_)
                    | Operation::OpencodeStatus(_)
                    | Operation::OpencodeClose(_)
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
                    | Operation::UnlockPosixPassword(_)
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
                    | Operation::SampleHealth(_)
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
            if matches!(operation, Operation::WorkspaceSnapshot(_)) {
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
        if matches!(operation, Operation::WorkspaceReadiness(_))
            && !self.workspace_readiness_fixture
            && !self.production
        {
            return Err(ErrorCode::OperationDenied);
        }
        if super::guarded_write::is_guarded_write(&operation) {
            // Production: the target's own guarded-write lane (owner/guarded_write.production.rs).
            if !self.production
                && !self
                    .guarded_write
                    .as_ref()
                    .is_some_and(|guarded| guarded.allows(&operation))
            {
                return Err(ErrorCode::OperationDenied);
            }
            // Production resolves the target after admission; dispatch re-checks
            // that target's own durable state before any network work.
            if !self.production {
                self.storage.allow_network()?;
            }
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
        Operation::AgentProxyOpen(_)
            | Operation::AgentProxyStatus(_)
            | Operation::AgentProxyClose(_)
    );
    // OpenCode remains platform-gated: only Linux has the product recipe.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let opencode = matches!(
        operation,
        Operation::OpencodeOpen(_) | Operation::OpencodeStatus(_) | Operation::OpencodeClose(_)
    );
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let opencode = false;
    // U15: the read-only Git upload lease and the gated receive (push) lease.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let git_upload = matches!(
        operation,
        Operation::GitUploadOpen(_)
            | Operation::GitUploadStatus(_)
            | Operation::GitUploadClose(_)
            | Operation::GitReceiveOpen(_)
            | Operation::GitReceiveStatus(_)
            | Operation::GitReceiveClose(_)
    );
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let git_upload = false;
    // W2 T-shell: per-target exec leases with the request's own workspace root.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let shell = matches!(
        operation,
        Operation::RunThreadShell(_)
            | Operation::RunProviderWorkspaceShell(_)
            | Operation::RunAcpCommand(_)
            | Operation::RunAcpShell(_)
            | Operation::ShellStatus(_)
            | Operation::ShellClose(_)
    );
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let shell = false;
    // W2 T-backend: per-target deployment step and client relay leases.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let backend = super::backend::production_verb(operation)
        || super::agent_control::production_verb(operation);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let backend = false;
    // W2 T-prov: per-target Pi/Codex probe and provider leases.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let providers = super::provider_lease::production_verb(operation);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let providers = false;
    // In-app password and key passphrase (v1.credential.proto), per target.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let credential = super::credential::production_verb(operation);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let credential = false;
    // U24: owner-wide peer enrollment and relay.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let peer = super::peer_store::owner_wide_verb(operation);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let peer = false;
    peer || agent
        || credential
        || opencode
        || git_upload
        || shell
        || backend
        || providers
        || workspace::production_workspace_verb(operation)
        || workspace::production_terminal_verb(operation)
        || matches!(
            operation,
            Operation::InspectTrust(_)
                | Operation::ApproveTrust(_)
                | Operation::Connect(_)
                | Operation::Disconnect(_)
                | Operation::ListFolders(_)
                | Operation::ListAliases(_)
                | Operation::SampleHealth(_)
                | Operation::PrepareTerminal(_)
                | Operation::CancelTerminalReservation(_)
                | Operation::OpenTerminal(_)
                | Operation::TerminalStatus(_)
                | Operation::TerminalReplay(_)
                | Operation::TerminalInput(_)
                | Operation::TerminalResize(_)
                | Operation::TerminalCwd(_)
                | Operation::CloseTerminal(_)
        )
}

#[path = "admission.workspace.rs"]
mod workspace;
