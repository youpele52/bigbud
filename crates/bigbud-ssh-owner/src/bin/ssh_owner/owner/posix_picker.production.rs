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
}
