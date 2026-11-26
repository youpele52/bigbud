use super::{ErrorCode, HostVerification, PinnedSsh, Transport};
use std::time::{Duration, Instant};

/// Bound for resolving an alias policy's host certificate authority.
const CA_DEADLINE: Duration = Duration::from_secs(8);

impl Transport {
    /// Only the fixed OpenCode worker can add its owner-selected forwarding socket.
    ///
    /// An `~/.ssh/config` alias target is admitted with the same rule as the
    /// folder-list lane: the alias policy is re-read and compared first, its
    /// resolved host, port, user, identities and host-key alias already live in
    /// this transport, and a certificate-verified host uses the policy's CA.
    /// Policy timers are not applied: the lease owns its keepalive options.
    /// Agent-backed identities and connector routes stay typed refused.
    pub(in super::super) fn pinned_opencode_ssh(&self) -> Result<PinnedSsh, ErrorCode> {
        if self.proof_agent.is_some() || self.config.dev_interactive_terminal {
            return Err(ErrorCode::ConfigUnsupported);
        }
        self.revalidate_policy()?;
        let mut pinned = match self.host_verification() {
            HostVerification::Ed25519Key => self.pinned_ssh_with_timers("-T", None, true)?,
            verification @ HostVerification::Ed25519Certificate => {
                let ca = self.certificate_authority(Instant::now() + CA_DEADLINE)?;
                self.ssh_for_pin("-T", None, true, &ca, verification)?
            }
        };
        for option in [
            "ExitOnForwardFailure=yes",
            "StreamLocalBindMask=0177",
            "StreamLocalBindUnlink=no",
            "EscapeChar=none",
            "ServerAliveInterval=2",
            "ServerAliveCountMax=2",
        ] {
            pinned.command.args(["-o", option]);
        }
        Ok(pinned)
    }
}
