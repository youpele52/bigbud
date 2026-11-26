//! Production per-target agent proxy lane.
//!
//! A production owner has no startup-transferred byte pipes, so a proxy is one
//! private mux session opened on demand over the target's already-verified
//! master. The session carries the owner-selected installed agent command, three
//! private pipes and its own control stream; it never dials a second SSH
//! connection and never forwards a socket.
//!
//! The channel is bounded in both directions: callers grant explicit byte
//! credit, writes and reads beyond that window (or beyond the queue cap) are a
//! typed refusal, and the remote stderr is drained into its own bounded queue so
//! it can never stall or grow without limit. Close is confirmed only by the
//! session's explicit `EXIT_MESSAGE`.
//!
//! The read/credit API is consumed by the per-target byte-transport track and
//! by the focused unit tests; store/close/status are used in product dispatch.
#![allow(dead_code)]

use super::{installed, valid_sha256};
use crate::{
    Token,
    transport::posix_master::{AgentIo, RemoteExit, read_exit},
    v1::{self, ErrorCode},
};
use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    os::fd::AsRawFd,
    path::Path,
    time::{Duration, Instant},
};

/// Maximum outstanding credit per direction. Bounds what a caller can hand to a
/// single write/read before it must return for another grant.
pub(crate) const MAX_CREDITS: u64 = 64 * 1024;
/// Maximum owner-side bytes retained while the remote endpoint is not draining.
pub(crate) const MAX_QUEUE: usize = 64 * 1024;
/// Maximum retained stderr. Beyond this the channel reports truncation and keeps
/// draining instead of blocking the remote agent.
pub(crate) const MAX_STDERR: usize = 16 * 1024;
const READ_CHUNK: usize = 4096;
const MAX_CLOSE_MS: u32 = 5_000;
const POLL: Duration = Duration::from_millis(5);
const TERM_GRACE: Duration = Duration::from_millis(250);

/// The owner-selected installed agent. The binary, digest and state directory
/// are startup facts; the wire carries no command, path or environment.
#[derive(Debug)]
pub(crate) struct ServiceRecipe {
    recipe: installed::Recipe,
}

impl ServiceRecipe {
    pub(crate) fn new(binary: &Path, sha256: &str, state: &Path) -> io::Result<Self> {
        if !valid_sha256(sha256) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid production agent binding",
            ));
        }
        Ok(Self {
            recipe: installed::Recipe::new(binary, sha256, state)?,
        })
    }

    pub(crate) fn command(&self) -> &str {
        self.recipe.command()
    }
}

#[cfg(test)]
#[path = "production.test_support.rs"]
pub(crate) mod test_support;
#[cfg(test)]
#[path = "production.tests.rs"]
mod tests;

/// One live production proxy. Status and close are scoped to the lease token;
/// the owning target's lane is the only place this value is stored.
pub(crate) struct ProductionProxy {
    token: Token,
    pid: u32,
    io: AgentIo,
    input_credits: u64,
    output_credits: u64,
    stdin_pending: VecDeque<u8>,
    stderr: VecDeque<u8>,
    stderr_truncated: bool,
    packet: [u8; 16],
    packet_used: usize,
    exit: Option<RemoteExit>,
    uncertain: bool,
}

impl ProductionProxy {
    pub(crate) fn new(token: Token, pid: u32, io: AgentIo) -> Result<Self, ErrorCode> {
        for fd in [
            io.input.as_raw_fd(),
            io.output.as_raw_fd(),
            io.stderr.as_raw_fd(),
        ] {
            // SAFETY: each descriptor belongs to the owned pipe and this is the
            // only place that changes its status flags.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags == -1
                || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1
            {
                return Err(ErrorCode::OwnerUnavailable);
            }
        }
        Ok(Self {
            token,
            pid,
            io,
            input_credits: 0,
            output_credits: 0,
            stdin_pending: VecDeque::new(),
            stderr: VecDeque::new(),
            stderr_truncated: false,
            packet: [0; 16],
            packet_used: 0,
            exit: None,
            uncertain: false,
        })
    }

    pub(crate) fn lease(&self) -> &Token {
        &self.token
    }

