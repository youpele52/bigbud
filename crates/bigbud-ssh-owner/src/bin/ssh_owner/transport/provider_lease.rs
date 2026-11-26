//! W2 T-prov: the production provider probe and lease SSH constructor.

use super::super::PinnedSsh;
use super::{ErrorCode, Transport, process, ssh_failure};
use crate::owner_provider_lease::{self, Kind};
use crate::v1::{ProviderLeaseScope, ProviderVersion};
use std::time::Instant;

/// Exit code of the remote guard when it refused the cwd or the platform.
const GUARD_REFUSED: i32 = 126;

impl Transport {
    /// The target's own pinned trust policy (key or policy CA), `-T`, no
    /// forwarding, no agent-backed identity and no connector route: the same
    /// constructor as the Git upload lease.
    pub(crate) fn pinned_provider_ssh(&self) -> Result<PinnedSsh, ErrorCode> {
        self.pinned_git_upload_ssh()
    }

    /// One bounded `--version` run of the discovered executable. A missing
    /// executable is the typed `ProviderExecutableUnavailable`; a guard refusal
    /// (the cwd, platform, a resume file outside `~/.pi/agent/sessions` or a Codex
    /// home outside the account's home) is `OperationDenied`; any other exit is
    /// reported as observed.
    pub(crate) fn probe_provider_lease(
        &self,
        kind: Kind,
        scope: &ProviderLeaseScope,
        nonce: &str,
    ) -> Result<ProviderVersion, ErrorCode> {
        let (timeout, limit) = kind.probe_bounds();
        let deadline = Instant::now() + timeout;
        let command = owner_provider_lease::remote_command(kind, scope, nonce, false);
        let mut pinned = self.pinned_provider_ssh()?;
        pinned.command.args(["-n", "--", self.host(), &command]);
        let output = process::run_with_combined_output_limit(pinned.command, deadline, 2 * limit)
            .map_err(|failure| match failure {
            process::Failure::TimedOut | process::Failure::Io => ErrorCode::TransportLost,
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
        })?;
        if owner_provider_lease::executable_missing(&output.stderr, nonce) {
            return Err(ErrorCode::ProviderExecutableUnavailable);
        }
        if output.truncated || output.stdout.len() > limit || output.stderr.len() > limit {
            return Err(ErrorCode::InvalidOperands);
        }
        let code = match output.status.code() {
            Some(255) => return Err(ssh_failure(&output.stderr)),
            Some(GUARD_REFUSED) => return Err(ErrorCode::OperationDenied),
            Some(code @ 0..=254) => code,
            _ => return Err(ErrorCode::TransportLost),
        };
        Ok(ProviderVersion {
            code,
            stdout: String::from_utf8(output.stdout).map_err(|_| ErrorCode::ListInvalidOutput)?,
            stderr: String::from_utf8(output.stderr).map_err(|_| ErrorCode::ListInvalidOutput)?,
        })
    }
}
