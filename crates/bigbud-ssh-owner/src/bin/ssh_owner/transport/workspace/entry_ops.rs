//! W2 T-files session-FS verbs: entry info (lstat), rename and bounded append.
//!
//! Every recipe is fixed, takes the root, relative paths and size as quoted
//! positional operands only, and reuses the shared `PATH_WALK`, which refuses a
//! symlink anywhere on the path. A mutation without its exact acknowledgement
//! is `outcome_unknown` and is never replayed.

use super::{ErrorCode, PATH_WALK, Transport, process, quote, v1, validate_path};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(30);
const ACK_LIMIT: usize = 128;
const MAX_APPEND_BYTES: usize = 48 * 1024;
const INFO: &[u8] = b"BIGBUD_WORKSPACE_INFO_V1 ";
const CHANGED: &[u8] = b"BIGBUD_WORKSPACE_CHANGE_V1 ";

// lstat without following the leaf; birth time falls back to ctime.
const INFO_SCRIPT: &str = r#"
[ ! -L "$target" ] || exit 3
exec /usr/bin/python3 -I -B -c 'import os, stat, sys
try:
    s = os.lstat(sys.argv[1])
except FileNotFoundError:
    print("BIGBUD_WORKSPACE_INFO_V1 1 0 0 0"); sys.exit(0)
k = 2 if stat.S_ISREG(s.st_mode) else 3 if stat.S_ISDIR(s.st_mode) else 4
b = getattr(s, "st_birthtime", s.st_ctime)
print("BIGBUD_WORKSPACE_INFO_V1 %d %d %d %d" % (k, s.st_size, int(s.st_mtime * 1000), int(b * 1000)))' "$target"
"#;

// `$3` is the destination and `$4` the mode; the second walk re-checks the
// destination the same way.
const RENAME_SCRIPT: &str = r#"
source=$target
mode=$4
set -- "$1" "$3"
"#;
// `replace` swaps an existing regular file atomically with rename(2) via
// `os.replace` (which fails rather than copying across filesystems).
const RENAME_TAIL: &str = r#"
[ ! -L "$source" ] && [ ! -L "$target" ] || exit 3
[ -e "$source" ] || { printf 'BIGBUD_WORKSPACE_CHANGE_V1 2\n'; exit 0; }
if [ -e "$target" ]; then
  [ "$mode" = replace ] && [ -f "$source" ] && [ -f "$target" ] ||
    { printf 'BIGBUD_WORKSPACE_CHANGE_V1 3\n'; exit 0; }
  /usr/bin/python3 -I -B -c 'import os, sys; os.replace(sys.argv[1], sys.argv[2])' \
    "$source" "$target" || exit 1
  [ ! -e "$source" ] && [ -f "$target" ] || exit 1
  printf 'BIGBUD_WORKSPACE_CHANGE_V1 1\n'
  exit 0
fi
mv -n -- "$source" "$target" || exit 1
[ ! -e "$source" ] && [ -e "$target" ] || exit 1
printf 'BIGBUD_WORKSPACE_CHANGE_V1 1\n'
"#;

// Stage stdin beside the file, check its exact size, then append once.
const APPEND_SCRIPT: &str = r#"
[ ! -L "$target" ] || exit 3
[ -e "$target" ] || { printf 'BIGBUD_WORKSPACE_CHANGE_V1 2\n'; exit 0; }
[ -f "$target" ] || { printf 'BIGBUD_WORKSPACE_CHANGE_V1 4\n'; exit 0; }
stage=$(mktemp "${target%/*}/._bigbud-append.XXXXXXXX") || exit 2
trap 'rm -f "$stage"' 0
cat > "$stage" || exit 2
size=$(wc -c < "$stage") || exit 2
[ "$size" -eq "$3" ] || exit 2
cat "$stage" >> "$target" || exit 1
printf 'BIGBUD_WORKSPACE_CHANGE_V1 1\n'
"#;

fn remote(script: &str, root: &str, relative: &str, extra: &str) -> String {
    remote_with_mode(script, root, relative, extra, "")
}

fn remote_with_mode(script: &str, root: &str, relative: &str, extra: &str, mode: &str) -> String {
    format!(
        "/bin/sh -c {} sh {} {} {} {}",
        quote(&format!("{PATH_WALK}{script}")),
        quote(root),
        quote(relative),
        quote(extra),
        quote(mode),
    )
}

fn run(transport: &Transport, command: &str, input: &[u8]) -> Result<process::Output, ErrorCode> {
    transport.revalidate_policy()?;
    let mut pinned = transport.pinned_ssh("-T")?;
    pinned.command.args(["--", transport.host(), command]);
    process::run_with_input(pinned.command, Instant::now() + TIMEOUT, ACK_LIMIT, input).map_err(
        |error| match error {
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            process::Failure::Io | process::Failure::TimedOut => ErrorCode::OutcomeUnknown,
        },
    )
}

