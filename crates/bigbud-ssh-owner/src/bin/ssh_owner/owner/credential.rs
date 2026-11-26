//! In-app password and key-passphrase entry (v1.credential.proto,
//! Request 190–193, Reply 106–107).
//!
//! The secret never crosses a frame: `credential_unlock_open` makes one
//! private socket (a `mkdtemp` 0700 directory, never TMPDIR or a wire
//! operand), the caller writes the secret to it, and `credential_unlock_commit`
//! reads it from exactly one same-uid connection into a wiped buffer, removes
//! the socket, and hands the bytes to the target's production master, which
//! releases them once to the owner's askpass helper. Attempts are bounded per
//! target generation.
use super::{ErrorCode, Operation, Outcome, Owner};
use crate::{
    Token,
    owner_opencode::ForwardSocket,
    transport::credential::CredentialMode,
    v1::{CredentialKind, CredentialState, CredentialUnlockLease},
};
use std::{
    io::{self, Read},
    os::{fd::AsRawFd, unix::net::UnixListener},
    thread,
    time::{Duration, Instant},
};

/// Rejected attempts one target generation allows.
pub(crate) const MAX_ATTEMPTS: u8 = 3;
/// The caller connects and writes the secret within this bound of the commit.
const SECRET_DEADLINE: Duration = Duration::from_secs(5);
/// Secret bytes (1..=511) plus one byte to detect an oversized write.
const SECRET_BUFFER: usize = 512;
const POLL: Duration = Duration::from_millis(5);

/// One open entry channel of a target. Dropping it removes the socket.
pub(crate) struct Pending {
    lease: Token,
    kind: CredentialMode,
    listener: UnixListener,
    socket: Option<ForwardSocket>,
}

/// Per-target credential lane state, kept in the target's [`super::Lanes`].
#[derive(Default)]
pub(crate) struct CredentialLane {
    pub(crate) pending: Option<Pending>,
    failures: Option<(Token, u8)>,
}

impl CredentialLane {
    fn remaining(&self, generation: Token) -> u8 {
        match self.failures {
            Some((seen, count)) if seen == generation => MAX_ATTEMPTS.saturating_sub(count),
            _ => MAX_ATTEMPTS,
        }
    }

    fn record_failure(&mut self, generation: Token) {
        let count = MAX_ATTEMPTS - self.remaining(generation) + 1;
        self.failures = Some((generation, count));
    }
}

pub(super) fn production_verb(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::InspectCredential(_)
            | Operation::CredentialUnlockOpen(_)
            | Operation::CredentialUnlockCommit(_)
            | Operation::CredentialLock(_)
    )
}

fn wire_kind(mode: CredentialMode) -> CredentialKind {
    match mode {
        CredentialMode::None => CredentialKind::None,
        CredentialMode::Password => CredentialKind::Password,
        CredentialMode::KeyPassphrase => CredentialKind::KeyPassphrase,
    }
}

fn lease_token(bytes: &[u8]) -> Result<Token, ErrorCode> {
    Token::try_from(bytes).map_err(|_| ErrorCode::InvalidOperands)
}

struct Wiped([u8; SECRET_BUFFER]);

impl Drop for Wiped {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            // SAFETY: initialized, exclusively borrowed byte; the volatile write
            // keeps the wipe observable after last use.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

fn same_uid(stream: &std::os::unix::net::UnixStream) -> bool {
    // SAFETY: geteuid takes no arguments.
    let owner = unsafe { libc::geteuid() };
    #[cfg(target_os = "macos")]
    {
        let (mut uid, mut gid) = (0, 0);
        // SAFETY: valid connected socket fd and writable out-parameters.
        let read = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
        read == 0 && uid == owner
    }
    #[cfg(target_os = "linux")]
    {
        let mut credentials = std::mem::MaybeUninit::<libc::ucred>::zeroed();
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: valid socket fd; the out-buffer is a writable `ucred` of `length` bytes.
        let read = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                credentials.as_mut_ptr().cast(),
                &mut length,
            )
        };
        // SAFETY: a successful full-length read initialized the record.
        read == 0
            && length as usize == std::mem::size_of::<libc::ucred>()
            && unsafe { credentials.assume_init() }.uid == owner
    }
}

