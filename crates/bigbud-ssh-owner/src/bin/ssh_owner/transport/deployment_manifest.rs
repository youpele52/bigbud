//! Fixture-only manifest put; not an artifact transfer or install operation.

use std::path::Path;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::{ErrorCode, Transport, deployment_stage::FixtureRoot, process, ssh_failure};

const SCRIPT: &str = include_str!("deployment_manifest/put.sh");
const MARKER: &[u8] = b"manifest-stored\n";
const STDERR_MAX: usize = 16 * 1024;
pub(in super::super) const MAX_MANIFEST_BYTES: usize = 48 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in super::super) struct ManifestOperands<'a> {
    pub request_id: &'a str,
    pub manifest_sha256: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in super::super) enum PutResult {
    Stored,
    InputMismatch,
    FixtureUnavailable,
    Conflict,
    WriteFailed,
}

impl Transport {
    /// The caller supplies the trusted startup root and approval, and may dispatch
    /// once, only after this exact request's `Staged` acknowledgement. This leaf
    /// checks the on-disk stage, not whether the caller owns its begin receipt.
    /// After `OutcomeUnknown`, do not automatically replay.
    pub(in super::super) fn put_graph_manifest(
        &self,
        trusted_root: &Path,
        requested: ManifestOperands<'_>,
        approved: ManifestOperands<'_>,
        contents: &[u8],
    ) -> Result<PutResult, ErrorCode> {
        let remote = command(trusted_root, requested, approved, contents)?;
        self.revalidate_policy()?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut pinned = self.pinned_ssh("-T")?;
        pinned.command.args(["--", &self.host, &remote]);
        let output = process::run_with_input(pinned.command, deadline, MARKER.len(), contents)
            .map_err(|error| match error {
                process::Failure::Spawn => ErrorCode::OwnerUnavailable,
                process::Failure::Io | process::Failure::TimedOut => ErrorCode::OutcomeUnknown,
            })?;
        decode(output)
    }
}

fn command(
    trusted_root: &Path,
    requested: ManifestOperands<'_>,
    approved: ManifestOperands<'_>,
    contents: &[u8],
) -> Result<String, ErrorCode> {
    if requested != approved {
        return Err(ErrorCode::OperationDenied);
    }
    FixtureRoot::new(trusted_root)?;
    let root = trusted_root.to_str().ok_or(ErrorCode::ConfigUnsupported)?;
    let ManifestOperands {
        request_id,
        manifest_sha256,
    } = requested;
    let size = contents.len();
    if !valid_request_id(request_id) || !valid_manifest_payload(manifest_sha256, contents) {
        return Err(ErrorCode::InvalidOperands);
    }
    // Only the fixed script and validated ASCII operands enter argv. Manifest
    // bytes bypass shell interpretation and are delivered on stdin with EOF.
    Ok(format!(
        "/bin/sh -c '{}' sh '{root}' '{request_id}' '{manifest_sha256}' '{size}'",
        SCRIPT.replace('\'', "'\\''"),
    ))
}

pub(in super::super) fn valid_manifest_payload(manifest_sha256: &str, contents: &[u8]) -> bool {
    (1..=MAX_MANIFEST_BYTES).contains(&contents.len())
        && format!("{:x}", Sha256::digest(contents)) == manifest_sha256
}

fn valid_request_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
        })
}

fn decode(output: process::Output) -> Result<PutResult, ErrorCode> {
    // The shared input runner flags stdout truncation but only retains a fixed
    // prefix of stderr. Treat a completely filled stderr budget as ambiguous.
    if output.truncated || output.stderr.len() >= STDERR_MAX {
        return Err(ErrorCode::OutcomeUnknown);
    }
    match (output.status.code(), output.stdout.as_slice()) {
        (Some(0), MARKER) => Ok(PutResult::Stored),
        (Some(65), b"") => Ok(PutResult::InputMismatch),
        (Some(70), b"") => Ok(PutResult::FixtureUnavailable),
        (Some(73), b"") => Ok(PutResult::Conflict),
        (Some(74), b"") => Ok(PutResult::WriteFailed),
        (Some(255), b"") => match ssh_failure(&output.stderr) {
            // Keep trust/auth failures distinct; a lost transport cannot prove
            // that the remote exclusive link didn't happen.
            ErrorCode::TransportLost => Err(ErrorCode::OutcomeUnknown),
            failure => Err(failure),
        },
        _ => Err(ErrorCode::OutcomeUnknown),
    }
}

#[cfg(test)]
mod tests;
