//! Production master picker lane (W3.7 providers).
//!
//! The production lane has no disposable fixture and no pinned loopback target.
//! It validates the bound system image and the target's own policy, allocates
//! the control path under the owner's state root and reuses the checked master
//! slot after the first list.

use super::{
    ErrorCode, Folders, Instant, MasterMode, MasterPicker, PICKER_DEADLINE, Token, Transport,
};
use crate::owner::retirement::Retirement;
use crate::transport::posix_master::AgentIo;
use std::path::PathBuf;

impl MasterPicker {
    /// Production lane for one resolved target. The control path is allocated
    /// under `root`, which bootstrap has already verified as owner-private.
    pub(in super::super) fn production(root: PathBuf, retirement: Option<Retirement>) -> Self {
        Self {
            slot: crate::transport::posix_master::PosixMasterSlot::new(retirement),
            mode: MasterMode::Production,
            production_root: Some(root),
            ..Self::default()
        }
    }

    /// Fixture lanes restrict the owner to list/trust verbs while a master is
    /// live. Production serves a terminal and a folder list side by side.
    pub(in super::super) fn restricts_admission(&self) -> bool {
        matches!(self.mode, MasterMode::Fixture(_))
    }

    #[cfg(test)]
    pub(in super::super) fn test_live_pid(&mut self) -> Option<u32> {
        self.slot.test_live_pid()
    }

    /// Policy invalidation for a production target only. The disposable fixture
    /// keeps its existing trust pause until an explicit Connect.
    pub(in super::super) fn reset_after_policy_change(&mut self) {
        if matches!(self.mode, MasterMode::Production) {
            self.transition_committed();
        }
    }

    pub(super) fn list_production(
        &mut self,
        transport: &Transport,
        generation: Token,
        path: Option<&str>,
    ) -> Result<Folders, ErrorCode> {
        let deadline = Instant::now() + PICKER_DEADLINE;
        let root = self
            .production_root
            .as_deref()
            .ok_or(ErrorCode::OwnerUnavailable)?;
        self.slot
            .open_and_list_production_folders(transport, generation, path, deadline, root)
    }

    /// v1.credential.proto: open this target's master with an in-app secret.
    /// The fixture lanes keep their own synthetic unlock and refuse this.
    pub(crate) fn unlock_credential(
        &mut self,
        transport: &Transport,
        generation: Token,
        passphrase: bool,
        secret: &mut [u8],
    ) -> Result<(), ErrorCode> {
        if !matches!(self.mode, MasterMode::Production) {
            for byte in secret.iter_mut() {
                *byte = 0;
            }
            return Err(ErrorCode::OperationDenied);
        }
        self.admit(generation)?;
        let deadline = Instant::now() + PICKER_DEADLINE;
        let root = self
            .production_root
            .as_deref()
            .ok_or(ErrorCode::OwnerUnavailable)?;
        let result = self.slot.unlock_production_credential(
            transport, generation, passphrase, secret, deadline, root,
        );
        // A refused secret is not a transport fault or a retry trigger.
        let observed = result
            .as_ref()
            .err()
            .copied()
            .filter(|error| *error != ErrorCode::CredentialRejected);
        self.record_observation(generation, observed);
        result
    }

    /// Closes this target's credential master; later leases need a new entry.
    pub(crate) fn lock_credential(&mut self, generation: Token) -> Result<(), ErrorCode> {
        if !matches!(self.mode, MasterMode::Production) {
            return Err(ErrorCode::OperationDenied);
        }
        self.slot.invalidate(generation)
    }

    /// Open one per-target agent session over the target's verified master. The
    /// master is reused across folder lists and agent sessions; only this
    /// session's control stream and private pipes belong to the caller.
    pub(crate) fn open_production_agent_session(
        &mut self,
        transport: &Transport,
        generation: Token,
        command: &str,
    ) -> Result<(u32, AgentIo), ErrorCode> {
        self.admit(generation)?;
        let deadline = Instant::now() + PICKER_DEADLINE;
        let root = self
            .production_root
            .as_deref()
            .ok_or(ErrorCode::OwnerUnavailable)?;
        let result = self
            .slot
            .open_production_agent_session(transport, generation, command, deadline, root);
        self.record_observation(generation, result.as_ref().err().copied());
        result
    }
}
