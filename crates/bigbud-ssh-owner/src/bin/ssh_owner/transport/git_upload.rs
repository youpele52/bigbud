use super::{ErrorCode, HostVerification, PinnedSsh, Transport};
use std::time::{Duration, Instant};

/// Bound for resolving an alias policy's host certificate authority.
const CA_DEADLINE: Duration = Duration::from_secs(8);

impl Transport {
    /// U15 Git upload lease: the target's own pinned trust policy (key or
    /// policy CA), no forwarding, no agent-backed identity, no connector route.
    pub(in super::super) fn pinned_git_upload_ssh(&self) -> Result<PinnedSsh, ErrorCode> {
        if self.proof_agent.is_some() || self.config.dev_interactive_terminal {
            return Err(ErrorCode::ConfigUnsupported);
        }
        self.revalidate_policy()?;
        let mut pinned = match self.host_verification() {
            HostVerification::Ed25519Key => self.pinned_ssh_with_timers("-T", None, false)?,
            verification @ HostVerification::Ed25519Certificate => {
                let ca = self.certificate_authority(Instant::now() + CA_DEADLINE)?;
                self.ssh_for_pin("-T", None, false, &ca, verification)?
            }
        };
        for option in [
            "EscapeChar=none",
            "ServerAliveInterval=5",
            "ServerAliveCountMax=3",
        ] {
            pinned.command.args(["-o", option]);
        }
        Ok(pinned)
    }
}
