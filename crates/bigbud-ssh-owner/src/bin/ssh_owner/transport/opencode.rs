use super::{ErrorCode, PinnedSsh, Transport};

impl Transport {
    /// Only the fixed OpenCode worker can add its owner-selected forwarding socket.
    pub(in super::super) fn pinned_opencode_ssh(&self) -> Result<PinnedSsh, ErrorCode> {
        if self.policy.is_some()
            || self.proof_agent.is_some()
            || self.config.dev_interactive_terminal
        {
            return Err(ErrorCode::ConfigUnsupported);
        }
        self.revalidate_policy()?;
        let mut pinned = self.pinned_ssh_with_timers("-T", None, true)?;
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