    /// Add to the outstanding input credit window. Never overflows the cap.
    pub(crate) fn grant_input_credit(&mut self, bytes: u64) -> Result<u64, ErrorCode> {
        if self.closed() {
            return Err(ErrorCode::OperationDenied);
        }
        if bytes == 0 || bytes > MAX_CREDITS || self.input_credits > MAX_CREDITS - bytes {
            return Err(ErrorCode::InvalidOperands);
        }
        self.input_credits += bytes;
        Ok(self.input_credits)
    }

    /// Send caller bytes to the remote stdin. Refused before any byte moves when
    /// the credit window or the bounded queue would be exceeded.
    pub(crate) fn send(&mut self, data: &[u8]) -> Result<(), ErrorCode> {
        if self.closed() {
            return Err(ErrorCode::OperationDenied);
        }
        let length = u64::try_from(data.len()).map_err(|_| ErrorCode::InvalidOperands)?;
        if length == 0 || length > self.input_credits {
            return Err(ErrorCode::OperationDenied);
        }
        let queued =
            u64::try_from(self.stdin_pending.len()).map_err(|_| ErrorCode::InvalidOperands)?;
        if queued.saturating_add(length) > MAX_QUEUE as u64 {
            return Err(ErrorCode::OperationDenied);
        }
        self.stdin_pending.extend(data.iter().copied());
        self.input_credits -= length;
        self.flush_input()
    }

