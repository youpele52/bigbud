pub(in super::super) mod create;
pub(super) mod cwd;
pub(super) mod directory;
pub(super) mod directory_ops;
pub(crate) mod entry_ops;
pub(super) mod git;
pub(super) mod index;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod readiness;
pub(super) mod search;
pub(super) mod snapshot;
pub(super) mod staged_write;
pub(super) mod write;

use super::{ErrorCode, Transport, process, ssh_failure, v1};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{Duration, Instant};
use v1::proof_workspace_read::Read as Selection;

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PATH_BYTES: usize = 4096;
const PREVIEW_LIMIT: usize = 5 * 1024 * 1024;
const RANGE_LIMIT: u32 = 512 * 1024;
const MAX_SAFE_OFFSET: u64 = (1 << 53) - 1;
const MARKER: &[u8] = b"BIGBUD_WORKSPACE_FILE_V1 ";
const HEADER_LIMIT: usize = MARKER.len() + 20 + 1; // u64 decimal and LF

// Paths are validated as POSIX components before launch and only passed as
// quoted positional arguments. This proof rejects static symlinks, including
// the trusted root's ancestors; it does not defend against remote path races.
const PATH_WALK: &str = r#"
PATH=/usr/bin:/bin
LC_ALL=C
export PATH LC_ALL
rest=${1#/}${2:+/$2}
target=
while :; do
  target=$target/${rest%%/*}
  [ ! -L "$target" ] || exit 3
  case "$rest" in
    */*) [ -d "$target" ] || exit 3; rest=${rest#*/} ;;
    *) break ;;
  esac
done
"#;

const READ_SCRIPT: &str = r#"
[ -f "$target" ] || exit 3
size=$(wc -c < "$target") || exit 1
# Strip padding from wc before printing the binary envelope.
read -r size <<EOF || exit 1
$size
EOF
case "$size" in ''|*[!0-9]*) exit 1 ;; esac
if [ "$3" = preview ] && [ "$size" -gt "$5" ]; then exit 4; fi
printf 'BIGBUD_WORKSPACE_FILE_V1 %s\n' "$size" || exit 1
case "$3" in
  preview)
    # Fixed 5 MiB plus a sentinel byte if the file has grown since wc.
    { dd bs=65536 count=80 && dd bs=1 count=1; } < "$target" 2>/dev/null ;;
  range)
    if [ "$5" -gt 0 ] && [ "$4" -lt "$size" ]; then
      dd bs=1 skip="$4" count="$5" < "$target" 2>/dev/null
    fi ;;
  *) exit 1 ;;
esac
"#;

#[derive(Debug, Clone, Copy)]
enum Read {
    Preview,
    Range { offset: u64, max_bytes: u32 },
}

impl Read {
    fn from_selection(selection: Option<&Selection>) -> Result<Self, ErrorCode> {
        match selection {
            Some(Selection::Preview(_)) => Ok(Self::Preview),
            Some(Selection::Range(range))
                if range.offset <= MAX_SAFE_OFFSET && range.max_bytes <= RANGE_LIMIT =>
            {
                Ok(Self::Range {
                    offset: range.offset,
                    max_bytes: range.max_bytes,
                })
            }
            _ => Err(ErrorCode::InvalidOperands),
        }
    }

    fn command(self, root: &str, relative: &str) -> String {
        let (mode, offset, limit) = match self {
            Self::Preview => ("preview", 0, PREVIEW_LIMIT),
            Self::Range { offset, max_bytes } => ("range", offset, max_bytes as usize),
        };
        format!(
            "{} {mode} {offset} {limit}",
            workspace_command(READ_SCRIPT, root, relative)
        )
    }

    fn capture_limit(self) -> usize {
        HEADER_LIMIT
            + match self {
                Self::Preview => PREVIEW_LIMIT + 1,
                Self::Range { max_bytes, .. } => max_bytes as usize,
            }
    }

    fn decode(self, output: process::Output) -> Result<v1::ProofWorkspaceFile, ErrorCode> {
        match output.status.code() {
            Some(0) => self.parse(output.stdout, output.truncated),
            Some(3) => Err(ErrorCode::WorkspacePathDenied),
            Some(4) if matches!(self, Self::Preview) => Err(ErrorCode::WorkspaceFileTooLarge),
            Some(255) => Err(ssh_failure(&output.stderr)),
            None => Err(ErrorCode::TransportLost),
            _ => Err(ErrorCode::WorkspaceReadFailed),
        }
    }

