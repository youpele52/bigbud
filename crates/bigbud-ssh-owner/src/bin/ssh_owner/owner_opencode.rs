//! Shared OpenCode lease plumbing for the owner.
//!
//! The OpenCode v2 recipe uses one verified pattern: a private forward socket,
//! a pinned SSH child that may add exactly one `-L` to a loopback endpoint, a
//! nonce-framed receipt channel, and confirmed teardown. The recipe supplies the
//! remote command, the owner-selected endpoint and the readiness evidence.

#[path = "owner_opencode/control.rs"]
mod control;
#[path = "owner_opencode/local.rs"]
mod local;
#[path = "owner_opencode/session.rs"]
mod session;
#[cfg(test)]
#[path = "owner_opencode/tests.rs"]
mod tests;

pub(super) use control::{Control, Receipt};
pub(super) use local::{ForwardSocket, SshChild};
pub(super) use session::{Ready, ReadyFailure, ReadyPort, run};

use bigbud_ssh_owner::opencode_v1::Bridge;
use std::time::Duration;

pub(super) const POLL: Duration = Duration::from_millis(5);
pub(super) const HEARTBEAT: Duration = Duration::from_millis(500);
pub(super) const STOP_GRACE: Duration = Duration::from_millis(900);
/// Bounded stdout + stderr retained before readiness settles.
pub(super) const OUTPUT_LIMIT: usize = 16_384;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    Rejected(crate::v1::ErrorCode),
    Exited(i32),
    Lost,
    Cancelled,
    Unconfirmed,
}

pub(super) fn unavailable() -> Outcome {
    Outcome::Rejected(crate::v1::ErrorCode::OwnerUnavailable)
}

pub(super) fn finish_bridge(bridge: Bridge, outcome: Outcome) -> Outcome {
    if bridge.shutdown().is_ok() {
        outcome
    } else {
        Outcome::Unconfirmed
    }
}

pub(super) fn finish_socket(socket: ForwardSocket, outcome: Outcome) -> Outcome {
    match socket.close() {
        Ok(()) => outcome,
        Err(_) => Outcome::Unconfirmed,
    }
}

pub(super) fn settle(
    trigger: Outcome,
    launched: bool,
    ready: bool,
    receipt: Option<Receipt>,
) -> Outcome {
    match (trigger, launched, receipt) {
        (Outcome::Unconfirmed, _, _) => Outcome::Unconfirmed,
        (Outcome::Cancelled, true, None) => Outcome::Unconfirmed,
        (_, true, None) => Outcome::Lost,
        (Outcome::Lost, _, receipt) if ready => receipt
            .and_then(Receipt::exit_code)
            .map_or(Outcome::Lost, Outcome::Exited),
        (outcome, _, _) => outcome,
    }
}

pub(super) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) fn hex(token: &[u8; 32]) -> String {
    use std::fmt::Write;
    let mut result = String::with_capacity(64);
    for byte in token {
        let _infallible = write!(result, "{byte:02x}");
    }
    result
}
