use super::{
    ErrorCode, Transport, configured_root, run, ssh_failure, v1, validate_path, workspace_command,
};
use crate::transport::DEADLINE;

const VERIFIED: &[u8] = b"BIGBUD_PROOF_CWD\n";
const COMMAND: &str = "[ -d \"$target\" ] && [ -x \"$target\" ] && cd -P \"$target\" && [ \"$PWD\" = \"$target\" ] || exit 3\nprintf 'BIGBUD_PROOF_CWD\\n'\n";

pub(in super::super) fn probe(
    transport: &Transport,
    input: v1::ProofTerminalCwd,
) -> Result<v1::ProofTerminalCwd, ErrorCode> {
    // Fixture: the startup root. Production: the requested directory is its
    // own root, still absolute, normalized and walked without symlinks.
    let root_path = super::root_authority(transport, &input.cwd);
    let root = root_path
        .and_then(configured_root)
        .ok_or(ErrorCode::WorkspacePathDenied)?;
    let relative = if input.cwd == root {
        ""
    } else {
        input
            .cwd
            .strip_prefix(root)
            .and_then(|suffix| suffix.strip_prefix('/'))
            .filter(|part| !part.is_empty())
            .ok_or(ErrorCode::WorkspacePathDenied)?
    };
    validate_path(root_path, root, relative, true)?;
    let output = run(
        transport,
        &workspace_command(COMMAND, root, relative),
        DEADLINE,
        8192,
    )?;
    match output.status.code() {
        Some(0) if !output.truncated && output.stdout == VERIFIED => Ok(input),
        Some(3) => Err(ErrorCode::WorkspacePathDenied),
        Some(255) => Err(ssh_failure(&output.stderr)),
        None => Err(ErrorCode::TransportLost),
        _ => Err(ErrorCode::WorkspaceReadFailed),
    }
}
