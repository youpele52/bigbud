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
        if request.target_id != self.target
            || request.owner_epoch != self.epoch
            || request.request_id.is_empty()
            || request.request_id.len() > 128
        {
            return Err(ErrorCode::OperationDenied);
        }
        if request.target_generation != self.generation {
            return Err(ErrorCode::StaleGeneration);
        }
        let operation = request
            .operation
            .clone()
            .ok_or(ErrorCode::OperationDenied)?;
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
        if self.opencode_recipe.is_some()
            || self.opencode_service.is_some()
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
        if self.picker_master.is_some()
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
