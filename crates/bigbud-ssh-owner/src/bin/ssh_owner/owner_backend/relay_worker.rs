//! One production client relay channel.
//!
//! The accepted lease connection becomes the stdin and stdout of one pinned
//! SSH child running the installed relay recipe, which re-verifies the Node
//! binary and helper hashes before it executes anything. Backpressure is the
//! socket's own: a paused reader stops the child, which stops the remote
//! helper. A half-close ends the child's stdin and leaves its output readable.

use super::{NoConnection, accept_one};
use crate::owner_opencode::ForwardSocket;
use crate::transport::PinnedSsh;
use std::{
    io::ErrorKind,
    os::{
        fd::OwnedFd,
        unix::{net::UnixListener, process::CommandExt},
    },
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

/// A relay channel carries one HTTP or WebSocket connection; it is bounded so
/// a forgotten channel cannot hold a target lane forever.
const CHANNEL_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);
const POLL: Duration = Duration::from_millis(5);
const KILL_GRACE: Duration = Duration::from_millis(500);
/// The relay recipe exits 126 when the pinned installation does not verify.
const RECIPE_REFUSED: i32 = 126;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Exited(u32),
    /// The installation pin did not verify; nothing was executed remotely.
    Refused,
    Closed,
    Lost,
    Unconfirmed,
}

pub(crate) fn run(
    mut pinned: PinnedSsh,
    host: &str,
    command: &str,
    socket: ForwardSocket,
    listener: UnixListener,
    cancelled: impl Fn() -> bool,
    streaming: impl FnOnce(),
) -> Outcome {
    let stream = match accept_one(socket, listener, &cancelled) {
        Ok(stream) => stream,
        Err(NoConnection::Cancelled) => return Outcome::Closed,
        Err(NoConnection::Lost) => return Outcome::Lost,
        Err(NoConnection::Unconfirmed) => return Outcome::Unconfirmed,
    };
    let Ok(input) = stream.try_clone() else {
        return Outcome::Lost;
    };
    let spawned = pinned
        .command
        .args(["--", host, command])
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::from(OwnedFd::from(input)))
        .stdout(Stdio::from(OwnedFd::from(stream)))
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
    // The command still owns copies of the socket; release them now so the
    // caller observes end-of-stream when the child exits.
    pinned.command.stdin(Stdio::null()).stdout(Stdio::null());
    let Ok(mut child) = spawned else {
        return Outcome::Lost;
    };
    streaming();
    let outcome = supervise(&mut child, cancelled);
    drop(pinned);
    outcome
}

fn supervise(child: &mut Child, cancelled: impl Fn() -> bool) -> Outcome {
    let deadline = Instant::now() + CHANNEL_DEADLINE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return match status.code() {
                    Some(RECIPE_REFUSED) => Outcome::Refused,
                    // 255 is OpenSSH's own failure, not the helper's exit.
                    Some(code @ 0..=254) => Outcome::Exited(code.unsigned_abs()),
                    Some(_) | None => Outcome::Lost,
                };
            }
            Ok(None) if cancelled() => return kill(child, Outcome::Closed),
            Ok(None) if Instant::now() >= deadline => return kill(child, Outcome::Lost),
            Ok(None) => thread::sleep(POLL),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(_) => return kill(child, Outcome::Unconfirmed),
        }
    }
}

fn kill(child: &mut Child, outcome: Outcome) -> Outcome {
    let pid = i32::try_from(child.id()).ok().filter(|&pid| pid > 0);
    // SAFETY: process_group(0) made this child its group leader and it is unreaped.
    if !pid.is_some_and(|pid| unsafe { libc::kill(-pid, libc::SIGKILL) == 0 }) {
        let _kill_requested = child.kill();
    }
    let deadline = Instant::now() + KILL_GRACE;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return outcome;
        }
        thread::sleep(POLL);
    }
    Outcome::Unconfirmed
}

#[cfg(test)]
#[path = "relay_worker/tests.rs"]
mod tests;
