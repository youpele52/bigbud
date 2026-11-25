use std::time::{Duration, Instant};

use super::{ErrorCode, Transport, process, ssh_failure};
use crate::v1::ProofProviderVersion;

impl Transport {
    /// Caller must supply only the command from the startup-bound provider recipe.
    pub(in super::super) fn probe_bound_provider(
        &self,
        recipe: &str,
        timeout: Duration,
        stream_limit: usize,
    ) -> Result<ProofProviderVersion, ErrorCode> {
        self.revalidate_policy()?;
        let deadline = Instant::now() + timeout;
        let mut pinned = self.pinned_ssh("-T")?;
        pinned.command.args(["-n", "--", self.host(), recipe]);
        let output =
            process::run_with_combined_output_limit(pinned.command, deadline, 2 * stream_limit)
                .map_err(|failure| match failure {
                    process::Failure::TimedOut | process::Failure::Io => ErrorCode::TransportLost,
                    process::Failure::Spawn => ErrorCode::OwnerUnavailable,
                })?;
        if output.truncated
            || output.stdout.len() > stream_limit
            || output.stderr.len() > stream_limit
        {
            return Err(ErrorCode::InvalidOperands);
        }
        let code = match output.status.code() {
            Some(255) => return Err(ssh_failure(&output.stderr)),
            Some(code @ 0..=254) => code,
            _ => return Err(ErrorCode::TransportLost),
        };
        Ok(ProofProviderVersion {
            code: Some(code),
            stdout: String::from_utf8(output.stdout).map_err(|_| ErrorCode::ListInvalidOutput)?,
            stderr: String::from_utf8(output.stderr).map_err(|_| ErrorCode::ListInvalidOutput)?,
        })
    }
}