pub(in super::super) fn entry_info(
    transport: &Transport,
    operand: &v1::WorkspaceEntryInfoRequest,
) -> Result<v1::WorkspaceEntryInfo, ErrorCode> {
    let root = validate_path(
        super::root_authority(transport, &operand.workspace_root),
        &operand.workspace_root,
        &operand.relative_path,
        true,
    )?;
    decode_info(run(
        transport,
        &remote(INFO_SCRIPT, root, &operand.relative_path, ""),
        b"",
    )?)
}

pub(in super::super) fn rename(
    transport: &Transport,
    operand: &v1::WorkspaceRenameRequest,
) -> Result<v1::WorkspaceEntryChange, ErrorCode> {
    let authority = super::root_authority(transport, &operand.workspace_root);
    let root = validate_path(
        authority,
        &operand.workspace_root,
        &operand.relative_path,
        false,
    )?;
    validate_path(
        authority,
        &operand.workspace_root,
        &operand.destination_path,
        false,
    )?;
    if operand.relative_path == operand.destination_path {
        return Err(ErrorCode::InvalidOperands);
    }
    let script = format!("{RENAME_SCRIPT}{PATH_WALK}{RENAME_TAIL}");
    decode_change(run(
        transport,
        &remote_with_mode(
            &script,
            root,
            &operand.relative_path,
            &operand.destination_path,
            if operand.replace { "replace" } else { "" },
        ),
        b"",
    )?)
}

pub(in super::super) fn append(
    transport: &Transport,
    operand: &v1::WorkspaceAppendRequest,
) -> Result<v1::WorkspaceEntryChange, ErrorCode> {
    let root = validate_path(
        super::root_authority(transport, &operand.workspace_root),
        &operand.workspace_root,
        &operand.relative_path,
        false,
    )?;
    if operand.contents.is_empty() || operand.contents.len() > MAX_APPEND_BYTES {
        return Err(ErrorCode::InvalidOperands);
    }
    let size = operand.contents.len().to_string();
    decode_change(run(
        transport,
        &remote(APPEND_SCRIPT, root, &operand.relative_path, &size),
        &operand.contents,
    )?)
}

fn marker_fields(output: &process::Output, marker: &[u8]) -> Option<Vec<u64>> {
    if output.truncated || output.status.code() != Some(0) {
        return None;
    }
    let line = output.stdout.strip_prefix(marker)?.strip_suffix(b"\n")?;
    std::str::from_utf8(line)
        .ok()?
        .split(' ')
        .map(|field| field.parse::<u64>().ok())
        .collect()
}

fn denied(output: &process::Output) -> bool {
    output.status.code() == Some(3) && output.stdout.is_empty()
}

fn decode_info(output: process::Output) -> Result<v1::WorkspaceEntryInfo, ErrorCode> {
    if denied(&output) {
        return Err(ErrorCode::WorkspacePathDenied);
    }
    match marker_fields(&output, INFO).as_deref() {
        Some(&[kind @ 1..=4, size, mtime_ms, birthtime_ms]) => Ok(v1::WorkspaceEntryInfo {
            kind: u32::try_from(kind).map_err(|_| ErrorCode::WorkspaceReadFailed)?,
            size,
            mtime_ms,
            birthtime_ms,
        }),
        _ if output.status.code() == Some(255) => Err(super::ssh_failure(&output.stderr)),
        _ => Err(ErrorCode::WorkspaceReadFailed),
    }
}

fn decode_change(output: process::Output) -> Result<v1::WorkspaceEntryChange, ErrorCode> {
    if denied(&output) {
        return Err(ErrorCode::WorkspacePathDenied);
    }
    match marker_fields(&output, CHANGED).as_deref() {
        Some(&[result @ 1..=4]) => Ok(v1::WorkspaceEntryChange {
            result: u32::try_from(result).map_err(|_| ErrorCode::OutcomeUnknown)?,
        }),
        // A failed or partial mutation and a missing marker cannot prove the tree
        // is unchanged. Never replay.
        _ => Err(ErrorCode::OutcomeUnknown),
    }
}

/// Owner dispatch for the three session-FS verbs (Request 122–124).
pub(crate) fn dispatch(
    transport: &Transport,
    operation: v1::request::Operation,
) -> Result<v1::reply::Outcome, ErrorCode> {
    use v1::{reply::Outcome, request::Operation};
    match operation {
        Operation::WorkspaceEntryInfo(operand) => {
            entry_info(transport, &operand).map(Outcome::WorkspaceEntryInfo)
        }
        Operation::WorkspaceRename(operand) => {
            rename(transport, &operand).map(Outcome::WorkspaceEntryChange)
        }
        Operation::WorkspaceAppend(operand) => {
            append(transport, &operand).map(Outcome::WorkspaceEntryChange)
        }
        _ => Err(ErrorCode::OperationDenied),
    }
}

#[cfg(test)]
#[path = "entry_ops.tests.rs"]
mod tests;
