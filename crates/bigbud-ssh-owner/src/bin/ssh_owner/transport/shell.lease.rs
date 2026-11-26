//! Production exec-class leases (W2 T-shell under W3.7).
//!
//! The transport validates the request's own workspace authority, builds the
//! owner-selected remote recipe and pins the target's trust policy. The
//! returned [`ShellLaunch`] owns everything the SSH child needs, so the owner
//! can run it on a worker thread while the target is swapped out. Nothing here
//! accepts stdin, a PTY, an environment, argv or an SSH option.

use super::super::workspace::workspace_command_with_arg;
use super::super::{ErrorCode, HostVerification, PinnedSsh, Transport, process, ssh_failure, v1};
use super::{
    ACP_OUTPUT_LIMIT, ACP_RECIPE, ACP_TIMEOUT, OUTPUT_LIMIT, PROVIDERS, shell_command,
    validate_command, validate_identity,
};
use std::time::{Duration, Instant};

/// Bound for resolving an alias policy's host certificate authority.
const CA_DEADLINE: Duration = Duration::from_secs(8);
const MAX_ROOT_BYTES: usize = 4096;

/// How a settled lease ended. Exit codes of the accepted command are data, not
/// errors; only the owner's own bounds and teardown map to typed failures.
pub(crate) enum ShellRun {
    Exited {
        output: Vec<u8>,
        exit_code: u32,
        truncated: bool,
    },
    TimedOut,
    Cancelled,
    Failed(ErrorCode),
    /// The process group could not be confirmed gone. Never replayed.
    Unconfirmed,
}

/// One fully prepared, owner-selected remote command for a single lease.
pub(crate) struct ShellLaunch {
    pinned: PinnedSsh,
    timeout: Duration,
    limit: usize,
    acp: bool,
}

impl ShellLaunch {
    /// Blocks the calling worker until the command settles, the deadline
    /// passes or `cancelled` reports true; the process group is torn down on
    /// every non-exit path.
    pub(crate) fn run(self, cancelled: impl Fn() -> bool) -> ShellRun {
        let deadline = Instant::now() + self.timeout;
        let result = process::run_with_combined_output_limit_cancellable(
            self.pinned.command,
            deadline,
            self.limit,
            cancelled,
        );
        let output = match result {
            Ok(output) => output,
            Err(process::PickerFailure::Cancelled) => return ShellRun::Cancelled,
            Err(process::PickerFailure::CleanupUnconfirmed) => return ShellRun::Unconfirmed,
            Err(process::PickerFailure::Process(process::Failure::TimedOut)) => {
                return ShellRun::TimedOut;
            }
            Err(process::PickerFailure::Process(process::Failure::Spawn)) => {
                return ShellRun::Failed(ErrorCode::OwnerUnavailable);
            }
            Err(process::PickerFailure::Process(process::Failure::Io)) => {
                return ShellRun::Failed(ErrorCode::TransportLost);
            }
        };
        let Some(code) = output.status.code() else {
            return ShellRun::Failed(ErrorCode::TransportLost);
        };
        if self.acp {
            return match code {
                0 => ShellRun::Exited {
                    output: output.stdout,
                    exit_code: 0,
                    truncated: output.truncated,
                },
                3 => ShellRun::Failed(ErrorCode::WorkspacePathDenied),
                255 => ShellRun::Failed(ssh_failure(&output.stderr)),
                _ => ShellRun::Failed(ErrorCode::WorkspaceReadFailed),
            };
        }
        let Ok(exit_code) = u32::try_from(code) else {
            return ShellRun::Failed(ErrorCode::TransportLost);
        };
        let mut combined = output.stdout;
        combined.extend_from_slice(&output.stderr);
        ShellRun::Exited {
            output: combined,
            exit_code,
            truncated: output.truncated,
        }
    }
}

/// Absolute, normalized, not `/`, bounded, and (for a fixture owner) equal to
/// the startup root. Returns the root and the cwd relative to it.
pub(crate) fn scope<'a>(
    fixture_root: Option<&str>,
    root: &'a str,
    cwd: &'a str,
) -> Result<(&'a str, &'a str), ErrorCode> {
    let normal = |path: &str| {
        path.len() <= MAX_ROOT_BYTES
            && path
                .strip_prefix('/')
                .is_some_and(|rest| rest.split('/').all(|part| !matches!(part, "" | "." | "..")))
            && !path.bytes().any(|byte| byte.is_ascii_control())
    };
    if !normal(root) || !normal(cwd) || fixture_root.is_some_and(|fixed| fixed != root) {
        return Err(ErrorCode::WorkspacePathDenied);
    }
    let relative = if cwd == root {
        ""
    } else {
        cwd.strip_prefix(root)
            .and_then(|rest| rest.strip_prefix('/'))
            .ok_or(ErrorCode::WorkspacePathDenied)?
    };
    Ok((root, relative))
}

