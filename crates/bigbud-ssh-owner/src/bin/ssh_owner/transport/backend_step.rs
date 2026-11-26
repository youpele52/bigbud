//! W2 T-backend: the pinned transport and bounded child run for production
//! deployment steps and client relay channels.

use super::process::{self, PickerFailure, ssh_failure};
use super::{ErrorCode, PinnedSsh, Transport};
use std::process::{Command, Stdio};
use std::time::Instant;

/// One settled step child. `Exited` is an ordinary remote exit with both
/// streams drained within their caps; everything that cannot prove that is
/// `Unknown`, and a refusal before the remote command ran is `Refused`.
#[derive(Debug)]
pub(crate) enum StepRun {
    Exited {
        code: u32,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    Cancelled,
    Unknown,
    Refused(ErrorCode),
}

impl Transport {
    /// The target's own pinned trust policy (key or policy CA), `-T`, no
    /// forwarding, no agent-backed identity and no connector route, with a
    /// 15 s dead-peer bound. This is the U15 Git upload constructor: both
    /// lanes need exactly the same pinned, forward-free child.
    pub(crate) fn pinned_backend_ssh(&self) -> Result<PinnedSsh, ErrorCode> {
        self.pinned_git_upload_ssh()
    }
}

/// Run one step child to a settled result. Cancellation and the deadline kill
/// the child's process group; an unconfirmed reap is `Unknown`.
pub(crate) fn run_backend_step(
    command: &mut Command,
    stdin: Stdio,
    deadline: Instant,
    stdout_limit: usize,
    cancelled: impl Fn() -> bool,
) -> StepRun {
    match process::run_streamed_cancellable(command, stdin, deadline, stdout_limit, cancelled) {
        Ok(output) if output.truncated => StepRun::Unknown,
        Ok(output) => match output.status.code() {
            // OpenSSH's own failure: a lost transport cannot prove the remote
            // step did not run; any other failure happened before it ran.
            Some(255) => match ssh_failure(&output.stderr) {
                ErrorCode::TransportLost => StepRun::Unknown,
                failure => StepRun::Refused(failure),
            },
            Some(code @ 0..=254) => StepRun::Exited {
                code: code.unsigned_abs(),
                stdout: output.stdout,
                stderr: output.stderr,
            },
            _ => StepRun::Unknown,
        },
        Err(PickerFailure::Cancelled) => StepRun::Cancelled,
        Err(PickerFailure::Process(process::Failure::Spawn)) => {
            StepRun::Refused(ErrorCode::OwnerUnavailable)
        }
        Err(PickerFailure::CleanupUnconfirmed | PickerFailure::Process(_)) => StepRun::Unknown,
    }
}
