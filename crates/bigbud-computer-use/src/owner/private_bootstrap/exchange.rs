use super::io::{invalid, remaining, wait, write_all};
use crate::{
    Role,
    owner::{BootstrapCapability, unix_bootstrap::read_frame, unix_peer::ensure_private_fd},
    worker::ExecutionRoot,
};
use std::{
    io::{self, Read},
    os::unix::net::UnixStream,
    time::Instant,
};

// Only launch.rs (requiring the unforgeable permit) or same-process tests enter.
// By-value ownership burns the entire courier even on a failed attempt.
pub(super) struct ParentExchange {
    pub(super) courier: UnixStream,
    pub(super) deadline: Instant,
}
impl ParentExchange {
    pub(super) fn pair(deadline: Instant) -> io::Result<(Self, UnixStream)> {
        remaining(deadline)?;
        // std establishes CLOEXEC. Darwin's creation/flag window still requires
        // the not-yet-implemented process-wide launch exclusion.
        let (parent, child) = UnixStream::pair()?;
        ensure_private_fd(&parent)?;
        ensure_private_fd(&child)?;
        parent.set_nonblocking(true)?;
        child.set_nonblocking(true)?;
        remaining(deadline)?;
        Ok((
            Self {
                courier: parent,
                deadline,
            },
            child,
        ))
    }

    pub(super) fn deliver_routed(
        self,
        root: ExecutionRoot,
        role: Role,
        route: &super::route::Route,
    ) -> io::Result<BootstrapCapability> {
        write_all(&self.courier, &route.encode()?, self.deadline)?;
        self.deliver(root, role)
    }

    pub(super) fn deliver(
        self,
        root: ExecutionRoot,
        role: Role,
    ) -> io::Result<BootstrapCapability> {
        let (capability, secret) = BootstrapCapability::issue_before(root, role, self.deadline)?;
        send_handshake(&self.courier, role, &secret, self.deadline)?;
        // The parent never receives data or ancillary descriptors on this
        // courier. All copies except this one were closed after the spawn.
        drop(self.courier);
        Ok(capability)
    }
}

/// One-use credential, deliberately not Clone/Debug and without a token getter.
/// It is not an authenticated peer or proof of the parent's current lifetime.
/// Only the separate post-exec connection can establish the child's kernel PID.
pub struct ChildCredential {
    role: Role,
    token: [u8; 32],
    deadline: Instant,
}
impl ChildCredential {
    /// Only the private routed bootstrap may send in production, after verifying
    /// the server's kernel UID/PID/creation against the inherited routing prelude.
    /// Same-process tests retain direct access to exercise credential regressions.
    pub(super) fn send(self, stream: UnixStream) -> io::Result<UnixStream> {
        ensure_private_fd(&stream)?;
        send_handshake(&stream, self.role, &self.token, self.deadline)?;
        Ok(stream)
    }
}

pub(super) fn child_read(
    mut courier: UnixStream,
    deadline: Instant,
) -> io::Result<ChildCredential> {
    ensure_private_fd(&courier)?;
    // The sole writer may already be closed. Darwin can reject SO_RCVTIMEO on
    // that socket even with buffered bytes, so reuse the exact bounded parser
    // with a nonblocking/poll adapter rather than the authenticated-peer adapter.
    courier.set_nonblocking(true)?;
    let (role, token) = read_frame(deadline, Instant::now, |bytes, _remaining| {
        match courier.read(bytes) {
            Err(error) if super::io::retry(&error) => {
                wait(&courier, libc::POLLIN, deadline)?;
                Err(error)
            }
            result => result,
        }
    })?;
    // Require the sole authorized writer to close after the exact frame. No
    // hidden extra authority/secret bytes may trail it, even if delivered later.
    courier.set_nonblocking(true)?;
    loop {
        remaining(deadline)?;
        let result = courier.read(&mut [0]);
        remaining(deadline)?;
        match result {
            Ok(0) => break,
            Ok(_) => return Err(invalid()),
            Err(error) if super::io::retry(&error) => wait(&courier, libc::POLLIN, deadline)?,
            Err(error) => return Err(error),
        }
    }
    drop(courier);
    Ok(ChildCredential {
        role,
        token,
        deadline,
    })
}

fn send_handshake(
    stream: &UnixStream,
    role: Role,
    token: &[u8; 32],
    deadline: Instant,
) -> io::Result<()> {
    let mut frame = [0; 38];
    frame[..4].copy_from_slice(&34_u32.to_be_bytes());
    frame[4] = 1;
    frame[5] = match role {
        Role::Guard => 1,
        Role::Owner => 2,
        Role::Worker => 3,
        Role::Broker => 4,
    };
    frame[6..].copy_from_slice(token);
    write_all(stream, &frame, deadline)
}
