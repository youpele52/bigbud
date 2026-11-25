//! Exec-class owner verbs. The owner selects the remote program, shell and
//! transport; callers can only name an authorized workspace/cwd and the
//! accepted command text. There is no stdin, environment, PTY or SSH option.

use super::workspace::{validate_path, workspace_command_with_arg};
use super::{ErrorCode, Transport, process, ssh_failure, v1, workspace};
use std::time::Duration;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const ACP_TIMEOUT: Duration = Duration::from_secs(10);
const ACP_OUTPUT_LIMIT: usize = 8 * 1024;
const MAX_COMMAND_BYTES: usize = 64 * 1024;
const MAX_IDENTITY_BYTES: usize = 256;

const SHELL_RECIPE: &str = r#"
[ -d "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
exec /bin/sh -lc "$3"
"#;

const ACP_RECIPE: &str = r#"
[ -d "$target" ] && [ -x "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
exec /bin/pwd
"#;

const PROVIDERS: &[&str] = &[
    "claude",
    "codex",
    "copilot",
    "cursor",
    "devin",
    "opencode",
    "pi",
    "thread-tool",
];

impl Transport {
    pub(crate) fn run_thread_shell(
        &self,
        operand: &v1::ProofRunThreadShell,
    ) -> Result<v1::ProofShellResult, ErrorCode> {
        validate_identity(&operand.thread_id)?;
        validate_command(&operand.command)?;
        let (root, relative) = self.workspace_scope(&operand.workspace_root, &operand.cwd)?;
        self.execute_shell(root, relative, &operand.command, operand.timeout_ms)
    }

    pub(crate) fn run_provider_workspace_shell(
        &self,
        operand: &v1::ProofRunProviderWorkspaceShell,
    ) -> Result<v1::ProofShellResult, ErrorCode> {
        if !PROVIDERS.iter().any(|value| *value == operand.provider) {
            return Err(ErrorCode::InvalidOperands);
        }
        validate_identity(&operand.session_id)?;
        validate_identity(&operand.invocation_id)?;
        validate_command(&operand.command)?;
        let (root, relative) = self.workspace_scope(&operand.workspace_root, &operand.cwd)?;
        self.execute_shell(root, relative, &operand.command, operand.timeout_ms)
    }

    pub(crate) fn run_acp_command(
        &self,
        operand: &v1::ProofRunAcpCommand,
    ) -> Result<v1::ProofAcpCommandResult, ErrorCode> {
        let (root, relative) = self.workspace_scope(&operand.workspace_root, &operand.cwd)?;
        let remote = workspace_command_with_arg(ACP_RECIPE, root, relative, "");
        let output = run(self, remote, ACP_TIMEOUT, ACP_OUTPUT_LIMIT)?;
        match output.status.code() {
            Some(0) => Ok(v1::ProofAcpCommandResult {
                output: output.stdout,
                exit_code: 0,
                truncated: output.truncated,
            }),
            Some(3) => Err(ErrorCode::WorkspacePathDenied),
            Some(255) => Err(ssh_failure(&output.stderr)),
            None => Err(ErrorCode::TransportLost),
            _ => Err(ErrorCode::WorkspaceReadFailed),
        }
    }

    fn workspace_scope<'a>(
        &'a self,
        requested_root: &str,
        cwd: &'a str,
    ) -> Result<(&'a str, &'a str), ErrorCode> {
        let root_path = self.config.workspace_root.as_deref();
        let root = root_path
            .and_then(workspace::configured_root)
            .ok_or(ErrorCode::WorkspacePathDenied)?;
        let relative = if cwd == root {
            ""
        } else {
            cwd.strip_prefix(root)
                .and_then(|suffix| suffix.strip_prefix('/'))
                .filter(|part| !part.is_empty())
                .ok_or(ErrorCode::WorkspacePathDenied)?
        };
        validate_path(root_path, requested_root, relative, true)?;
        Ok((root, relative))
    }

    fn execute_shell(
        &self,
        root: &str,
        relative: &str,
        command: &str,
        timeout_ms: u32,
    ) -> Result<v1::ProofShellResult, ErrorCode> {
        let remote = workspace_command_with_arg(SHELL_RECIPE, root, relative, command);
        let timeout = Duration::from_millis(bounded_timeout(timeout_ms));
        let output = run(self, remote, timeout, OUTPUT_LIMIT)?;
        let exit_code = output.status.code().ok_or(ErrorCode::TransportLost)?;
        let mut combined = output.stdout;
        combined.extend_from_slice(&output.stderr);
        Ok(v1::ProofShellResult {
            output: combined,
            exit_code: u32::try_from(exit_code).map_err(|_| ErrorCode::TransportLost)?,
            truncated: output.truncated,
            timed_out: false,
        })
    }
}

fn run(
    transport: &Transport,
    remote: String,
    timeout: Duration,
    limit: usize,
) -> Result<process::Output, ErrorCode> {
    let (pinned, deadline) = workspace::pinned_workspace_command(transport, &remote, timeout)?;
    process::run_with_combined_output_limit(pinned.command, deadline, limit).map_err(|failure| {
        match failure {
            process::Failure::TimedOut => ErrorCode::ShellTimedOut,
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            process::Failure::Io => ErrorCode::TransportLost,
        }
    })
}

fn bounded_timeout(timeout_ms: u32) -> u64 {
    let requested = u64::from(timeout_ms);
    if requested == 0 {
        DEFAULT_TIMEOUT_MS
    } else {
        requested.clamp(1, MAX_TIMEOUT_MS)
    }
}

fn validate_identity(value: &str) -> Result<(), ErrorCode> {
    if value.is_empty() || value.contains('\0') || value.len() > MAX_IDENTITY_BYTES {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(())
}

fn validate_command(command: &str) -> Result<(), ErrorCode> {
    if command.is_empty() || command.contains('\0') || command.len() > MAX_COMMAND_BYTES {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(())
}

#[cfg(test)]
#[path = "shell.tests.rs"]
mod tests;
