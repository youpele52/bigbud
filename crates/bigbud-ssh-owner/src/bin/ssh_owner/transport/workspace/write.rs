use super::{ErrorCode, PATH_WALK, Transport, process, quote, v1, validate_path};
use std::path::Path;
use std::time::{Duration, Instant};

const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const MAX_CONTENT_BYTES: usize = 48 * 1024;
pub(super) const MAX_STAGED_CONTENT_BYTES: usize = 512 * 1024;
const MARKER: &[u8] = b"BIGBUD_WORKSPACE_WRITE_V1\n";
const FAILED_MARKER: &[u8] = b"BIGBUD_WORKSPACE_WRITE_V1 FAILED\n";
const DENIED_MARKER: &[u8] = b"BIGBUD_WORKSPACE_WRITE_V1 PATH_DENIED\n";
const ACK_LIMIT: usize = DENIED_MARKER.len();

// Install the acknowledgement handler before the shared root walk. Negative
// acknowledgements certify no persistent change; never infer one from an SSH
// exit status alone. A failed cleanup or any attempted parent creation or
// publication can leave changes. Do not remove created parents on failure.
const ACK_HANDLER: &str = r#"
stage=
may_have_changed=no
finish() {
  status=$?
  trap - 0
  if [ -n "$stage" ]; then
    rm -f "$stage" || exit 2
  fi
  [ "$status" -eq 0 ] && exit 0
  [ "$may_have_changed" = no ] || exit 2
  case "$status" in
    1) printf 'BIGBUD_WORKSPACE_WRITE_V1 FAILED\n' || exit 2 ;;
    3) printf 'BIGBUD_WORKSPACE_WRITE_V1 PATH_DENIED\n' || exit 2 ;;
    *) exit 2 ;;
  esac
  exit "$status"
}
trap finish 0
trap 'exit 2' HUP INT TERM
"#;

// After the shared root walk, check each component before using it. Like the
// read proof, this assumes a trusted fixture tree without concurrent path replacement.
const SCRIPT: &str = r#"
[ -d "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
rest=$3
while :; do
  case "$rest" in
    */*)
      dir=./${rest%%/*}
      [ ! -L "$dir" ] || exit 3
      if [ ! -d "$dir" ]; then
        [ ! -e "$dir" ] || exit 3
        may_have_changed=yes
        mkdir "$dir" || exit 2
      fi
      cd -P "$dir" || exit 1
      rest=${rest#*/} ;;
    *) break ;;
  esac
done
file=./$rest
check_file() {
  [ ! -L "$file" ] && { [ ! -e "$file" ] || [ -f "$file" ]; }
}
check_file || exit 3
# Use a staging name that cannot alias the requested filename, including on
# a case-insensitive filesystem. mktemp gives each write a private sibling.
case "$rest" in
  ._*) template=./.bigbud-write.XXXXXXXX ;;
  *)   template=./._bigbud-write.XXXXXXXX ;;
esac
stage=$(mktemp "$template") || exit 2
cat > "$stage" || exit 1
size=$(wc -c < "$stage") || exit 1
# SSH can close stdin early on disconnect. Never publish a short input.
[ "$size" -eq "$4" ] || exit 1
check_file || exit 3
may_have_changed=yes
mv -f "$stage" "$file" || exit 2
stage=
printf 'BIGBUD_WORKSPACE_WRITE_V1\n' || exit 2
"#;

pub(in super::super) fn write(
    transport: &Transport,
    operand: &v1::ProofWorkspaceWrite,
) -> Result<(), ErrorCode> {
    let remote = command(transport.config.workspace_root.as_deref(), operand)?;
    run(transport, &remote, &operand.contents)
}

/// A caller that bound the exact workspace root and path may publish up to the
/// staged 512 KiB ceiling. The single-frame wire verb stays at 48 KiB.
pub(in super::super) fn write_bytes(
    transport: &Transport,
    root: &str,
    relative: &str,
    contents: &[u8],
) -> Result<(), ErrorCode> {
    if contents.len() > MAX_STAGED_CONTENT_BYTES {
        return Err(ErrorCode::InvalidOperands);
    }
    run(
        transport,
        &command_bytes(root, relative, contents.len()),
        contents,
    )
}

fn run(transport: &Transport, remote: &str, contents: &[u8]) -> Result<(), ErrorCode> {
    transport.revalidate_policy()?;
    let mut pinned = transport.pinned_ssh("-T")?;
    pinned.command.args(["--", &transport.host, remote]);
    let output = process::run_with_input(
        pinned.command,
        Instant::now() + WRITE_TIMEOUT,
        ACK_LIMIT,
        contents,
    )
    .map_err(process_failure)?;
    decode(output)
}

fn command(root: Option<&Path>, operand: &v1::ProofWorkspaceWrite) -> Result<String, ErrorCode> {
    let root = validate_path(root, &operand.workspace_root, &operand.relative_path, false)?;
    let size = operand.contents.len();
    if size > MAX_CONTENT_BYTES {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(command_bytes(root, &operand.relative_path, size))
}

fn command_bytes(root: &str, relative: &str, size: usize) -> String {
    // The shared path walk gets an empty $2: walk only the existing root.
    format!(
        "/bin/sh -c {} sh {} '' {} {size}",
        quote(&format!("{ACK_HANDLER}{PATH_WALK}{SCRIPT}")),
        quote(root),
        quote(relative),
    )
}

fn process_failure(error: process::Failure) -> ErrorCode {
    match error {
        process::Failure::Spawn => ErrorCode::OwnerUnavailable,
        process::Failure::Io | process::Failure::TimedOut => ErrorCode::OutcomeUnknown,
    }
}

fn decode(output: process::Output) -> Result<(), ErrorCode> {
    if output.truncated {
        return Err(ErrorCode::OutcomeUnknown);
    }
    match (output.status.code(), output.stdout.as_slice()) {
        (Some(0), MARKER) => Ok(()),
        (Some(3), DENIED_MARKER) => Err(ErrorCode::WorkspacePathDenied),
        (Some(1), FAILED_MARKER) => Err(ErrorCode::WorkspaceWriteFailed),
        // SSH's transport error (255), signals, partial changes and missing
        // acknowledgements cannot prove the workspace is unchanged. Never replay.
        _ => Err(ErrorCode::OutcomeUnknown),
    }
}

#[cfg(test)]
mod tests;
