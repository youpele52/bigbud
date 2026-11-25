use std::time::{Duration, Instant};

use super::{ErrorCode, Transport, process, ssh_failure};
use crate::v1::{ProofDeploymentCompletion, ProofDeploymentHostProbe, ProofDeploymentHostResult};

const SCRIPT: &str = include_str!("../../../../../../protocol/ssh-owner/deployment-host-probe.sh");
const READ_COMPLETION: &str =
    include_str!("../../../../../../protocol/ssh-owner/deployment-read-completion.sh");
const HOST_KEY_DIR: &str = "/etc/ssh";
const STDOUT_MAX: usize = 256 * 1024;
const STDERR_MAX: usize = 16 * 1024;

impl Transport {
    pub(in super::super) fn probe_deployment_host(
        &self,
        request: &ProofDeploymentHostProbe,
    ) -> Result<ProofDeploymentHostResult, ErrorCode> {
        self.run_deployment_read(&command(&request.deployment_request_id)?, STDOUT_MAX)
    }

    pub(in super::super) fn read_deployment_completion(
        &self,
        request: &ProofDeploymentCompletion,
    ) -> Result<ProofDeploymentHostResult, ErrorCode> {
        if !valid_request_id(&request.deployment_request_id)
            || request.authority_id.len() != 32
            || !request.authority_id.bytes().all(lower_hex)
        {
            return Err(ErrorCode::InvalidOperands);
        }
        let remote = format!(
            "/bin/sh -c '{}' sh '{}'",
            READ_COMPLETION.replace('\'', "'\\''"),
            request.authority_id
        );
        self.run_deployment_read(&remote, 16 * 1024)
    }

    fn run_deployment_read(
        &self,
        remote: &str,
        stdout_max: usize,
    ) -> Result<ProofDeploymentHostResult, ErrorCode> {
        self.revalidate_policy()?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut pinned = self.pinned_ssh("-T")?;
        pinned.command.args(["-n", "--", &self.host, remote]);
        let output = process::run_with_combined_output_limit(
            pinned.command,
            deadline,
            stdout_max + STDERR_MAX,
        )
        .map_err(|error| match error {
            process::Failure::TimedOut => ErrorCode::ProofDeploymentTimeout,
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            process::Failure::Io => ErrorCode::TransportLost,
        })?;
        decode(output, stdout_max)
    }
}

fn command(id: &str) -> Result<String, ErrorCode> {
    if !valid_request_id(id) {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(format!(
        "/bin/sh -c '{}' sh '{}' '{}'",
        SCRIPT.replace('\'', "'\\''"),
        id,
        HOST_KEY_DIR
    ))
}

fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
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

fn decode(
    output: process::Output,
    stdout_max: usize,
) -> Result<ProofDeploymentHostResult, ErrorCode> {
    if output.truncated || output.stdout.len() > stdout_max || output.stderr.len() > STDERR_MAX {
        return Err(ErrorCode::ProofDeploymentOutputLimit);
    }
    let code = match output.status.code() {
        Some(255) => return Err(ssh_failure(&output.stderr)),
        Some(code @ 0..=254) => code,
        _ => return Err(ErrorCode::TransportLost),
    };
    let bounded = |bytes| String::from_utf8(bytes).map_err(|_| ErrorCode::ListInvalidOutput);
    Ok(ProofDeploymentHostResult {
        code: Some(code),
        stdout: bounded(output.stdout)?,
        stderr: bounded(output.stderr)?,
        state: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    #[test]
    fn fixed_recipe_accepts_only_lowercase_v4_ids() {
        let id = "2e789a0b-6e7b-411b-8d34-4107f1c18902";
        let launch = command(id).expect("valid id");
        assert!(launch.ends_with(&format!(" sh '{id}' '/etc/ssh'")));
        assert!(launch.starts_with("/bin/sh -c 'set -eu"));
        for wrong in [
            "",
            "2e789a0b-6e7b-511b-8d34-4107f1c18902",
            "2E789a0b-6e7b-411b-8d34-4107f1c18902",
            "2e789a0b-6e7b-411b-7d34-4107f1c18902",
            "'; false",
        ] {
            assert_eq!(command(wrong), Err(ErrorCode::InvalidOperands));
        }
    }

    #[test]
    fn ordinary_exit_is_distinct_from_transport_and_each_capture_limit() {
        let output = |code, stdout, stderr| process::Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout,
            stderr,
            truncated: false,
        };
        assert_eq!(
            decode(output(70, Vec::new(), Vec::new()), STDOUT_MAX)
                .expect("recipe exit")
                .code,
            Some(70)
        );
        assert_eq!(
            decode(output(255, Vec::new(), Vec::new()), STDOUT_MAX),
            Err(ErrorCode::TransportLost)
        );
        assert_eq!(
            decode(
                output(0, vec![b'x'; STDOUT_MAX + 1], Vec::new()),
                STDOUT_MAX
            ),
            Err(ErrorCode::ProofDeploymentOutputLimit)
        );
        assert_eq!(
            decode(
                output(0, Vec::new(), vec![b'x'; STDERR_MAX + 1]),
                STDOUT_MAX
            ),
            Err(ErrorCode::ProofDeploymentOutputLimit)
        );
    }
}
