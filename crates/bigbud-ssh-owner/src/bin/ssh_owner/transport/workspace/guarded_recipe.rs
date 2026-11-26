//! Private transport for the compiled E2 recipe.

use super::{ErrorCode, Transport, process, workspace::quote};
use sha2::{Sha256, digest::Output};
use std::{
    net::Ipv4Addr,
    path::Path,
    time::{Duration, Instant},
};

const RECIPE: &str =
    include_str!("../../../../../../../protocol/ssh-owner/workspace-write-guarded.py");
const PREFIX: &[u8] = b"BIGBUD_GUARDED_WRITE_V1 ";
const ACK_LIMIT: usize = PREFIX.len() + b"saved inPlace ".len() + 64 + 1;
const WRITE_LIMIT: usize = 512 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);
type Sha256Bytes = [u8; 32];

/// Operands from one fully staged save, never a caller-provided command or tool.
pub(crate) struct StagedWrite<'a> {
    pub(crate) root: &'a str,
    pub(crate) path: &'a str,
    pub(crate) operation_id: &'a str,
    pub(crate) base: &'a Sha256Bytes,
    pub(crate) attempted: &'a Sha256Bytes,
    pub(crate) bytes: &'a [u8],
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Publication {
    Atomic,
    InPlace,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Conflict {
    Missing,
    Changed,
    Hash(Sha256Bytes),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Terminal {
    Request,
    Scope,
    Target,
    Busy,
    Io,
    HostToolUnavailable,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Saved {
        publication: Publication,
        sha256: Sha256Bytes,
    },
    Conflict(Conflict),
    Terminal(Terminal),
    Unknown,
}

/// The owner must be bound to the disposable fixture, and the external
/// coordinator must persist intent before dispatch. Errors are prelaunch only; no
/// error after launching may imply remote termination or authorize replay.
pub(crate) fn execute(
    transport: &Transport,
    write: &StagedWrite<'_>,
) -> Result<Outcome, ErrorCode> {
    // The fixture stays a loopback-only proof. A production target keeps its
    // own trust/identity policy and admits the save's own root (W2 T-files).
    let production = transport.facts.production();
    if transport.proof_agent.is_some()
        || (!production
            && (transport.config.host != Ipv4Addr::LOCALHOST
                || transport.config.port < 1024
                || transport.config.alias_config.is_some()
                || transport.config.system_config.is_some()))
    {
        return Err(ErrorCode::OperationDenied);
    }
    let command = write.command(super::workspace::root_authority(transport, write.root))?;
    transport.revalidate_policy()?;
    let mut pinned = transport.pinned_ssh("-T")?;
    pinned.command.args(["--", &transport.host, &command]);
    match process::run_with_input(
        pinned.command,
        Instant::now() + TIMEOUT,
        ACK_LIMIT,
        write.bytes,
    ) {
        Ok(output) => Ok(write.decode(output)),
        Err(process::Failure::Spawn) => Err(ErrorCode::OwnerUnavailable),
        Err(process::Failure::Io | process::Failure::TimedOut) => Ok(Outcome::Unknown),
    }
}

impl StagedWrite<'_> {
    fn command(&self, approved_root: Option<&Path>) -> Result<String, ErrorCode> {
        if approved_root.and_then(Path::to_str) != Some(self.root)
            || !self
                .root
                .strip_prefix('/')
                .is_some_and(fixture_root_components)
            || !components(self.path)
        {
            return Err(ErrorCode::WorkspacePathDenied);
        }
        if self.operation_id.len() != 32
            || !self
                .operation_id
                .bytes()
                .all(|byte| hex_nibble(byte).is_some())
            || self.bytes.len() > WRITE_LIMIT
        {
            return Err(ErrorCode::InvalidOperands);
        }
        // Quote every argument, including the exact generated root with spaces and punctuation.
        Ok(format!(
            "exec /usr/bin/python3 -I -B -c {} {} {} {} {:x} {:x} {}",
            quote(RECIPE),
            quote(self.root),
            quote(self.path),
            quote(self.operation_id),
            Output::<Sha256>::from(*self.base),
            Output::<Sha256>::from(*self.attempted),
            self.bytes.len(),
        ))
    }

    fn decode(&self, output: process::Output) -> Outcome {
        // The recipe exits 0 for every explicit marker (including uncertainty).
        // Neither stderr nor an exit code by itself can establish an outcome.
        if !output.status.success() || output.truncated || output.stdout.len() > ACK_LIMIT {
            return Outcome::Unknown;
        }
        let Some(marker) = output
            .stdout
            .strip_prefix(PREFIX)
            .and_then(|line| line.strip_suffix(b"\n"))
        else {
            return Outcome::Unknown;
        };
        match marker {
            b"conflict missing" => Outcome::Conflict(Conflict::Missing),
            b"conflict changed" => Outcome::Conflict(Conflict::Changed),
            b"terminal request" => Outcome::Terminal(Terminal::Request),
            b"terminal scope" => Outcome::Terminal(Terminal::Scope),
            b"terminal target" => Outcome::Terminal(Terminal::Target),
            b"terminal busy" => Outcome::Terminal(Terminal::Busy),
            b"terminal io" => Outcome::Terminal(Terminal::Io),
            b"terminal hostToolUnavailable" => Outcome::Terminal(Terminal::HostToolUnavailable),
            _ => self.decode_digest(marker),
        }
    }

    fn decode_digest(&self, marker: &[u8]) -> Outcome {
        if let Some(hex) = marker.strip_prefix(b"conflict ") {
            return match parse_digest(hex) {
                Some(sha256) if sha256 != *self.base => Outcome::Conflict(Conflict::Hash(sha256)),
                _ => Outcome::Unknown,
            };
        }
        let (publication, hex) = if let Some(hex) = marker.strip_prefix(b"saved atomic ") {
            (Publication::Atomic, hex)
        } else if let Some(hex) = marker.strip_prefix(b"saved inPlace ") {
            (Publication::InPlace, hex)
        } else {
            // Covers both the explicit `unknown` and any unrecognized marker.
            return Outcome::Unknown;
        };
        match parse_digest(hex) {
            Some(sha256) if sha256 == *self.attempted => Outcome::Saved {
                publication,
                sha256,
            },
            _ => Outcome::Unknown,
        }
    }
}

fn fixture_root_components(path: &str) -> bool {
    path.len() <= 4095
        && components(
            path.strip_suffix("/picker's folders; literal")
                .unwrap_or(path),
        )
}

// Same narrow operands as the approved recipe; do not normalize or admit the
// broader read-path grammar, nor allow reserved operation evidence paths.
fn components(path: &str) -> bool {
    path.len() <= 4095
        && path.split('/').all(|part| {
            !part.is_empty()
                && part.len() <= 255
                && !matches!(part, "." | "..")
                && !part
                    .get(..8)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case(".bigbud-"))
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn parse_digest(mut hex: &[u8]) -> Option<Sha256Bytes> {
    let mut digest = [0; 32];
    for byte in &mut digest {
        let ([high, low], rest) = hex.split_first_chunk::<2>()?;
        *byte = (hex_nibble(*high)? << 4) | hex_nibble(*low)?;
        hex = rest;
    }
    hex.is_empty().then_some(digest)
}

#[cfg(test)]
#[path = "guarded_recipe.tests.rs"]
mod tests;
