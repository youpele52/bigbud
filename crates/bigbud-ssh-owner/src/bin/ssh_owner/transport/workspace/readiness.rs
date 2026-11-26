use super::{
    ErrorCode, Transport, process, run_with_capture, ssh_failure, v1, validate_path,
    workspace_command,
};
use crate::transport::DEADLINE;
use v1::{ProofWorkspaceReadiness, ProofWorkspaceReadinessResult};

const OUTPUT_LIMIT: usize = 4 * 1024;
const RECIPE: &str = r#"
[ -d "$target" ] && [ -x "$target" ] && cd -P "$target" && [ "$PWD" = "$target" ] || exit 3
/usr/bin/uname -s || exit 1
exec /usr/bin/uname -m
"#;

impl Transport {
    pub(crate) fn probe_workspace_readiness(
        &self,
        operand: &ProofWorkspaceReadiness,
    ) -> Result<ProofWorkspaceReadinessResult, ErrorCode> {
        let root = validate_path(
            super::root_authority(self, &operand.workspace_root),
            &operand.workspace_root,
            "",
            true,
        )?;
        self.require_direct_route()?;
        if self.proof_agent.is_some()
            || self
                .policy
                .as_ref()
                .is_some_and(|policy| !policy.additional_identities.is_empty())
        {
            return Err(ErrorCode::OperationDenied);
        }
        // The mounted-image fence is the Linux fixture's; production validates
        // the bound system image when it opens the target's transport.
        #[cfg(target_os = "linux")]
        if !self.facts.production() {
            self.images.require_mounted_linux_fixture()?;
        }
        let output = run_with_capture(
            self,
            &workspace_command(RECIPE, root, ""),
            DEADLINE,
            OUTPUT_LIMIT,
            process::run_with_combined_output_limit,
        )?;
        decode(output)
    }
}

fn decode(output: process::Output) -> Result<ProofWorkspaceReadinessResult, ErrorCode> {
    match output.status.code() {
        Some(0) if !output.truncated && output.stderr.is_empty() => parse(&output.stdout),
        Some(3) => Err(ErrorCode::WorkspacePathDenied),
        Some(255) => Err(ssh_failure(&output.stderr)),
        None => Err(ErrorCode::TransportLost),
        _ => Err(ErrorCode::WorkspaceReadFailed),
    }
}

fn parse(stdout: &[u8]) -> Result<ProofWorkspaceReadinessResult, ErrorCode> {
    let failed = ErrorCode::WorkspaceReadFailed;
    let mut lines = stdout
        .strip_suffix(b"\n")
        .ok_or(failed)?
        .split(|&b| b == b'\n');
    let os = known_token(lines.next().ok_or(failed)?, &["darwin", "linux"]).ok_or(failed)?;
    let architecture = known_token(
        lines.next().ok_or(failed)?,
        &["x86_64", "amd64", "arm64", "aarch64"],
    )
    .ok_or(failed)?;
    if lines.next().is_some() {
        return Err(failed);
    }
    Ok(ProofWorkspaceReadinessResult {
        os: os.into(),
        architecture: architecture.into(),
    })
}

fn known_token<'a>(value: &[u8], tokens: &[&'a str]) -> Option<&'a str> {
    tokens
        .iter()
        .copied()
        .find(|token| value.eq_ignore_ascii_case(token.as_bytes()))
}

#[cfg(test)]
#[path = "readiness.tests.rs"]
mod tests;
