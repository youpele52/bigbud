use super::super::DEADLINE;
use super::{
    ErrorCode, Transport, process, run, ssh_failure, v1, validate_path, workspace_command,
};
use sha2::{Digest, Sha256};

const CAPTURE_LIMIT: usize = 4 * 1024 * 1024;
const MARKER: &[u8] = b"BIGBUD_WORKSPACE_SNAPSHOT_V1\0";

// Both GNU %.9Y and BSD %.9Fm request epoch seconds with nanoseconds, and
// neither stat dereferences links by default. Batching avoids one process per
// child; names never pass through stat's output.
const SCRIPT: &str = r#"
[ -d "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
[ -r . ] && [ -x . ] || exit 3
if probe=$(stat -c '%F:%s:%.9Y' . 2>/dev/null) && [ "${probe%%:*}" = directory ]; then
  stat_flavor=gnu
elif probe=$(stat -f '%HT:%z:%.9Fm' . 2>/dev/null) && [ "${probe%%:*}" = Directory ]; then
  stat_flavor=bsd
else
  exit 1
fi
snapshot_batch() {
  case "$stat_flavor" in
    gnu) records=$(stat -c '%F:%s:%.9Y' "$@") || exit 1 ;;
    bsd) records=$(stat -f '%HT:%z:%.9Fm' "$@") || exit 1 ;;
  esac
  {
    for name do
      IFS= read -r record || exit 1
      case "${record%%:*}" in
        directory|Directory) kind=d ;;
        'regular file'|'regular empty file'|'Regular File') kind=f ;;
        *) continue ;;
      esac
      printf '%s\t%s\t%s\000' "$kind" "${record#*:}" "${name#./}" || exit 1
    done
    if IFS= read -r extra; then exit 1; fi
  } <<EOF
