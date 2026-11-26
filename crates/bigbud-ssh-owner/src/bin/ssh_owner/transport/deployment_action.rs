//! Typed deployment steps inside the disposable staging root.
//!
//! One fixed script performs archive upload, reset, fetch, publish and backend
//! start. The owner selects the program and every argument; operands are
//! validated data. Dispatch without a confirmed result is `OutcomeUnknown` and
//! must never be replayed.

use std::path::Path;
use std::time::{Duration, Instant};

use super::{ErrorCode, Transport, deployment_stage::FixtureRoot, process, ssh_failure};
use crate::v1::{
    ProofDeploymentAction, ProofDeploymentActionKind, ProofDeploymentHostResult,
    ProofDeploymentOperationState, ProofDeploymentPinnedFile,
};

const SCRIPT: &str = include_str!("deployment_action/step.sh");
const STDOUT_MAX: usize = 256 * 1024;
const STDERR_MAX: usize = 16 * 1024;
const MAX_ARCHIVE_BYTES: usize = 48 * 1024;
const MAX_PINS: usize = 16;
const MAX_FETCH_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_URL: usize = 2048;
const MAX_INSTALL_NAME: usize = 128;
const MARKER_MAX: usize = 16;

impl Transport {
    /// Each step runs the fixed fixture recipe with a per-action deadline and a
    /// 256 KiB stdout cap. A timeout, truncated capture or lost transport is
    /// ambiguous: the caller must not replay and may only reattach by request id.
    pub(in super::super) fn deployment_step(
        &self,
        trusted_root: &Path,
        action: &ProofDeploymentAction,
    ) -> Result<ProofDeploymentHostResult, ErrorCode> {
        let request = command(trusted_root, action)?;
        self.revalidate_policy()?;
        let deadline = Instant::now() + deadline(action.kind());
        let mut pinned = self.pinned_ssh("-T")?;
        pinned
            .command
            .args(["-n", "--", &self.host, &request.remote]);
        let output = match &request.stdin {
            Some(bytes) => {
                process::run_with_input(pinned.command, deadline, request.max_stdout, bytes)
            }
            None => process::run_with_combined_output_limit(
                pinned.command,
                deadline,
                request.max_stdout + STDERR_MAX,
            ),
        }
        .map_err(|error| match error {
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            process::Failure::TimedOut | process::Failure::Io => ErrorCode::OutcomeUnknown,
        })?;
        decode(output, action.kind(), request.marker, request.max_stdout)
    }
}

struct Request {
    remote: String,
    stdin: Option<Vec<u8>>,
    marker: &'static [u8],
    max_stdout: usize,
}

fn deadline(kind: ProofDeploymentActionKind) -> Duration {
    match kind {
        ProofDeploymentActionKind::Fetch => Duration::from_secs(300),
        ProofDeploymentActionKind::Publish => Duration::from_secs(120),
        ProofDeploymentActionKind::Start => Duration::from_secs(300),
        _ => Duration::from_secs(60),
    }
}

fn marker(kind: ProofDeploymentActionKind) -> &'static [u8] {
    match kind {
        ProofDeploymentActionKind::ArchiveUpload => b"archive-stored\n",
        ProofDeploymentActionKind::Reset => b"reset\n",
        ProofDeploymentActionKind::Fetch => b"fetched\n",
        ProofDeploymentActionKind::Publish => b"published\n",
        ProofDeploymentActionKind::Start => b"",
        ProofDeploymentActionKind::Unspecified
        | ProofDeploymentActionKind::Cancel
        | ProofDeploymentActionKind::Reattach => b"",
    }
}

