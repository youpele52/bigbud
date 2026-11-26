use std::{
    io::{self, Read, Write},
    os::fd::{AsRawFd, OwnedFd, RawFd},
    os::unix::net::UnixStream,
    os::unix::process::CommandExt,
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

use super::{
    CHANNEL_TIMEOUT, LaunchAttempt, MAX_CREDITS, REAP_TIMEOUT, TransferAuthority, TransferGrant,
    TransferOperands, TransferVerb, validate_launch,
};
use crate::{
    Token,
    v1::{self, ErrorCode},
};

/// The fixed native peer program. The worker never selects it.
const PEER_PROGRAM: &str = "/bin/cat";
const POLL: Duration = Duration::from_millis(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TransferExit {
    pub(super) code: Option<i32>,
    pub(super) signal: Option<i32>,
    pub(super) cancelled: bool,
}
/// A scoped duplex between this native owner process and one supervised native
/// child. The owner keeps the only other descriptor; content bytes exist only
/// on the socket and never in a protobuf control message.
pub(super) struct StreamFixture {
    transfer_id: Token,
    lease: Token,
    child: Child,
    stream: UnixStream,
    max_bytes: u64,
    credits: u64,
    sent: u64,
    received: u64,
    write_closed: bool,
    peer_closed: bool,
    sequence: u64,
    settled: bool,
    uncertain: bool,
    exit: Option<TransferExit>,
    exit_taken: bool,
}

impl StreamFixture {
    pub(super) fn open(
        mut grant: TransferGrant,
        operands: &TransferOperands,
        attempt: &LaunchAttempt,
    ) -> Result<Self, ErrorCode> {
        validate_launch(attempt)?;
        if grant.authority() != TransferAuthority::NativeChannel {
            return Err(ErrorCode::OperationDenied);
        }
        grant.enter(TransferVerb::Stream)?;
        let lease = crate::random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
        let (stream, peer) = UnixStream::pair().map_err(|_| ErrorCode::OwnerUnavailable)?;
        protect(stream.as_raw_fd()).map_err(|_| ErrorCode::OwnerUnavailable)?;
        stream
            .set_read_timeout(Some(CHANNEL_TIMEOUT))
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        stream
            .set_write_timeout(Some(CHANNEL_TIMEOUT))
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        let peer = OwnedFd::from(peer);
        let stdin = peer.try_clone().map_err(|_| ErrorCode::OwnerUnavailable)?;
        // The fixed peer echoes stdin to stdout over the same socket pair.
        let child = Command::new(PEER_PROGRAM)
            .env_clear()
            .env("LC_ALL", "C")
            .stdin(Stdio::from(stdin))
            .stdout(Stdio::from(peer))
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        Ok(Self {
            transfer_id: grant.transfer_id(),
            lease,
            child,
            stream,
            max_bytes: operands.max_bytes,
            credits: 0,
            sent: 0,
            received: 0,
            write_closed: false,
            peer_closed: false,
            sequence: 0,
            settled: false,
            uncertain: false,
            exit: None,
            exit_taken: false,
        })
    }

    pub(super) fn lease(&self) -> &Token {
        &self.lease
    }

    /// The owner-side descriptor is protected: it stays private to this process
    /// and is never inherited by an unrelated child.
    pub(super) fn protected(&self) -> io::Result<bool> {
        // SAFETY: the fd belongs to this live `UnixStream`; fcntl only reads the
        // descriptor flag word.
        let flags = unsafe { libc::fcntl(self.stream.as_raw_fd(), libc::F_GETFD) };
        if flags == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(flags & libc::FD_CLOEXEC != 0)
    }

    /// Add to the outstanding bounded credit window.
    pub(super) fn grant_credit(&mut self, bytes: u64) -> Result<u64, ErrorCode> {
        self.require_writable()?;
        // Never overflow on an attacker-sized operand: compare before adding.
        if bytes == 0 || bytes > MAX_CREDITS || self.credits > MAX_CREDITS - bytes {
            return Err(ErrorCode::InvalidOperands);
        }
        self.sequence += 1;
        self.credits += bytes;
        Ok(self.credits)
    }

    /// Send content to the native peer. Refused before any byte is written when
    /// the credit window or the operand byte ceiling would be exceeded.
    pub(super) fn send(&mut self, data: &[u8]) -> Result<(), ErrorCode> {
        self.require_writable()?;
        let len = u64::try_from(data.len()).map_err(|_| ErrorCode::InvalidOperands)?;
        if len == 0 || len > self.credits || self.sent.saturating_add(len) > self.max_bytes {
            return Err(ErrorCode::InvalidOperands);
        }
        if self.stream.write_all(data).is_err() {
            // A partial write is an ambiguous transport outcome; never replay it.
            self.uncertain = true;
            self.settled = true;
            return Err(ErrorCode::OutcomeUnknown);
        }
        self.credits -= len;
        self.sent += len;
        self.sequence += 1;
        Ok(())
    }

    /// Read one chunk of the peer's response. `None` means the peer closed.
    pub(super) fn receive(&mut self) -> Result<Option<Vec<u8>>, ErrorCode> {
        self.require_live()?;
        let mut buffer = [0; 4096];
        loop {
            match self.stream.read(&mut buffer) {
                Ok(0) => {
                    self.peer_closed = true;
                    self.sequence += 1;
                    return Ok(None);
                }
                Ok(read) => {
                    self.received += u64::try_from(read).map_err(|_| ErrorCode::InvalidOperands)?;
                    self.sequence += 1;
                    return Ok(Some(buffer[..read].to_vec()));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    // A timeout or reset is ambiguous for this lease.
                    self.uncertain = true;
                    self.settled = true;
                    return Err(ErrorCode::OutcomeUnknown);
                }
            }
        }
    }

    /// Close the write direction only; reads keep draining.
    pub(super) fn half_close(&mut self) -> Result<(), ErrorCode> {
        self.require_writable()?;
        self.stream
            .shutdown(std::net::Shutdown::Write)
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        self.write_closed = true;
        self.sequence += 1;
        Ok(())
    }

    /// Cancel exactly this lease and reap its tree. The result is terminal even
    /// when the reap cannot be confirmed; an unknown outcome is never replayed.
    pub(super) fn cancel(&mut self, lease: &[u8]) -> Result<(), ErrorCode> {
        if lease != self.lease.as_slice() {
            return Err(ErrorCode::OperationDenied);
        }
        if self.settled {
            return Err(ErrorCode::OperationDenied);
        }
        self.signal_tree(libc::SIGKILL);
        if self.reap_until(Instant::now() + REAP_TIMEOUT)? {
            self.exit = Some(TransferExit {
                code: None,
                signal: Some(libc::SIGKILL),
                cancelled: true,
            });
            self.settled = true;
            Ok(())
        } else {
            self.uncertain = true;
            self.settled = true;
            Err(ErrorCode::OutcomeUnknown)
        }
    }

    /// Wait for the peer to exit and record its exact status once.
    pub(super) fn finish(&mut self) -> Result<TransferExit, ErrorCode> {
        if self.settled || self.exit.is_some() {
            return Err(ErrorCode::OperationDenied);
        }
        if !self.reap_until(Instant::now() + REAP_TIMEOUT)? {
            self.uncertain = true;
            self.settled = true;
            return Err(ErrorCode::OutcomeUnknown);
        }
        self.settled = true;
        self.exit.clone().ok_or(ErrorCode::OperationDenied)
    }

    /// The explicit exit. Available exactly once after a settled outcome.
    pub(super) fn exit(&mut self) -> Result<TransferExit, ErrorCode> {
        if self.uncertain {
            return Err(ErrorCode::OutcomeUnknown);
        }
        if !self.settled || self.exit_taken {
            return Err(ErrorCode::OperationDenied);
        }
        self.exit_taken = true;
        self.exit.clone().ok_or(ErrorCode::OperationDenied)
    }

    /// Simulate a control-transport loss during cancel: the tree is signalled
    /// but the outcome can never be confirmed, so it is terminal and unknown.
    pub(super) fn mark_transport_lost(&mut self) {
        self.signal_tree(libc::SIGKILL);
        self.uncertain = true;
        self.settled = true;
    }

    pub(super) fn state(&self) -> v1::ProofTransferStreamState {
        v1::ProofTransferStreamState {
            lease: self.lease.to_vec(),
            sequence: self.sequence,
            credits: self.credits,
            sent: self.sent,
            received: self.received,
            write_closed: self.write_closed,
            peer_closed: self.peer_closed,
            cancelled: self.exit.as_ref().is_some_and(|exit| exit.cancelled),
            exited: self.exit.is_some(),
            exit_code: self.exit.as_ref().and_then(|exit| exit.code),
            exit_signal: self.exit.as_ref().and_then(|exit| exit.signal),
        }
    }

    /// The typed control the worker may send. It has no content field.
    #[cfg(test)]
    pub(super) fn control(
        &self,
        action: v1::proof_transfer_stream_control::Action,
    ) -> v1::ProofTransferStreamControl {
        v1::ProofTransferStreamControl {
            lease: self.lease.to_vec(),
            sequence: self.sequence,
            action: Some(action),
        }
    }

    #[cfg(test)]
    pub(super) fn transfer_id(&self) -> Token {
        self.transfer_id
    }

    #[cfg(test)]
    pub(super) fn peer_eof(&self) -> bool {
        self.peer_closed
    }

    fn require_live(&self) -> Result<(), ErrorCode> {
        if self.settled || self.uncertain {
            return Err(ErrorCode::OperationDenied);
        }
        Ok(())
    }

    fn require_writable(&self) -> Result<(), ErrorCode> {
        self.require_live()?;
        if self.write_closed {
            return Err(ErrorCode::OperationDenied);
        }
        Ok(())
    }

    fn signal_tree(&self, signal: i32) {
        if let Ok(pid) = i32::try_from(self.child.id()) {
            // SAFETY: a negative pid targets only the process group the owner
            // created for this lease. The leader is our direct child and is
            // never reaped before this call.
            let _signalled = unsafe { libc::kill(-pid, signal) };
        }
    }

    fn reap_until(&mut self, deadline: Instant) -> Result<bool, ErrorCode> {
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    self.exit = Some(status.into());
                    return Ok(true);
                }
                Ok(None) => {}
                Err(_) => return Err(ErrorCode::OutcomeUnknown),
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            std::thread::sleep(remaining.min(POLL));
        }
    }
}

impl From<ExitStatus> for TransferExit {
    fn from(status: ExitStatus) -> Self {
        use std::os::unix::process::ExitStatusExt;
        Self {
            code: status.code(),
            signal: status.signal(),
            cancelled: false,
        }
    }
}

impl Drop for StreamFixture {
    fn drop(&mut self) {
        self.signal_tree(libc::SIGKILL);
        let _reaped = self.reap_until(Instant::now() + REAP_TIMEOUT);
    }
}

/// Mark the owner-side descriptor close-on-exec so no unrelated child inherits
/// the private channel.
fn protect(fd: RawFd) -> io::Result<()> {
    // SAFETY: `fd` is a live descriptor owned by the caller for this call.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: same descriptor; F_SETFD only changes its descriptor flags.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
