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
use crate::owner::posix_picker;
use crate::owner::terminal;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use crate::owner::{git_upload, opencode, shell_lease};
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
    /// U15 production Git upload lease (one per target).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) git_upload: Option<git_upload::Lease>,
    /// W2 T-shell production exec leases (bounded per target).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) shell: shell_lease::Leases,
    /// W2 T-backend deployment step and client relay leases.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) backend: crate::owner::backend::BackendLanes,
    /// U25 remote-agent control leases (bounded per target).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) agent_control: crate::owner::agent_control::AgentControlLanes,
    /// W2 T-prov production Pi/Codex provider leases (bounded per target).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) providers: crate::owner::provider_lease::Leases,
    /// U15 production Git receive (push) lease (one per target).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) git_receive: Option<crate::owner::git_receive::Lease>,
    /// W2 T-files production guarded-write lane (in-memory draft, no process).
    pub(crate) guarded_write: Option<crate::owner::guarded_write::GuardedWrite>,
    /// W7 workspace-mode observation: single use, bound to this target's
    /// generation and root, so another target's inspection cannot consume it.
    pub(in crate::owner) workspace_mode: Option<crate::owner::workspace_mode::Observation>,
    /// In-app credential entry channel and bounded attempts (v1.credential.proto).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) credential: crate::owner::credential::CredentialLane,
}

impl Lanes {
    /// True while this target's PTY writes cannot be resolved. A refusal for one
    /// target never becomes a refusal for another.
    pub(crate) fn terminal_uncertain(&self) -> bool {
        self.terminal_uncertain
    }

    /// Live control masters and lease records this target holds, counted for the
    /// drain's owner-shutdown report before [`Lanes::revoke`] tears them down.
    pub(crate) fn shutdown_counts(&self) -> (usize, usize) {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let masters = usize::from(
            self.master
                .as_ref()
                .is_some_and(posix_picker::MasterPicker::has_live_master),
        );
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let masters = 0;
        let mut leases =
            usize::from(self.terminal.is_some()) + usize::from(self.agent_proxy.is_some());
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            leases += usize::from(self.opencode.is_some())
                + usize::from(self.git_upload.is_some())
                + usize::from(self.git_receive.is_some())
                + self.shell.len()
                + self.backend.len()
                + self.agent_control.len()
                + self.providers.len();
        }
        (masters, leases)
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
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let git_upload = self
            .git_upload
            .as_mut()
            .map_or(Ok(()), git_upload::Lease::retire);
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let git_upload = Ok(());
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let shell = self.shell.revoke();
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let shell = Ok(());
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let backend = self.backend.revoke().and(self.agent_control.revoke());
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let backend = Ok(());
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let providers = self.providers.revoke();
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let providers = Ok(());
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        let git_receive = self
            .git_receive
            .as_mut()
            .map_or(Ok(()), crate::owner::git_receive::Lease::retire);
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let git_receive = Ok(());
        let master = self.revoke_master();
        terminal
            .and(agent)
            .and(opencode)
            .and(git_upload)
            .and(shell)
            .and(backend)
            .and(providers)
            .and(git_receive)
            .and(master)
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
