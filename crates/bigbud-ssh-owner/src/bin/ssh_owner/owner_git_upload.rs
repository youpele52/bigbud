//! U15 production Git upload lease worker.
//!
//! One lease is one owner-created private Unix socket (`ForwardSocket`: a
//! `mkdtemp` 0700 directory, never TMPDIR or a wire operand) that admits
//! exactly one connection. That connection becomes the stdin/stdout of one
//! pinned SSH child running a fixed remote guard: it resolves the workspace
//! root and repository with symlinks followed, refuses a repository outside
//! the root, then execs `git-upload-pack` under a fixed environment. No request
//! names a command, argument, environment or socket path. There is no
//! receive-pack path here: push has its own conductor (`owner_git_receive`).

use crate::owner_opencode::ForwardSocket;
use crate::transport::PinnedSsh;
use crate::v1::ErrorCode;
use std::{
    fs,
    io::{self, ErrorKind},
    os::{
        fd::OwnedFd,
        unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
            process::CommandExt,
        },
    },
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_PATH_BYTES: usize = 1024;
/// The client must dial the socket soon after the owner publishes it.
const ACCEPT_DEADLINE: Duration = Duration::from_secs(15);
/// Hard cap for one fetch; the TypeScript caller is bounded at 30 s.
const STREAM_DEADLINE: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(5);
const KILL_GRACE: Duration = Duration::from_millis(500);
/// Remote guard exit codes that mean "refused before git-upload-pack ran".
const GUARD_REFUSED: [i32; 2] = [125, 126];
const GUARD: &str = include_str!("owner_git_upload/guard.sh");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Exited(i32),
    Rejected(ErrorCode),
    Cancelled,
    Lost,
    Unconfirmed,
}

/// An absolute, normalized, control-free path of bounded length.
fn exact(path: &str) -> bool {
    path.len() <= MAX_PATH_BYTES
        && path
            .strip_prefix('/')
            .is_some_and(|rest| !rest.split('/').any(|p| matches!(p, "" | "." | "..")))
        && !path.chars().any(char::is_control)
}

/// Owner-side containment: both paths exact, the root is not `/`, and the
/// repository is the root or lies beneath it. The target re-checks this after
/// resolving symlinks.
pub(crate) fn admits(workspace_root: &str, repository_path: &str) -> bool {
    exact(workspace_root)
        && exact(repository_path)
        && (repository_path == workspace_root
            || repository_path
                .strip_prefix(workspace_root)
                .is_some_and(|rest| rest.starts_with('/')))
}

pub(crate) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn remote_command(workspace_root: &str, repository_path: &str) -> String {
    format!(
        "exec /usr/bin/env -i LC_ALL=C HOME=\"$HOME\" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 \
         GIT_CONFIG_GLOBAL=/dev/null /bin/sh -c {} bigbud-git-upload {} {}",
        quote(GUARD),
        quote(workspace_root),
        quote(repository_path),
    )
}

/// Bind the lease socket (mode 0600 inside the 0700 directory).
pub(crate) fn listen() -> io::Result<(ForwardSocket, UnixListener)> {
    let socket = ForwardSocket::new()?;
    let listener = UnixListener::bind(socket.path())?;
    fs::set_permissions(socket.path(), fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    Ok((socket, listener))
}

/// Why a lease's single connection was not accepted.
pub(crate) enum Unaccepted {
    Cancelled,
    Lost,
    /// The socket path could not be removed; cleanup is uncertain.
    Unconfirmed,
}

/// Accept the lease's one connection within the deadline. The listener and its
/// path are gone before this returns, so there is no second dial. The second
/// value reports whether the socket path was removed.
pub(crate) fn accept_once(
    socket: ForwardSocket,
    listener: UnixListener,
    cancelled: &impl Fn() -> bool,
) -> Result<(UnixStream, io::Result<()>), Unaccepted> {
    let deadline = Instant::now() + ACCEPT_DEADLINE;
    let unaccepted = |socket: ForwardSocket, reason| match socket.close() {
        Ok(()) => reason,
        Err(_) => Unaccepted::Unconfirmed,
    };
    let stream = loop {
        if cancelled() {
            return Err(unaccepted(socket, Unaccepted::Cancelled));
        }
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(e) if e.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(POLL);
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(_) => return Err(unaccepted(socket, Unaccepted::Lost)),
        }
    };
    drop(listener);
    let socket_outcome = socket.close();
    if stream.set_nonblocking(false).is_err() {
        return Err(Unaccepted::Lost);
    }
    Ok((stream, socket_outcome))
}

/// Accept one connection, run the pinned child on it, and settle.
pub(crate) fn run(
    mut pinned: PinnedSsh,
    host: &str,
    command: &str,
    socket: ForwardSocket,
    listener: UnixListener,
    cancelled: impl Fn() -> bool,
    streaming: impl FnOnce(),
) -> Outcome {
    let (stream, socket_outcome) = match accept_once(socket, listener, &cancelled) {
        Ok(accepted) => accepted,
        Err(Unaccepted::Cancelled) => return Outcome::Cancelled,
        Err(Unaccepted::Lost) => return Outcome::Lost,
        Err(Unaccepted::Unconfirmed) => return Outcome::Unconfirmed,
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
    // The command still owns copies of the socket; release them now.
    pinned.command.stdin(Stdio::null()).stdout(Stdio::null());
    let Ok(mut child) = spawned else {
        return Outcome::Rejected(ErrorCode::OwnerUnavailable);
    };
    streaming();
    let outcome = supervise(&mut child, cancelled);
    drop(pinned);
    match socket_outcome {
        Ok(()) => outcome,
        Err(_) => Outcome::Unconfirmed,
    }
}

fn supervise(child: &mut Child, cancelled: impl Fn() -> bool) -> Outcome {
    let deadline = Instant::now() + STREAM_DEADLINE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return match status.code() {
                    Some(code) if GUARD_REFUSED.contains(&code) => {
                        Outcome::Rejected(ErrorCode::OperationDenied)
                    }
                    Some(code) => Outcome::Exited(code),
                    None => Outcome::Lost,
                };
            }
            Ok(None) if cancelled() => return kill(child, Outcome::Cancelled),
            Ok(None) if Instant::now() >= deadline => return kill(child, Outcome::Lost),
            Ok(None) => thread::sleep(POLL),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(_) => return kill(child, Outcome::Unconfirmed),
        }
    }
}

fn kill(child: &mut Child, outcome: Outcome) -> Outcome {
    if kill_group(child) {
        outcome
    } else {
        Outcome::Unconfirmed
    }
}

/// Kill the child's process group and confirm it was reaped within the grace.
pub(crate) fn kill_group(child: &mut Child) -> bool {
    let pid = i32::try_from(child.id()).ok().filter(|&pid| pid > 0);
    // SAFETY: process_group(0) made this child its group leader and it is unreaped.
    if !pid.is_some_and(|pid| unsafe { libc::kill(-pid, libc::SIGKILL) == 0 }) {
        let _kill_requested = child.kill();
    }
    let deadline = Instant::now() + KILL_GRACE;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        thread::sleep(POLL);
    }
    false
}

#[cfg(test)]
#[path = "owner_git_upload/tests.rs"]
mod tests;