fn command(trusted_root: &Path, action: &ProofDeploymentAction) -> Result<Request, ErrorCode> {
    FixtureRoot::new(trusted_root)?;
    let root = trusted_root.to_str().ok_or(ErrorCode::ConfigUnsupported)?;
    let request_id = action.request_id.as_str();
    if !valid_request_id(request_id) {
        return Err(ErrorCode::InvalidOperands);
    }
    let kind =
        ProofDeploymentActionKind::try_from(action.kind).map_err(|_| ErrorCode::InvalidOperands)?;
    let install = || valid_install_name(&action.install_name);
    let mut operands: Vec<String> = Vec::new();
    let mut stdin = None;
    let mut max_stdout = STDOUT_MAX;
    match kind {
        ProofDeploymentActionKind::ArchiveUpload => {
            if !valid_digest(&action.archive_sha256)
                || action.contents.is_empty()
                || action.contents.len() > MAX_ARCHIVE_BYTES
            {
                return Err(ErrorCode::InvalidOperands);
            }
            operands.push("archive-upload".into());
            operands.push(action.archive_sha256.clone());
            operands.push(action.contents.len().to_string());
            stdin = Some(action.contents.clone());
            max_stdout = MARKER_MAX;
        }
        ProofDeploymentActionKind::Reset => {
            if !install()
                || !valid_digest(&action.archive_sha256)
                || !valid_digest(&action.manifest_sha256)
            {
                return Err(ErrorCode::InvalidOperands);
            }
            operands.push("reset".into());
            operands.push(action.install_name.clone());
            max_stdout = MARKER_MAX;
        }
        ProofDeploymentActionKind::Fetch => {
            if !valid_digest(&action.archive_sha256)
                || !valid_url(&action.url)
                || action.max_bytes == 0
                || action.max_bytes > MAX_FETCH_BYTES
            {
                return Err(ErrorCode::InvalidOperands);
            }
            operands.push("fetch".into());
            operands.push(action.archive_sha256.clone());
            operands.push(action.url.clone());
            operands.push(action.max_bytes.to_string());
            max_stdout = MARKER_MAX;
        }
        ProofDeploymentActionKind::Publish => {
            if !install()
                || !valid_digest(&action.archive_sha256)
                || !valid_digest(&action.manifest_sha256)
                || !valid_graph_path(&action.node_path)
                || !valid_graph_path(&action.entry_path)
                || action.pins.is_empty()
                || action.pins.len() > MAX_PINS
            {
                return Err(ErrorCode::InvalidOperands);
            }
            operands.push("publish".into());
            operands.push(action.install_name.clone());
            operands.push(action.archive_sha256.clone());
            operands.push(action.manifest_sha256.clone());
            operands.push(action.node_path.clone());
            operands.push(action.entry_path.clone());
            for ProofDeploymentPinnedFile { path, sha256 } in &action.pins {
                if !valid_graph_path(path) || !valid_digest(sha256) {
                    return Err(ErrorCode::InvalidOperands);
                }
                operands.push(format!("{path}:{sha256}"));
            }
            max_stdout = MARKER_MAX;
        }
        ProofDeploymentActionKind::Start => {
            if !install()
                || !valid_graph_path(&action.node_path)
                || !valid_graph_path(&action.entry_path)
                || !valid_authority(&action.authority_id)
            {
                return Err(ErrorCode::InvalidOperands);
            }
            operands.push("start".into());
            operands.push(action.install_name.clone());
            operands.push(action.node_path.clone());
            operands.push(action.entry_path.clone());
            operands.push(action.authority_id.clone());
            operands.push(if action.enable_boot { "1" } else { "0" }.into());
        }
        ProofDeploymentActionKind::Unspecified
        | ProofDeploymentActionKind::Cancel
        | ProofDeploymentActionKind::Reattach => return Err(ErrorCode::InvalidOperands),
    }
    // The root and every operand above are restricted to ASCII without shell
    // metacharacters, so single quoting is sufficient here.
    Ok(Request {
        remote: format!(
            "/bin/sh -c '{}' sh '{root}' '{request_id}' {}",
            SCRIPT.replace('\'', "'\\''"),
            operands
                .iter()
                .map(|operand| format!("'{operand}'"))
                .collect::<Vec<_>>()
                .join(" ")
        ),
        stdin,
        marker: marker(kind),
        max_stdout,
    })
}

fn decode(
    output: process::Output,
    kind: ProofDeploymentActionKind,
    marker: &'static [u8],
    stdout_max: usize,
) -> Result<ProofDeploymentHostResult, ErrorCode> {
    if output.truncated || output.stdout.len() > stdout_max || output.stderr.len() > STDERR_MAX {
        return Err(ErrorCode::OutcomeUnknown);
    }
    let code = match output.status.code() {
        Some(255) => match ssh_failure(&output.stderr) {
            // A lost transport cannot prove that the remote step did not run.
            ErrorCode::TransportLost => return Err(ErrorCode::OutcomeUnknown),
            failure => return Err(failure),
        },
        Some(code @ 0..=254) => code,
        _ => return Err(ErrorCode::OutcomeUnknown),
    };
    let stdout = String::from_utf8(output.stdout).map_err(|_| ErrorCode::OutcomeUnknown)?;
    let stderr = String::from_utf8(output.stderr).map_err(|_| ErrorCode::OutcomeUnknown)?;
    let confirmed =
        code == 0 && (kind == ProofDeploymentActionKind::Start || stdout.as_bytes() == marker);
    // A zero exit without its exact marker cannot prove the step's effect.
    if code == 0 && !confirmed {
        return Err(ErrorCode::OutcomeUnknown);
    }
    let state = if confirmed {
        ProofDeploymentOperationState::Completed
    } else {
        ProofDeploymentOperationState::Refused
    };
    Ok(ProofDeploymentHostResult {
        code: Some(code),
        stdout,
        stderr,
        state: state.into(),
    })
}

fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(lower_hex)
}

fn valid_authority(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(lower_hex)
}

fn valid_request_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => lower_hex(byte),
        })
}

fn valid_install_name(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_INSTALL_NAME {
        return false;
    }
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn valid_graph_path(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value
            .split('/')
            .any(|segment| segment == ".." || segment.is_empty())
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-' | b'/')
        })
}

fn valid_url(value: &str) -> bool {
    value.starts_with("https://")
        && value.len() <= MAX_URL
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'.' | b'_'
                        | b'~'
                        | b':'
                        | b'/'
                        | b'?'
                        | b'#'
                        | b'@'
                        | b'!'
                        | b'*'
                        | b'+'
                        | b','
                        | b';'
                        | b'='
                        | b'%'
                        | b'('
                        | b')'
                        | b'['
                        | b']'
                        | b'-'
                )
        })
}

#[cfg(test)]
mod tests;
