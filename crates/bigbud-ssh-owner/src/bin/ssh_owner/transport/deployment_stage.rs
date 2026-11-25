//! Fixture-only `begin`; intentionally not a deployment or a legacy stage reset.

use std::path::Path;
use std::time::{Duration, Instant};

use super::{ErrorCode, Transport, process, ssh_failure};

const SCRIPT: &str = include_str!("deployment_stage/begin.sh");
const STDOUT_MAX: usize = 1024;
const STDERR_MAX: usize = 16 * 1024;
const FIXTURE_PREFIX: &str = "/tmp/bigbud-picker-linux-";
const FIXTURE_LEAF: &str = "/deployment-graphs";

/// Supplied by trusted proof startup, never by a wire operand. The path is on the SSH host.
#[derive(Debug)]
pub(in super::super) struct FixtureRoot(String);

impl FixtureRoot {
    pub(in super::super) fn new(path: &Path) -> Result<Self, ErrorCode> {
        let path = path.to_str().ok_or(ErrorCode::ConfigUnsupported)?;
        let suffix = path
            .strip_prefix(FIXTURE_PREFIX)
            .and_then(|rest| rest.strip_suffix(FIXTURE_LEAF))
            .ok_or(ErrorCode::ConfigUnsupported)?;
        if !(1..=64).contains(&suffix.len()) || !suffix.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(ErrorCode::ConfigUnsupported);
        }
        Ok(Self(path.to_owned()))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in super::super) struct StageOperands<'a> {
    pub request_id: &'a str,
    pub install_name: &'a str,
    pub archive_sha256: &'a str,
    pub manifest_sha256: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in super::super) enum BeginResult {
    /// Created an empty private directory for this request.
    Staged,
    /// Observed the exact completion receipt, not independently verified artifact contents.
    Present,
    /// An existing install or stage could not be accepted; no repair was attempted.
    Conflict,
    /// The pre-created disposable root was missing, unsafe, or unwritable.
    FixtureUnavailable,
}

impl Transport {
    /// `approved` must come from the trusted launch/approval context, not from the request.
    /// Timeout or transport loss leaves stage creation unknown; do not retry automatically.
    pub(in super::super) fn begin_graph_stage(
        &self,
        root: &FixtureRoot,
        requested: StageOperands<'_>,
        approved: StageOperands<'_>,
    ) -> Result<BeginResult, ErrorCode> {
        let remote = command(root, requested, approved)?;
        self.revalidate_policy()?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut pinned = self.pinned_ssh("-T")?;
        pinned.command.args(["-n", "--", &self.host, &remote]);
        let output = process::run_with_combined_output_limit(
            pinned.command,
            deadline,
            STDOUT_MAX + STDERR_MAX,
        )
        .map_err(|error| match error {
            process::Failure::TimedOut => ErrorCode::ProofDeploymentTimeout,
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            process::Failure::Io => ErrorCode::TransportLost,
        })?;
        decode(output)
    }
}

fn command(
    root: &FixtureRoot,
    requested: StageOperands<'_>,
    approved: StageOperands<'_>,
) -> Result<String, ErrorCode> {
    if requested != approved {
        return Err(ErrorCode::OperationDenied);
    }
    let StageOperands {
        request_id,
        install_name,
        archive_sha256,
        manifest_sha256,
    } = requested;
    if !valid_request_id(request_id)
        || !valid_digest(archive_sha256)
        || !valid_digest(manifest_sha256)
        || archive_sha256
            .get(..16)
            .is_none_or(|prefix| !valid_install_name(install_name, prefix))
    {
        return Err(ErrorCode::InvalidOperands);
    }
    // The root and each operand are already restricted to ASCII without shell metacharacters.
    Ok(format!(
        "/bin/sh -c '{}' sh '{}' '{request_id}' '{install_name}' '{archive_sha256}' '{manifest_sha256}'",
        SCRIPT.replace('\'', "'\\''"),
        root.0,
    ))
}

fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(lower_hex)
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

fn valid_install_name(name: &str, archive_prefix: &str) -> bool {
    const TARGET_SUFFIXES: [&str; 4] = [
        "-x86_64-unknown-linux-musl",
        "-aarch64-unknown-linux-musl",
        "-x86_64-unknown-linux-gnu",
        "-aarch64-unknown-linux-gnu",
    ];
    let Some((name, digest)) = name.rsplit_once('-') else {
        return false;
    };
    digest == archive_prefix
        && TARGET_SUFFIXES.iter().any(|target| {
            name.strip_suffix(target).is_some_and(|version| {
                (1..=64).contains(&version.len())
                    && version
                        .as_bytes()
                        .first()
                        .is_some_and(u8::is_ascii_alphanumeric)
                    && version.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-')
                    })
            })
        })
}

fn decode(output: process::Output) -> Result<BeginResult, ErrorCode> {
    if output.truncated || output.stdout.len() > STDOUT_MAX || output.stderr.len() > STDERR_MAX {
        return Err(ErrorCode::ProofDeploymentOutputLimit);
    }
    match (output.status.code(), output.stdout.as_slice()) {
        (Some(0), b"staged\n") => Ok(BeginResult::Staged),
        (Some(0), b"present\n") => Ok(BeginResult::Present),
        (Some(70), b"") => Ok(BeginResult::FixtureUnavailable),
        (Some(73), b"") => Ok(BeginResult::Conflict),
        (Some(255), _) => Err(ssh_failure(&output.stderr)),
        (None, _) => Err(ErrorCode::TransportLost),
        _ => Err(ErrorCode::ListInvalidOutput),
    }
}

#[cfg(test)]
mod tests;
