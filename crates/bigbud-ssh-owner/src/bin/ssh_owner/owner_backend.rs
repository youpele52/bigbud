//! W2 T-backend production lease workers: remote backend deployment steps and
//! client relay channels.
//!
//! Both lanes follow the U15 byte-channel rule: when a lease carries bytes, the
//! owner creates one private Unix socket (`ForwardSocket`: a `mkdtemp` 0700
//! directory, never TMPDIR or a wire operand) that admits exactly one
//! connection within a bound, then removes the socket path before the pinned
//! child runs. No request names a command, argument, environment or socket.

pub(crate) mod deployment_operands;
pub(crate) mod deployment_recipe;
pub(crate) mod deployment_worker;
pub(crate) mod relay_worker;

use crate::owner_opencode::ForwardSocket;
use std::{
    io::ErrorKind,
    os::unix::net::{UnixListener, UnixStream},
    thread,
    time::{Duration, Instant},
};

/// The caller must dial the lease socket soon after the owner publishes it.
pub(crate) const ACCEPT_DEADLINE: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(5);

/// Why no connection was accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NoConnection {
    Cancelled,
    /// Deadline or listener failure. The socket was removed.
    Lost,
    /// The socket path could not be removed.
    Unconfirmed,
}

/// Accept exactly one connection, then remove the listener and its path so no
/// second dial can reach this lease.
pub(crate) fn accept_one(
    socket: ForwardSocket,
    listener: UnixListener,
    cancelled: &impl Fn() -> bool,
) -> Result<UnixStream, NoConnection> {
    let deadline = Instant::now() + ACCEPT_DEADLINE;
    let accepted = loop {
        if cancelled() {
            break Err(NoConnection::Cancelled);
        }
        match listener.accept() {
            Ok((stream, _)) => break Ok(stream),
            Err(e) if e.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(POLL);
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(_) => break Err(NoConnection::Lost),
        }
    };
    drop(listener);
    if socket.close().is_err() {
        return Err(NoConnection::Unconfirmed);
    }
    let stream = accepted?;
    stream
        .set_nonblocking(false)
        .map_err(|_| NoConnection::Lost)?;
    Ok(stream)
}