/// The shared thread/provider recipe as a lease launch.
fn lease_shell(
    transport: &Transport,
    root: &str,
    relative: &str,
    command: &str,
    timeout_ms: u32,
) -> Result<ShellLaunch, ErrorCode> {
    let (remote, timeout) = shell_command(root, relative, command, timeout_ms);
    transport.launch(remote, timeout, OUTPUT_LIMIT, false)
}

impl Transport {
    pub(in super::super::super) fn thread_shell_launch(
        &self,
        operand: &v1::RunThreadShell,
        production: bool,
    ) -> Result<ShellLaunch, ErrorCode> {
        validate_identity(&operand.thread_id)?;
        validate_command(&operand.command)?;
        let (root, relative) = scope(
            self.fixture_root(production)?,
            &operand.workspace_root,
            &operand.cwd,
        )?;
        lease_shell(self, root, relative, &operand.command, operand.timeout_ms)
    }

    pub(in super::super::super) fn provider_shell_launch(
        &self,
        operand: &v1::RunProviderWorkspaceShell,
        production: bool,
    ) -> Result<ShellLaunch, ErrorCode> {
        if !PROVIDERS.contains(&operand.provider.as_str()) {
            return Err(ErrorCode::InvalidOperands);
        }
        validate_identity(&operand.session_id)?;
        validate_identity(&operand.invocation_id)?;
        validate_command(&operand.command)?;
        let (root, relative) = scope(
            self.fixture_root(production)?,
            &operand.workspace_root,
            &operand.cwd,
        )?;
        lease_shell(self, root, relative, &operand.command, operand.timeout_ms)
    }

    /// U21: one approved ACP `terminal/create` command with the provider-shell
    /// bounds and the shared session guard.
    pub(in super::super::super) fn acp_shell_launch(
        &self,
        operand: &v1::RunAcpShell,
        production: bool,
    ) -> Result<ShellLaunch, ErrorCode> {
        validate_identity(&operand.session_id)?;
        validate_identity(&operand.tool_call_id)?;
        validate_command(&operand.command)?;
        let (root, relative) = scope(
            self.fixture_root(production)?,
            &operand.workspace_root,
            &operand.cwd,
        )?;
        lease_shell(self, root, relative, &operand.command, operand.timeout_ms)
    }

    pub(in super::super::super) fn acp_command_launch(
        &self,
        operand: &v1::RunAcpCommand,
        production: bool,
    ) -> Result<ShellLaunch, ErrorCode> {
        let (root, relative) = scope(
            self.fixture_root(production)?,
            &operand.workspace_root,
            &operand.cwd,
        )?;
        let remote = workspace_command_with_arg(ACP_RECIPE, root, relative, "");
        self.launch(remote, ACP_TIMEOUT, ACP_OUTPUT_LIMIT, true)
    }

    /// A fixture owner admits only its startup root; production takes the
    /// request's own root (chosen by the server for that exact target).
    fn fixture_root(&self, production: bool) -> Result<Option<&str>, ErrorCode> {
        if production {
            return Ok(None);
        }
        self.config
            .workspace_root
            .as_deref()
            .and_then(std::path::Path::to_str)
            .map(Some)
            .ok_or(ErrorCode::WorkspacePathDenied)
    }

    fn launch(
        &self,
        remote: String,
        timeout: Duration,
        limit: usize,
        acp: bool,
    ) -> Result<ShellLaunch, ErrorCode> {
        let mut pinned = self.pinned_shell_ssh()?;
        pinned.command.args(["--", &self.host, &remote]);
        Ok(ShellLaunch {
            pinned,
            timeout,
            limit,
            acp,
        })
    }

    /// The target's own pinned trust policy (key or policy CA), no forwarding,
    /// no agent-backed identity and no connector route.
    fn pinned_shell_ssh(&self) -> Result<PinnedSsh, ErrorCode> {
        if self.proof_agent.is_some() {
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

#[cfg(test)]
#[path = "shell.lease.tests.rs"]
mod tests;
