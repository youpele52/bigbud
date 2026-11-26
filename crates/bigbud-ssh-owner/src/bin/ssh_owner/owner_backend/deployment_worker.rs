//! One production deployment step, run on its own worker thread.
//!
//! The pinned child runs the owner-compiled recipe under its fixed deadline
//! with bounded output. Streamed input comes from the single accepted lease
//! connection, never from a frame. A dispatched step that cannot prove its
//! result settles `Unknown` and is never replayed.

use super::deployment_recipe::Recipe;
use super::{NoConnection, accept_one};
use crate::owner_opencode::ForwardSocket;
use crate::transport::{PinnedSsh, StepRun, run_backend_step};
use crate::v1::ErrorCode;
use std::{
    os::{fd::OwnedFd, unix::net::UnixListener},
    process::Stdio,
    time::Instant,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Settled {
    Exited {
        code: u32,
        stdout: String,
        stderr: String,
    },
    Cancelled,
    Unknown,
    Rejected(ErrorCode),
}

/// Run one step. `running` fires once the child is about to start, so a
/// status read can tell a listening lease from a dispatched one.
pub(crate) fn run(
    mut pinned: PinnedSsh,
    host: &str,
    recipe: Recipe,
    input: Option<(ForwardSocket, UnixListener)>,
    cancelled: impl Fn() -> bool,
    running: impl FnOnce(),
) -> Settled {
    let stdin = match input {
        None => Stdio::null(),
        Some((socket, listener)) => match accept_one(socket, listener, &cancelled) {
            Ok(stream) => Stdio::from(OwnedFd::from(stream)),
            // Nothing was dispatched: the remote step never started.
            Err(NoConnection::Cancelled) => return Settled::Cancelled,
            Err(NoConnection::Lost) => return Settled::Rejected(ErrorCode::OperationDenied),
            Err(NoConnection::Unconfirmed) => return Settled::Unknown,
        },
    };
    pinned
        .command
        .args(["--", host, &recipe.command])
        .env_clear()
        .env("LC_ALL", "C");
    running();
    let deadline = Instant::now() + recipe.deadline;
    let settled = match run_backend_step(
        &mut pinned.command,
        stdin,
        deadline,
        recipe.stdout_limit,
        cancelled,
    ) {
        // Output is reported as text. A stray non-UTF-8 byte must not turn a
        // confirmed exit into an unknown outcome, so it is replaced.
        StepRun::Exited {
            code,
            stdout,
            stderr,
        } => Settled::Exited {
            code,
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        },
        StepRun::Cancelled => Settled::Cancelled,
        StepRun::Unknown => Settled::Unknown,
        StepRun::Refused(code) => Settled::Rejected(code),
    };
    drop(pinned);
    settled
}

#[cfg(test)]
#[path = "deployment_worker/tests.rs"]
mod tests;