/// Exactly one same-uid connection, read to EOF; the socket is removed first.
fn receive(pending: &mut Pending, secret: &mut Wiped) -> Result<usize, ErrorCode> {
    let deadline = Instant::now() + SECRET_DEADLINE;
    let stream = loop {
        match pending.listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(ErrorCode::OwnerUnavailable),
        }
        if Instant::now() >= deadline {
            return Err(ErrorCode::InvalidOperands);
        }
        thread::sleep(POLL);
    };
    if let Some(socket) = pending.socket.take() {
        socket.close().map_err(|_| ErrorCode::OwnerUnavailable)?;
    }
    if !same_uid(&stream) {
        return Err(ErrorCode::OperationDenied);
    }
    stream
        .set_read_timeout(Some(SECRET_DEADLINE))
        .map_err(|_| ErrorCode::OwnerUnavailable)?;
    let mut length = 0;
    let mut reader = &stream;
    loop {
        let rest = secret
            .0
            .get_mut(length..)
            .ok_or(ErrorCode::InvalidOperands)?;
        if rest.is_empty() {
            return Err(ErrorCode::InvalidOperands);
        }
        match reader.read(rest) {
            Ok(0) => break,
            Ok(read) => length += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(ErrorCode::InvalidOperands),
        }
        if Instant::now() >= deadline {
            return Err(ErrorCode::InvalidOperands);
        }
    }
    Ok(length)
}

impl Owner {
    pub(super) fn execute_credential(
        &mut self,
        operation: Operation,
    ) -> Result<Outcome, ErrorCode> {
        let generation = self.generation;
        let transport = super::present(&self.transport)?;
        let mode = transport.credential_mode();
        match operation {
            Operation::InspectCredential(_) => Ok(self.credential_state(mode)),
            Operation::CredentialUnlockOpen(open) => {
                let lease = lease_token(&open.lease)?;
                if mode == CredentialMode::None || open.kind() != wire_kind(mode) {
                    return Err(ErrorCode::OperationDenied);
                }
                if self.lanes.credential.remaining(generation) == 0 {
                    return Err(ErrorCode::CredentialAttemptsExhausted);
                }
                // A new entry replaces (and removes) any earlier unused one.
                self.lanes.credential.pending = None;
                let socket = ForwardSocket::new().map_err(|_| ErrorCode::OwnerUnavailable)?;
                let listener =
                    UnixListener::bind(socket.path()).map_err(|_| ErrorCode::OwnerUnavailable)?;
                listener
                    .set_nonblocking(true)
                    .map_err(|_| ErrorCode::OwnerUnavailable)?;
                let socket_path = socket.path().to_string_lossy().into_owned();
                self.lanes.credential.pending = Some(Pending {
                    lease,
                    kind: mode,
                    listener,
                    socket: Some(socket),
                });
                Ok(Outcome::CredentialUnlockLease(CredentialUnlockLease {
                    lease: lease.to_vec(),
                    socket_path,
                }))
            }
            Operation::CredentialUnlockCommit(commit) => {
                let lease = lease_token(&commit.lease)?;
                let mut pending = match self.lanes.credential.pending.take() {
                    Some(pending) if pending.lease == lease && pending.kind == mode => pending,
                    _ => return Err(ErrorCode::OperationDenied),
                };
                if self.lanes.credential.remaining(generation) == 0 {
                    return Err(ErrorCode::CredentialAttemptsExhausted);
                }
                let mut secret = Wiped([0; SECRET_BUFFER]);
                let length = receive(&mut pending, &mut secret)?;
                drop(pending);
                let bytes = secret
                    .0
                    .get_mut(..length)
                    .ok_or(ErrorCode::InvalidOperands)?;
                let master = self
                    .lanes
                    .master
                    .as_mut()
                    .ok_or(ErrorCode::OperationDenied)?;
                let passphrase = mode == CredentialMode::KeyPassphrase;
                match master.unlock_credential(transport, generation, passphrase, bytes) {
                    Ok(()) => {
                        self.lanes.credential.failures = None;
                        Ok(self.credential_state(mode))
                    }
                    Err(ErrorCode::CredentialRejected) => {
                        self.lanes.credential.record_failure(generation);
                        Err(if self.lanes.credential.remaining(generation) == 0 {
                            ErrorCode::CredentialAttemptsExhausted
                        } else {
                            ErrorCode::CredentialRejected
                        })
                    }
                    Err(error) => Err(error),
                }
            }
            Operation::CredentialLock(_) => {
                self.lanes.credential.pending = None;
                if let Some(master) = self.lanes.master.as_mut() {
                    master.lock_credential(generation)?;
                }
                Ok(self.credential_state(mode))
            }
            _ => Err(ErrorCode::OperationDenied),
        }
    }

    fn credential_state(&self, mode: CredentialMode) -> Outcome {
        let transport = self.transport.as_ref();
        let unlocked =
            transport.is_some_and(|transport| transport.credential_mux().get().is_some());
        let identity = match (mode, transport.and_then(|t| t.credential_identity())) {
            (CredentialMode::KeyPassphrase, Some(path)) => path.to_string_lossy().into_owned(),
            _ => String::new(),
        };
        Outcome::CredentialState(CredentialState {
            kind: wire_kind(mode) as i32,
            unlocked,
            attempts_remaining: u32::from(self.lanes.credential.remaining(self.generation)),
            identity,
        })
    }
}

#[cfg(test)]
#[path = "credential.tests.rs"]
mod tests;
