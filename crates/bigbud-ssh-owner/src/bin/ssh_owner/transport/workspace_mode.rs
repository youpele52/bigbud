//! Workspace reservation inspection and publication over an exact pinned SSH route.

mod publish;
mod wire;

use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::{ErrorCode, Transport, process, ssh_failure, workspace::configured_root};

const SCRIPT: &str = include_str!("workspace_mode/inspect.sh");
const MARKER: &str = "bigbud.workspace-mode.inspect.v1";
const TIMEOUT: Duration = Duration::from_secs(15);
const ATTEMPTS: usize = 4;
const ROOT_MAX: usize = 4096;
const RECORD_MAX: usize = 1024;
const OUTPUT_MAX: usize = 256 + ROOT_MAX + RECORD_MAX + 1;
const STDERR_MAX: usize = 16 * 1024;
const MAX_GENERATION: u64 = (1 << 53) - 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in super::super) enum Inspection {
    Ready {
        physical_root: String,
        host_identity: String,
        account_uid: u32,
        realpath_sha256: String,
        generation: u64,
        current_record: Option<String>,
    },
    NotLinux,
    NoMachineId,
    MissingFolder,
    UnsafeStorage,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in super::super) enum Publication {
    Committed,
    Conflict,
    Uncertain,
    NotLinux,
    NoMachineId,
    MissingFolder,
    UnsafeStorage,
    ScopeChanged,
}

impl Transport {
    /// The dispatcher must first admit the exact target and inspect grant in the current owner
    /// generation. This transport is bound to that approved destination and startup root.
    pub(in super::super) fn inspect_workspace_mode(
        &self,
        requested_root: &str,
    ) -> Result<Inspection, ErrorCode> {
        let remote = command(
            self.config
                .workspace_root
                .as_deref()
                .and_then(configured_root),
            requested_root,
        )?;
        let deadline = Instant::now() + TIMEOUT;
        for _ in 0..ATTEMPTS {
            if Instant::now() >= deadline {
                break;
            }
            self.revalidate_policy()?;
            let mut pinned = self.pinned_ssh("-T")?;
            pinned.command.args(["--", &self.host, &remote]);
            let output =
                process::run(pinned.command, deadline, OUTPUT_MAX).map_err(
                    |error| match error {
                        process::Failure::TimedOut => ErrorCode::WorkspaceReadFailed,
                        process::Failure::Spawn => ErrorCode::OwnerUnavailable,
                        process::Failure::Io => ErrorCode::TransportLost,
                    },
                )?;
            if let Some(result) = decode(output)? {
                return Ok(result);
            }
        }
        Err(ErrorCode::WorkspaceReadFailed)
    }
}

fn command(approved: Option<&str>, requested: &str) -> Result<String, ErrorCode> {
    require_exact_root(approved, requested)?;
    Ok(shell_command(SCRIPT, &[requested]))
}

fn require_exact_root(approved: Option<&str>, requested: &str) -> Result<(), ErrorCode> {
    if approved != Some(requested) || !valid_root(requested) {
        return Err(ErrorCode::WorkspacePathDenied);
    }
    Ok(())
}

fn shell_command(script: &str, args: &[&str]) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let mut command = format!("/bin/sh -c {} sh", quote(script));
    for arg in args {
        command.push(' ');
        command.push_str(&quote(arg));
    }
    command
}

fn valid_root(root: &str) -> bool {
    root.starts_with('/') && root.len() <= ROOT_MAX && !root.bytes().any(|b| b.is_ascii_control())
}

fn decode(output: process::Output) -> Result<Option<Inspection>, ErrorCode> {
    if output.truncated || output.stderr.len() >= STDERR_MAX {
        return Err(ErrorCode::WorkspaceReadFailed);
    }
    match (output.status.code(), output.stdout.as_slice()) {
        (Some(0), _) => parse(&output.stdout).map(Some),
        (Some(10), b"") => Ok(Some(Inspection::NotLinux)),
        (Some(11), b"") => Ok(Some(Inspection::NoMachineId)),
        (Some(12), b"") => Ok(Some(Inspection::MissingFolder)),
        (Some(13), b"") => Ok(Some(Inspection::UnsafeStorage)),
        (Some(14), _) => Ok(None), // File disappeared between enumeration and read.
        (Some(255), _) => Err(ssh_failure(&output.stderr)),
        (None, _) => Err(ErrorCode::TransportLost),
        _ => Err(ErrorCode::WorkspaceReadFailed),
    }
}

fn parse(stdout: &[u8]) -> Result<Inspection, ErrorCode> {
    let failed = ErrorCode::WorkspaceReadFailed;
    let stdout = std::str::from_utf8(stdout).map_err(|_| failed)?;
    let (header, rest) = stdout.split_once('\n').ok_or(failed)?;
    let (root, record) = rest.split_once('\n').ok_or(failed)?;
    let fields: Vec<_> = header.splitn(6, ' ').collect();
    let [MARKER, host, uid, digest, generation] = fields.as_slice() else {
        return Err(failed);
    };
    if !valid_root(root) || !hex_digest(host) || format!("{:x}", Sha256::digest(root)) != *digest {
        return Err(failed);
    }
    let account_uid = uid.parse::<u32>().map_err(|_| failed)?;
    let generation_number = generation.parse::<u64>().map_err(|_| failed)?;
    if account_uid.to_string() != *uid
        || generation_number.to_string() != *generation
        || generation_number > MAX_GENERATION
    {
        return Err(failed);
    }
    let host_identity = format!("machine-v1:{host}");
    let current_record = match (generation_number, record) {
        (0, "") => None,
        (0, _) => return Err(failed),
        (n, raw) if valid_record(raw, &host_identity, account_uid, digest, n) => Some(raw.into()),
        _ => return Err(failed),
    };
    Ok(Inspection::Ready {
        physical_root: root.into(),
        host_identity,
        account_uid,
        realpath_sha256: (*digest).into(),
        generation: generation_number,
        current_record,
    })
}

fn valid_record(raw: &str, host: &str, uid: u32, digest: &str, generation: u64) -> bool {
    if raw.len() > RECORD_MAX {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    let Some(mode @ ("laptop-runtime" | "remote-runtime")) =
        value.get("mode").and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    let owner = match value.get("owner") {
        Some(serde_json::Value::Null) => "null".into(),
        Some(serde_json::Value::String(owner))
            if owner.strip_prefix("backend-v1:").is_some_and(hex_digest) =>
        {
            format!("\"{owner}\"")
        }
        _ => return false,
    };
    raw == format!(
        r#"{{"format":"bigbud.workspace-mode.v1","generation":{generation},"hostIdentity":"{host}","accountUid":{uid},"realpathSha256":"{digest}","mode":"{mode}","owner":{owner}}}"#
    )
}

fn hex_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

#[cfg(test)]
mod tests;
