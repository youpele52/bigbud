//! Per-target live-lane state (W3.7 follow-up).
//!
//! Masters, PTY, agent proxy and OpenCode leases belong to exactly one resolved
//! target. They live beside the target's transport, trust, storage and reconnect
//! state and move in and out with it, so two targets can hold independent leases
//! at the same time and a teardown for one target cannot reach another's.
//!
//! Nothing here dials or spawns on its own; it is the storage and the checked
//! teardown for leases created by the existing lane implementations.

use super::ErrorCode;
use crate::Token;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::owner::opencode;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::owner::posix_picker;
use crate::owner::terminal;
use crate::owner_agent_proxy::AgentProxy;

/// The exact target and generation a live lease belongs to. A stale generation
/// or a different target cannot attach to, replay or close the lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LeaseScope {
    target: String,
    generation: Token,
}

impl LeaseScope {
    pub(crate) fn new(target: &str, generation: Token) -> Self {
        Self {
            target: target.to_owned(),
            generation,
        }
    }

    pub(crate) fn admits(&self, target: &str, generation: Token) -> bool {
        self.target == target && self.generation == generation
    }
}

/// Live leases owned by one target. Drop order is not relied on: every owner
/// path that retires a target calls [`Lanes::revoke`] and reports uncertainty.
#[derive(Default)]
pub(crate) struct Lanes {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) master: Option<posix_picker::MasterPicker>,
    pub(crate) terminal: Option<terminal::LiveTerminal>,
    pub(crate) preparation: Option<terminal::TerminalPreparation>,
    /// Terminal writes are ambiguous until positively settled.
    pub(crate) terminal_uncertain: bool,
    pub(crate) agent_proxy: Option<AgentProxy>,
    pub(crate) agent_close_uncertain: bool,
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) opencode: Option<opencode::Lease>,
}

impl Lanes {
    /// True while this target's PTY writes cannot be resolved. A refusal for one
    /// target never becomes a refusal for another.
    pub(crate) fn terminal_uncertain(&self) -> bool {
        self.terminal_uncertain
    }

    /// Confirmed teardown of every live lease this target owns. One failed reap
    /// cannot skip the others; the first error is returned after all attempts.
    pub(crate) fn revoke(&mut self) -> Result<(), ErrorCode> {
        let terminal = self.revoke_terminal();
        let agent = self.revoke_agent_proxy();
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let opencode = self.revoke_opencode();
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let opencode = Ok(());
        let master = self.revoke_master();
        terminal.and(agent).and(opencode).and(master)
    }

    pub(crate) fn revoke_terminal(&mut self) -> Result<(), ErrorCode> {
        if let Some(terminal) = self.terminal.as_ref() {
            self.terminal_uncertain = true;
            terminal.revoke()?;
            self.terminal = None;
            self.terminal_uncertain = false;
            self.preparation = None;
        }
        if self.terminal_uncertain {
            return Err(ErrorCode::OutcomeUnknown);
        }
        Ok(())
    }

    /// A changed target policy drops this target's cached transport and lanes.
    /// In production a confirmed reap also clears the old trust fault so the
    /// newly resolved policy can open a lease under the same generation. Fixture
    /// lanes keep their prior pause, exactly as before.
    pub(crate) fn invalidate_transport(&mut self) {
        let revoked = self.revoke();
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if revoked.is_ok()
            && let Some(master) = &mut self.master
        {
            master.reset_after_policy_change();
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = revoked;
    }

    pub(crate) fn revoke_agent_proxy(&mut self) -> Result<(), ErrorCode> {
        let Some(proxy) = self.agent_proxy.as_mut() else {
            return if self.agent_close_uncertain {
                Err(ErrorCode::OutcomeUnknown)
            } else {
                Ok(())
            };
        };
        self.agent_close_uncertain = true;
        let result = proxy.close(true, 2_000).map(|_| ());
        if result.is_ok() {
            self.agent_close_uncertain = false;
        }
        result
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn revoke_opencode(&mut self) -> Result<(), ErrorCode> {
        self.opencode
            .as_mut()
            .map_or(Ok(()), |lease| lease.retire())
    }

    fn revoke_master(&mut self) -> Result<(), ErrorCode> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if let Some(master) = &mut self.master {
            return master.retire();
        }
        Ok(())
    }
}