    fn parse(
        self,
        mut data: Vec<u8>,
        capture_truncated: bool,
    ) -> Result<v1::ProofWorkspaceFile, ErrorCode> {
        let failed = ErrorCode::WorkspaceReadFailed;
        let header_end = data
            .iter()
            .take(HEADER_LIMIT)
            .position(|&byte| byte == b'\n')
            .ok_or(failed)?;
        let (header, rest) = data.split_at_checked(header_end).ok_or(failed)?;
        let size = header.strip_prefix(MARKER).ok_or(failed)?;
        if size.is_empty() || !size.iter().all(u8::is_ascii_digit) {
            return Err(failed);
        }
        let size_bytes = std::str::from_utf8(size)
            .map_err(|_| failed)?
            .parse::<u64>()
            .map_err(|_| failed)?;
        let payload = rest.strip_prefix(b"\n").ok_or(failed)?;
        let truncated = match self {
            Self::Preview => {
                if size_bytes > PREVIEW_LIMIT as u64 || payload.len() > PREVIEW_LIMIT {
                    return Err(ErrorCode::WorkspaceFileTooLarge);
                }
                if capture_truncated
                    || payload.len() as u64 != size_bytes
                    || payload.contains(&0)
                    || std::str::from_utf8(payload).is_err()
                {
                    return Err(failed);
                }
                false
            }
            Self::Range { offset, max_bytes } => {
                let remaining = size_bytes.saturating_sub(offset);
                if capture_truncated || payload.len() as u64 != remaining.min(u64::from(max_bytes))
                {
                    return Err(failed);
                }
                (payload.len() as u64) < remaining
            }
        };
        let sha256 = matches!(self, Self::Preview).then(|| Sha256::digest(payload).to_vec());
        data.drain(..=header_end);
        Ok(v1::ProofWorkspaceFile {
            data,
            size_bytes,
            truncated,
            sha256,
        })
    }
}

pub(super) fn configured_root(root: &Path) -> Option<&str> {
    let root = root.to_str()?;
    // The fixture does not grant a whole remote filesystem.
    normal_components(root.strip_prefix('/')?).then_some(root)
}

fn normal_components(path: &str) -> bool {
    path.len() <= MAX_PATH_BYTES
        && !path.contains('\0')
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

/// Root authority for one workspace file request. A fixture keeps its trusted
/// startup root. A production target has none, so it admits the request's own
/// root: `validate_path` still requires it to be absolute and normalized (never
/// `/`), and the remote `PATH_WALK` refuses a symlink anywhere on it. The
/// server chooses that root from the project bound to this exact target.
pub(super) fn root_authority<'a>(transport: &'a Transport, requested: &'a str) -> Option<&'a Path> {
    match transport.config.workspace_root.as_deref() {
        Some(root) => Some(root),
        None if transport.facts.production() => Some(Path::new(requested)),
        None => None,
    }
}

pub(super) fn validate_path<'a>(
    root: Option<&'a Path>,
    requested_root: &str,
    relative: &str,
    allow_root: bool,
) -> Result<&'a str, ErrorCode> {
    let root = root
        .and_then(configured_root)
        .ok_or(ErrorCode::WorkspacePathDenied)?;
    let normal_relative = normal_components(relative)
        && !relative.starts_with('\\')
        && !matches!(relative.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic());
    if root == requested_root && (normal_relative || (allow_root && relative.is_empty())) {
        Ok(root)
    } else {
        Err(ErrorCode::WorkspacePathDenied)
    }
}

pub(super) fn workspace_command(script: &str, root: &str, relative: &str) -> String {
    format!(
        "/bin/sh -c {} sh {} {}",
        quote(&format!("{PATH_WALK}{script}")),
        quote(root),
        quote(relative),
    )
}

/// Same fixed path walk, plus one quoted positional argument. The argument is
/// passed as data to the owner-selected shell, never interpolated into argv.
pub(super) fn workspace_command_with_arg(
    script: &str,
    root: &str,
    relative: &str,
    argument: &str,
) -> String {
    format!(
        "/bin/sh -c {} sh {} {} {}",
        quote(&format!("{PATH_WALK}{script}")),
        quote(root),
        quote(relative),
        quote(argument),
    )
}

pub(super) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) fn read(
    transport: &Transport,
    operand: &v1::ProofWorkspaceRead,
) -> Result<v1::ProofWorkspaceFile, ErrorCode> {
    let root = validate_path(
        root_authority(transport, &operand.workspace_root),
        &operand.workspace_root,
        &operand.relative_path,
        false,
    )?;
    let read = Read::from_selection(operand.read.as_ref())?;
    let remote = read.command(root, &operand.relative_path);
    read.decode(run(transport, &remote, READ_TIMEOUT, read.capture_limit())?)
}

fn run(
    transport: &Transport,
    remote: &str,
    timeout: Duration,
    limit: usize,
) -> Result<process::Output, ErrorCode> {
    run_with_capture(transport, remote, timeout, limit, process::run)
}

pub(super) fn run_with_capture(
    transport: &Transport,
    remote: &str,
    timeout: Duration,
    limit: usize,
    capture: impl FnOnce(
        std::process::Command,
        Instant,
        usize,
    ) -> Result<process::Output, process::Failure>,
) -> Result<process::Output, ErrorCode> {
    let (pinned, deadline) = pinned_workspace_command(transport, remote, timeout)?;
    capture(pinned.command, deadline, limit).map_err(|error| match error {
        process::Failure::TimedOut => ErrorCode::WorkspaceReadFailed,
        process::Failure::Spawn => ErrorCode::OwnerUnavailable,
        process::Failure::Io => ErrorCode::TransportLost,
    })
}

pub(super) fn pinned_workspace_command(
    transport: &Transport,
    remote: &str,
    timeout: Duration,
) -> Result<(super::PinnedSsh, Instant), ErrorCode> {
    transport.revalidate_policy()?;
    let deadline = Instant::now() + timeout;
    let mut pinned = transport.pinned_ssh("-T")?;
    pinned.command.args(["--", &transport.host, remote]);
    Ok((pinned, deadline))
}

#[cfg(test)]
#[path = "workspace/production.tests.rs"]
mod production_tests;
#[cfg(test)]
mod tests;