$records
EOF
}
printf 'BIGBUD_WORKSPACE_SNAPSHOT_V1\000' || exit 1
set --
for entry in ./* ./.[!.]* ./..?*; do
  # An unmatched glob is passed through literally. A child can also have that
  # exact name, so only skip the literal pattern when it is not an entry.
  case "$entry" in
    './*'|'./.[!.]*'|'./..?*') [ -L "$entry" ] || [ -e "$entry" ] || continue ;;
  esac
  set -- "$@" "$entry"
  if [ "$#" -eq 128 ]; then
    snapshot_batch "$@" || exit 1
    set --
  fi
done
if [ "$#" -gt 0 ]; then snapshot_batch "$@" || exit 1; fi
"#;

pub(in super::super) fn snapshot(
    transport: &Transport,
    operand: &v1::ProofWorkspaceList,
) -> Result<v1::ProofWorkspaceSnapshotResult, ErrorCode> {
    let remote = snapshot_command(transport, operand)?;
    decode(run(transport, &remote, DEADLINE, CAPTURE_LIMIT)?)
}

#[cfg(target_os = "linux")]
impl Transport {
    pub(crate) fn require_snapshot_fixture_image(&self) -> Result<(), ErrorCode> {
        self.images.require_mounted_linux_fixture()
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(in super::super) fn snapshot_cancellable(
    transport: &Transport,
    operand: &v1::ProofWorkspaceList,
    cancelled: impl Fn() -> bool,
) -> Result<v1::ProofWorkspaceSnapshotResult, ErrorCode> {
    let remote = snapshot_command(transport, operand)?;
    if cancelled() {
        return Err(ErrorCode::ListCancelled);
    }
    // Use the ordinary workspace policy and pin, keeping the pin alive until
    // the exact local child exits. This does not use a terminal or mux lease.
    let (pinned, deadline) = super::pinned_workspace_command(transport, &remote, DEADLINE)?;
    run_cancellable(pinned.command, deadline, cancelled)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_cancellable(
    command: std::process::Command,
    deadline: std::time::Instant,
    cancelled: impl Fn() -> bool,
) -> Result<v1::ProofWorkspaceSnapshotResult, ErrorCode> {
    let output = process::run_picker_cancellable(
        process::clean(command),
        deadline,
        CAPTURE_LIMIT,
        cancelled,
    )
    .map_err(|failure| match failure {
        process::PickerFailure::Cancelled => ErrorCode::ListCancelled,
        process::PickerFailure::CleanupUnconfirmed => ErrorCode::OutcomeUnknown,
        process::PickerFailure::Process(process::Failure::TimedOut) => {
            ErrorCode::WorkspaceReadFailed
        }
        process::PickerFailure::Process(process::Failure::Spawn) => ErrorCode::OwnerUnavailable,
        process::PickerFailure::Process(process::Failure::Io) => ErrorCode::TransportLost,
    })?;
    decode(output)
}

fn snapshot_command(
    transport: &Transport,
    operand: &v1::ProofWorkspaceList,
) -> Result<String, ErrorCode> {
    let root = validate_path(
        transport.config.workspace_root.as_deref(),
        &operand.workspace_root,
        &operand.relative_dir,
        true,
    )?;
    Ok(workspace_command(SCRIPT, root, &operand.relative_dir))
}

fn decode(output: process::Output) -> Result<v1::ProofWorkspaceSnapshotResult, ErrorCode> {
    match output.status.code() {
        Some(0) => parse(&output.stdout, output.truncated),
        Some(3) => Err(ErrorCode::WorkspacePathDenied),
        Some(255) => Err(ssh_failure(&output.stderr)),
        None => Err(ErrorCode::TransportLost),
        _ => Err(ErrorCode::WorkspaceReadFailed),
    }
}

fn parse(bytes: &[u8], truncated: bool) -> Result<v1::ProofWorkspaceSnapshotResult, ErrorCode> {
    let failed = ErrorCode::WorkspaceReadFailed;
    if truncated || bytes.len() > CAPTURE_LIMIT {
        return Err(failed);
    }
    let payload = bytes.strip_prefix(MARKER).ok_or(failed)?;
    let mut entries = Vec::new();
    for raw in payload.split_inclusive(|&byte| byte == 0) {
        let record = raw.strip_suffix(b"\0").ok_or(failed)?;
        let mut fields = record.splitn(3, |&byte| byte == b'\t');
        if !matches!(fields.next(), Some(b"d" | b"f")) {
            return Err(failed);
        }
        let metadata = fields.next().ok_or(failed)?;
        let name = fields.next().ok_or(failed)?;
        if matches!(name, b"" | b"." | b"..") || name.contains(&b'/') {
            return Err(failed);
        }
        let mut metadata = metadata.splitn(2, |&byte| byte == b':');
        let size = metadata.next().ok_or(failed)?;
        let mtime = metadata.next().ok_or(failed)?;
        let mtime = mtime.strip_prefix(b"-").unwrap_or(mtime);
        let mut parts = mtime.splitn(2, |&byte| byte == b'.');
        let seconds = parts.next().ok_or(failed)?;
        let nanos = parts.next().ok_or(failed)?;
        if size.is_empty()
            || !size.iter().all(u8::is_ascii_digit)
            || seconds.is_empty()
            || !seconds.iter().all(u8::is_ascii_digit)
            || nanos.len() != 9
            || !nanos.iter().all(u8::is_ascii_digit)
        {
            return Err(failed);
        }
        entries.push((name, raw));
    }
    entries.sort_unstable_by_key(|&(name, _)| name);
    let mut digest = Sha256::new();
    digest.update(MARKER);
    let mut previous = None;
    for (name, raw) in entries {
        if previous == Some(name) {
            return Err(failed);
        }
        digest.update(raw);
        previous = Some(name);
    }
    Ok(v1::ProofWorkspaceSnapshotResult {
        digest: format!("{:x}", digest.finalize()),
    })
}

#[cfg(test)]
#[path = "snapshot.tests.rs"]
mod tests;
