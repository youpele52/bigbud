//! One-attempt role/lifetime-bound bootstrap capabilities. No listener, endpoint
//! publication or renderer/provider authority is created by these primitives.
use super::{
    unix_bootstrap::read_handshake,
    unix_peer::{ensure_private_fd, peer_credentials},
};
use crate::{
    Role,
    worker::{ExecutionRoot, unix::inspect},
};
use std::{
    fs::File,
    io::{self, Read},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

const TOKEN_BYTES: usize = 32;
const BOOTSTRAP_BUDGET: Duration = Duration::from_secs(10);

/// Deliberately not Debug/Clone: never log or duplicate bootstrap authority.
pub struct BootstrapCapability {
    secret: Option<[u8; TOKEN_BYTES]>,
    expected: ExecutionRoot,
    role: Role,
    uid: u32,
    deadline: Instant,
}

pub struct AuthenticatedPeer {
    pub(super) stream: UnixStream,
    pub(super) role: Role,
    pub(super) expected: ExecutionRoot,
}
impl AuthenticatedPeer {
    /// The trusted issuance binding, not a peer-supplied generation claim.
    pub fn execution_root(&self) -> &ExecutionRoot {
        &self.expected
    }
}
impl BootstrapCapability {
    /// Return secret only to the trusted spawn/bootstrap owner. Its delivery
    /// must use a dedicated inherited-once bootstrap FD, NOT argv/env/logs.
    pub fn issue(expected: ExecutionRoot, role: Role) -> io::Result<(Self, [u8; TOKEN_BYTES])> {
        Self::issue_before(expected, role, Self::startup_deadline()?)
    }
    pub(super) fn startup_deadline() -> io::Result<Instant> {
        Instant::now()
            .checked_add(BOOTSTRAP_BUDGET)
            .ok_or_else(|| io::Error::other("bootstrap deadline overflow"))
    }
    pub(super) fn issue_before(
        expected: ExecutionRoot,
        role: Role,
        deadline: Instant,
    ) -> io::Result<(Self, [u8; TOKEN_BYTES])> {
        if Instant::now() >= deadline {
            return Err(denied());
        }
        let mut secret = [0; TOKEN_BYTES];
        File::open("/dev/urandom")?.read_exact(&mut secret)?;
        // SAFETY: geteuid takes no pointers and has no failure result.
        let uid = unsafe { libc::geteuid() };
        let capability = Self::new(expected, role, uid, secret, deadline)?;
        Ok((capability, secret))
    }
    fn new(
        expected: ExecutionRoot,
        role: Role,
        uid: u32,
        secret: [u8; TOKEN_BYTES],
        deadline: Instant,
    ) -> io::Result<Self> {
        if !expected.valid() || expected.pid.get() <= 1 || expected.pid.get() > i32::MAX as u32 {
            return Err(denied());
        }
        Ok(Self {
            secret: Some(secret),
            expected,
            role,
            uid,
            deadline,
        })
    }
    /// Takes exclusive ownership of the trusted bootstrap endpoint. Burns the
    /// capability BEFORE descriptor checks or reads, including timeout/EOF/error.
    /// Uses the issuance deadline for every partial read and final identity check.
    /// No constructor publishes an endpoint or starts a thread. The trusted
    /// launcher must still deliver the secret over a dedicated inherited-once FD;
    /// never argv/environment/logs. No executable role is wired to this API yet.
    ///
    /// A caller cannot authenticate using a claimed pre-read token instead:
    /// ```compile_fail
    /// use bigbud_computer_use::{owner::BootstrapCapability, Role};
    /// use std::os::unix::net::UnixStream;
    /// fn bypass(cap: &mut BootstrapCapability, stream: UnixStream) {
    ///     cap.authenticate(stream, Role::Worker, &[0; 32]);
    /// }
    /// ```
    pub fn authenticate_stream(&mut self, stream: UnixStream) -> io::Result<AuthenticatedPeer> {
        let secret = self.secret.take().ok_or_else(denied)?;
        self.verify_endpoint(&stream)?;
        let (role, token) = read_handshake(&stream, self.deadline)?;
        self.finish(stream, role, &token, &secret)
    }

    // Retained solely for the independently mutation-checked negative fixtures.
    // Production callers cannot bypass the bounded stream bootstrap.
    #[cfg(test)]
    fn authenticate(
        &mut self,
        stream: UnixStream,
        role: Role,
        token: &[u8],
    ) -> io::Result<AuthenticatedPeer> {
        let secret = self.secret.take().ok_or_else(denied)?;
        self.finish(stream, role, token, &secret)
    }
    fn finish(
        &self,
        stream: UnixStream,
        role: Role,
        token: &[u8],
        secret: &[u8; TOKEN_BYTES],
    ) -> io::Result<AuthenticatedPeer> {
        if !self.matches(role, token, secret, Instant::now()) {
            return Err(denied());
        }
        self.verify_endpoint(&stream)?;
        Ok(AuthenticatedPeer {
            stream,
            role,
            expected: self.expected.clone(),
        })
    }
    fn verify_endpoint(&self, stream: &UnixStream) -> io::Result<()> {
        if Instant::now() >= self.deadline {
            return Err(denied());
        }
        ensure_private_fd(stream)?;
        let credentials = peer_credentials(stream)?;
        if credentials.uid != self.uid || credentials.pid != self.expected.pid {
            return Err(denied());
        }
        let observed = inspect(credentials.pid)?;
        if observed.creation != self.expected.creation_identity || Instant::now() >= self.deadline {
            return Err(denied());
        }
        Ok(())
    }
    fn matches(
        &self,
        role: Role,
        supplied: &[u8],
        secret: &[u8; TOKEN_BYTES],
        now: Instant,
    ) -> bool {
        if now >= self.deadline || role != self.role || supplied.len() != TOKEN_BYTES {
            return false;
        }
        let difference = supplied
            .iter()
            .zip(secret)
            .fold(0_u8, |diff, (a, b)| diff | (a ^ b));
        difference == 0
    }
}
fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "bootstrap authentication refused",
    )
}

#[cfg(test)]
#[path = "unix_auth.stream.tests.rs"]
mod stream_tests;
#[cfg(test)]
#[path = "unix_auth.tests.rs"]
mod tests;