    /// Read one bounded chunk of remote stdout. `None` means the peer closed.
    pub(crate) fn receive(&mut self) -> Result<Option<Vec<u8>>, ErrorCode> {
        if self.closed() {
            return Err(ErrorCode::OperationDenied);
        }
        if self.output_credits == 0 {
            return Err(ErrorCode::OperationDenied);
        }
        let limit = usize::try_from(self.output_credits.min(READ_CHUNK as u64))
            .map_err(|_| ErrorCode::InvalidOperands)?;
        let mut buffer = [0u8; READ_CHUNK];
        let target = buffer.get_mut(..limit).ok_or(ErrorCode::InvalidOperands)?;
        loop {
            match self.io.output.read(target) {
                Ok(0) => return Ok(None),
                Ok(read) => {
                    self.output_credits -= read as u64;
                    return Ok(Some(
                        target
                            .get(..read)
                            .ok_or(ErrorCode::InvalidOperands)?
                            .to_vec(),
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    return Ok(Some(Vec::new()));
                }
                Err(_) => {
                    self.uncertain = true;
                    return Err(ErrorCode::OutcomeUnknown);
                }
            }
        }
    }

    pub(crate) fn grant_output_credit(&mut self, bytes: u64) -> Result<u64, ErrorCode> {
        if self.closed() {
            return Err(ErrorCode::OperationDenied);
        }
        if bytes == 0 || bytes > MAX_CREDITS || self.output_credits > MAX_CREDITS - bytes {
            return Err(ErrorCode::InvalidOperands);
        }
        self.output_credits += bytes;
        Ok(self.output_credits)
    }

    /// Drain one bounded chunk of remote stderr into the retained (bounded)
    /// diagnostic queue. Truncation is reported separately and never blocks.
    pub(crate) fn drain_stderr(&mut self) -> Result<usize, ErrorCode> {
        if self.closed() {
            return Ok(0);
        }
        let mut buffer = [0u8; READ_CHUNK];
        loop {
            match self.io.stderr.read(&mut buffer) {
                Ok(0) => return Ok(0),
                Ok(read) => {
                    let room = MAX_STDERR.saturating_sub(self.stderr.len());
                    let keep = read.min(room);
                    self.stderr
                        .extend(buffer.get(..keep).into_iter().flatten().copied());
                    self.stderr_truncated |= keep < read;
                    return Ok(read);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(0),
                Err(_) => return Err(ErrorCode::OutcomeUnknown),
            }
        }
    }

    pub(crate) fn stderr(&mut self) -> (Vec<u8>, bool) {
        let bytes = self.stderr.drain(..).collect();
        (bytes, self.stderr_truncated)
    }

    /// Half-close only the remote stdin. Reads keep draining until exit.
    pub(crate) fn half_close_input(&mut self) -> Result<(), ErrorCode> {
        self.flush_input()?;
        close_stdin(&mut self.io)
    }

    pub(crate) fn status(&mut self) -> Result<v1::ProofAgentProxyStatus, ErrorCode> {
        self.observe_exit();
        Ok(v1::ProofAgentProxyStatus {
            lease: self.token.to_vec(),
            pid: self.pid,
            closed: self.exit.is_some(),
            code: self.exit.and_then(|exit| exit.code),
            signal: self.exit.and_then(|exit| exit.signal),
        })
    }

    /// Confirmed teardown. Graceful half-closes stdin and waits for the explicit
    /// exit; terminate also closes the session channel. A timeout is
    /// `OutcomeUnknown`, never a synthetic success.
    pub(crate) fn close(
        &mut self,
        terminate: bool,
        timeout_ms: u32,
    ) -> Result<v1::ProofAgentProxyStatus, ErrorCode> {
        let timeout = Duration::from_millis(u64::from(timeout_ms.min(MAX_CLOSE_MS)));
        let _ = self.flush_input();
        // EOF on the remote stdin is the graceful request either way.
        close_stdin(&mut self.io)?;
        let deadline = Instant::now() + timeout;
        // A well-behaved agent exits on stdin EOF; give it the whole budget
        // before forcing the session channel closed.
        let grace = deadline.min(Instant::now() + TERM_GRACE);
        loop {
            self.observe_exit();
            if self.exit.is_some() {
                return self.status();
            }
            if Instant::now() >= grace {
                break;
            }
            std::thread::sleep(POLL.min(grace.saturating_duration_since(Instant::now())));
        }
        if terminate {
            // Closing the session control channel is the only local lever for a
            // remote process that ignored EOF; a missing EXIT_MESSAGE stays
            // unconfirmed.
            let _ = self.io.control.shutdown(std::net::Shutdown::Both);
        }
        loop {
            self.observe_exit();
            if self.exit.is_some() {
                return self.status();
            }
            if !terminate || Instant::now() >= deadline {
                self.uncertain = true;
                return Err(ErrorCode::OutcomeUnknown);
            }
            std::thread::sleep(POLL.min(deadline.saturating_duration_since(Instant::now())));
        }
    }

    /// True once an explicit exit or an ambiguous loss has settled this lease.
    pub(crate) fn closed(&self) -> bool {
        self.exit.is_some()
    }

    fn flush_input(&mut self) -> Result<(), ErrorCode> {
        while let Some(&byte) = self.stdin_pending.front() {
            match self.io.input.write(&[byte]) {
                Ok(0) => return Err(ErrorCode::OutcomeUnknown),
                Ok(_) => {
                    self.stdin_pending.pop_front();
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(_) => {
                    self.uncertain = true;
                    return Err(ErrorCode::OutcomeUnknown);
                }
            }
        }
        Ok(())
    }

    fn observe_exit(&mut self) {
        if self.exit.is_some() {
            return;
        }
        let Ok(mut control) = self.io.control.try_clone() else {
            self.uncertain = true;
            return;
        };
        match read_exit(
            &mut control,
            &mut self.packet,
            &mut self.packet_used,
            self.io.session,
        ) {
            Ok(exit) => {
                if exit.is_some() {
                    self.exit = exit;
                }
            }
            Err(_) => {
                // A dropped or malformed control channel cannot settle the
                // remote process; report it as ambiguity, never a fake exit.
                self.uncertain = true;
            }
        }
    }
}

/// Replace the remote stdin writer with a pipe whose only other end is already
/// closed, so the remote session observes EOF without a local child.
fn close_stdin(channel: &mut AgentIo) -> Result<(), ErrorCode> {
    let (reader, writer) = io::pipe().map_err(|_| ErrorCode::OwnerUnavailable)?;
    drop(reader);
    channel.input = writer;
    Ok(())
}

impl Drop for ProductionProxy {
    fn drop(&mut self) {
        // Drop cannot report uncertainty; explicit close does. Closing both
        // endpoints here is best effort and never authorizes another lease.
        let _ = self.io.input.flush();
        let _ = self.io.control.shutdown(std::net::Shutdown::Both);
    }
}
