use std::io::{Read, Write};

use super::{ErrorCode, Owner, Pipe, RunResult};
use crate::v1::{Connection, ConnectionState, reply::Outcome};

impl Owner {
    pub(super) fn revoke_network_leases(&mut self) -> Result<(), ErrorCode> {
        // One failed local reap cannot skip the other owned transport's cleanup.
        let terminal = self.revoke_terminal();
        let agent = self.revoke_agent_proxy();
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let opencode = self.revoke_opencode();
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let opencode = Ok(());
        let picker = self.retire_picker_master();
        terminal.and(agent).and(opencode).and(picker)
    }

    /// A writer handoff or a launcher retirement is owner-wide: every target's
    /// leases are torn down. A durable Disconnect stays per-target and uses
    /// [`Owner::revoke_network_leases`] for the bound target only.
    pub(super) fn revoke_all_network_leases(&mut self) -> Result<(), ErrorCode> {
        let active = self.revoke_network_leases();
        let cached = self.targets.revoke_cached_lanes();
        active.and(cached)
    }

    pub(super) fn transition<R: Read, W: Write>(
        &mut self,
        pipe: &mut Pipe<R, W>,
        id: &[u8],
        disconnected: bool,
    ) -> RunResult<Result<Outcome, ErrorCode>> {
        #[cfg(target_os = "linux")]
        if let Some(picker) = &mut self.jump_picker {
            picker.revoke_challenge();
        }
        if !disconnected {
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            if self.opencode_prevents_connect() {
                return Ok(Err(ErrorCode::OperationDenied));
            }
            // A redundant Connect must not orphan a live or retained lease by
            // changing its generation without first retiring it explicitly.
            if self.lanes.terminal.is_some() {
                return Ok(Err(ErrorCode::OperationDenied));
            }
            if let Some(proxy) = self.lanes.agent_proxy.as_mut() {
                match proxy.status() {
                    Ok(status) if status.closed => {}
                    Ok(_) => return Ok(Err(ErrorCode::OperationDenied)),
                    Err(_) => return Ok(Err(ErrorCode::OutcomeUnknown)),
                }
            }
        }
        if !disconnected && let Err(error) = self.retire_picker_master() {
            return Ok(Err(error));
        }
        let result = self
            .storage
            .transition(pipe, &self.target, id, disconnected)?;
        self.grants.revoke_pending();
        self.trust.revoke();
        self.lanes.preparation = None;
        Ok(result.and_then(|generation| {
            // The durable transition already happened. Fence old requests even if
            // cleanup cannot positively confirm the reap; never acknowledge success then.
            self.generation = generation;
            self.reset_guarded_write();
            self.reconnect.reset();
            if disconnected {
                self.revoke_network_leases()?;
            }
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            if let Some(master) = &mut self.lanes.master {
                master.transition_committed();
            }
            #[cfg(target_os = "linux")]
            if let Some(picker) = &mut self.jump_picker {
                picker.transition_committed();
            }
            let state = if disconnected {
                ConnectionState::Disconnected
            } else {
                ConnectionState::Connected
            };
            Ok(Outcome::Connection(Connection {
                state: state.into(),
            }))
        }))
    }
}
