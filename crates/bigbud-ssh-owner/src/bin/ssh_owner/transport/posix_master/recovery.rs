//! Lease-scoped retirement capability for a surviving native supervisor.
//! The slot (including its Child and path stamps) stays in the supervisor.
//! A replacement caller can request retirement, but cannot adopt the master.
//! Transfer the bearer credential only over authenticated private IPC; do not
//! persist it alongside the fence. Supervisor loss means no recovery authority.

use super::{ErrorCode, PosixMasterSlot, Token, Transport, UNAVAILABLE};
use std::hint::black_box;

pub(super) struct Recovery {
    credential: Token,
    reaped: bool,
}

impl Recovery {
    pub(super) fn record_reap(&mut self) {
        self.reaped = true;
    }

    fn authorizes(&self, presented: &Token, has_child: bool) -> bool {
        // A missing Child is not evidence of retirement. The only exception is
        // a previous positive wait on this Child by this same supervisor, when
        // checked path cleanup failed and retained the closing slot.
        let mut difference = 0;
        for (expected, actual) in self.credential.iter().zip(presented) {
            difference = black_box(difference | (expected ^ actual));
        }
        difference == 0 && (has_child != self.reaped)
    }
}

#[expect(dead_code, reason = "supervisor recovery wiring pending")]
impl PosixMasterSlot {
    /// Trusted bootstrap only, once per live fenced key-based fixture lease.
    /// A caller must not be able to mint a credential on reattachment.
    pub(in super::super::super) fn issue_recovery_credential(
        &mut self,
        transport: &Transport,
        generation: Token,
    ) -> Result<Token, ErrorCode> {
        let master = self.admit(transport, generation)?;
        if master.recovery.is_some() || master.binding.password {
            return Err(UNAVAILABLE);
        }
        master.paths.require_fixture_fence()?;
        master.live_pid()?;
        let credential = crate::random_token().map_err(|_| UNAVAILABLE)?;
        master.recovery = Some(Recovery {
            credential,
            reaped: false,
        });
        Ok(credential)
    }

    /// Retire only the authorized exact lease through the supervisor's retained
    /// Child and checked path cleanup. Success acknowledges local retirement
    /// only. A lost success reply cannot be recovered from a now-empty slot.
    pub(in super::super::super) fn retire_recoverable(
        &mut self,
        generation: Token,
        credential: &Token,
    ) -> Result<(), ErrorCode> {
        let master = self.master.as_ref().ok_or(UNAVAILABLE)?;
        let recovery = master.recovery.as_ref().ok_or(UNAVAILABLE)?;
        if generation != master.binding.generation
            || !recovery.authorizes(credential, master.child.is_some())
        {
            return Err(UNAVAILABLE);
        }
        self.invalidate(generation)
    }
}
