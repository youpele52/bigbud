//! Read-only classification of one retained direct pane binding.
//!
//! The owner never respawns a retained pane. A live reservation is attach-only,
//! an uncertain reservation (`may-have-been-sent` / `outcome-unknown`) is
//! retained as host-lost, and only an explicit trusted termination receipt
//! closes a pane. A malformed binding is unrecoverable and refuses admission.

use super::{Disposition, PANE};
use crate::v1::{ErrorCode, ProofPaneBinding};

const MAX_OWNER_KEY: usize = 4_096;
const MAX_PANE_ID: usize = 4_096;
const MAX_TARGET: usize = 1_024;
const MAX_TOKEN: usize = 128;

pub(super) fn check(
    binding: &ProofPaneBinding,
    owner_epoch: &str,
) -> Result<Disposition, ErrorCode> {
    if binding.owner_key.is_empty()
        || binding.owner_key.len() > MAX_OWNER_KEY
        || binding.lease_id.is_empty()
        || binding.lease_id.len() > MAX_TOKEN
        || binding.owner_epoch.len() > MAX_TOKEN
        || binding.generation.len() > MAX_TOKEN
        || binding.thread_id.len() > MAX_PANE_ID
        || binding.terminal_id.len() > MAX_PANE_ID
        || binding.target_id.is_empty()
        || binding.target_id.len() > MAX_TARGET
        || !matches!(
            binding.state.as_str(),
            "prepared" | "may-have-been-sent" | "outcome-unknown"
        )
    {
        return Err(PANE);
    }
    // A pane identity is both ids or neither (a legacy owner without pane
    // metadata). Half an identity can never be recovered safely.
    if binding.thread_id.is_empty() != binding.terminal_id.is_empty() {
        return Err(PANE);
    }
    // Confirmed termination wins: never reattach and never respawn.
    if binding.terminated {
        return Ok(Disposition::Closed);
    }
    // A prepared reservation that belongs to this exact owner epoch is live:
    // attach to it, do not create another shell.
    if binding.state == "prepared" && binding.owner_epoch == owner_epoch {
        return Ok(Disposition::AttachOnly);
    }
    // Everything else (a foreign epoch, a missing epoch or an uncertain
    // reservation) has unprovable ownership and stays retained as host-lost.
    Ok(Disposition::HostLost)
}
