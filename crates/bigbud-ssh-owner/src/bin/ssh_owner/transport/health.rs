use super::{ErrorCode, Transport, process, ssh_failure, v1};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(3);
const CAPTURE_LIMIT: usize = 4 * 1024;

pub(super) fn sample(transport: &Transport) -> Result<v1::ProofHealth, ErrorCode> {
    let deadline = Instant::now() + TIMEOUT;
    transport.revalidate_policy()?;
    let mut pinned = transport.pinned_ssh("-T")?;
    pinned.command.args(health_args(&transport.host));
    let output = process::run_with_combined_output_limit(pinned.command, deadline, CAPTURE_LIMIT)
        .map_err(process_failure)?;
    decode(output, &transport.host, transport.config.port)
}

#[cfg(target_os = "macos")]
impl Transport {
    pub(in super::super) fn sample_health_cancellable(
        &self,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<v1::ProofHealth, ErrorCode> {
        let deadline = Instant::now() + TIMEOUT;
        if is_cancelled() {
            return Err(ErrorCode::HealthCancelled);
        }
        // The cancellable fixture lane owns only this direct SSH invocation;
        // do not consult alias, agent, or hashed-pin preparation paths.
        if self.policy.is_some() || self.proof_agent.is_some() {
            return Err(ErrorCode::ConfigUnsupported);
        }
        let pin = super::trust_store::read_plain(&self.config.known_hosts, &self.host_label)?
            .ok_or(ErrorCode::TrustRequired)?;
        let mut pinned =
            self.ssh_for_pin("-T", None, false, &pin, super::HostVerification::Ed25519Key)?;
        pinned.command.args(health_args(&self.host));
        let output = process::run_with_combined_output_limit_cancellable(
            pinned.command,
            deadline,
            CAPTURE_LIMIT,
            is_cancelled,
        )
        .map_err(cancellable_failure)?;
        decode(output, &self.host, self.config.port)
    }
}

fn health_args(host: &str) -> [&str; 4] {
    ["-n", "--", host, "true"]
}

fn process_failure(error: process::Failure) -> ErrorCode {
    match error {
        // The deadline does not tell us if SSH reached or authenticated to the host.
        process::Failure::TimedOut => ErrorCode::TransportLost,
        process::Failure::Spawn | process::Failure::Io => ErrorCode::OwnerUnavailable,
    }
}

#[cfg(target_os = "macos")]
fn cancellable_failure(failure: process::PickerFailure) -> ErrorCode {
    match failure {
        process::PickerFailure::Cancelled => ErrorCode::HealthCancelled,
        process::PickerFailure::CleanupUnconfirmed => ErrorCode::OutcomeUnknown,
        process::PickerFailure::Process(error) => process_failure(error),
    }
}

fn decode(output: process::Output, host: &str, port: u16) -> Result<v1::ProofHealth, ErrorCode> {
    if output.truncated || output.stdout.len() + output.stderr.len() > CAPTURE_LIMIT {
        return Err(ErrorCode::OwnerUnavailable);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    match ssh_failure(&output.stderr) {
        ErrorCode::TransportLost => {}
        unavailable => return Err(unavailable),
    }
    if stderr
        .lines()
        .any(|line| line.starts_with("Warning: Identity file ") || line.starts_with("Load key "))
    {
        return Err(ErrorCode::AuthRequired);
    }
    if stderr.lines().any(|line| {
        line.starts_with("command-line: ") || line.starts_with("Bad configuration option:")
    }) {
        return Err(ErrorCode::ConfigUnsupported);
    }
    match output.status.code() {
        Some(0) => Ok(v1::ProofHealth { reachable: true }),
        Some(255) if connect_failed(&stderr, host, port) => {
            Ok(v1::ProofHealth { reachable: false })
        }
        Some(255) => Err(ErrorCode::TransportLost),
        _ => Err(ErrorCode::OwnerUnavailable),
    }
}

fn connect_failed(stderr: &str, host: &str, port: u16) -> bool {
    let prefix = format!("ssh: connect to host {host} port {port}: ");
    stderr.lines().any(|line| {
        matches!(
            line.strip_prefix(&prefix),
            Some(
                "Connection refused"
                    | "Connection timed out"
                    | "Operation timed out"
                    | "No route to host"
                    | "Network is unreachable"
                    | "Host is down"
                    | "Connection reset by peer"
            )
        )
    })
}

#[cfg(test)]
mod tests;
