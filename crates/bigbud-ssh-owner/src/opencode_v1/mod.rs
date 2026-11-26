//! Startup gate for an owner-admitted OpenCode v1 `serve` lease.
//!
//! This does not spawn SSH or copy application traffic. The lease controller must
//! exclusively serve the retained listener through its pinned transport to
//! `REMOTE_ENDPOINT`, feed output from that same child, and fence publication on
//! child liveness and target generation. The controller owns cancellation,
//! connection limits, and confirmed bridge/child teardown.

mod bridge;
mod health;
#[cfg(test)]
mod tests;

pub use bridge::Bridge;

use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::time::{Duration, Instant};

pub const REMOTE_ENDPOINT: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 4096);
const START_TIMEOUT: Duration = Duration::from_secs(8);
const OUTPUT_LIMIT: usize = 16_384;
const MARKER: &[u8] = b"opencode server listening on http://127.0.0.1:4096";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartupError {
    Cancelled,
    TimedOut,
    OutputLimit,
    InvalidHealthResponse,
}

/// Retains the kernel-selected local port; it is never released for rebinding
/// between selection and forwarding. No remote or local bind address comes
/// from the request, child output, ambient configuration, or HTTP response.
pub struct Startup {
    listener: TcpListener,
    endpoint: SocketAddrV4,
    deadline: Instant,
    output_bytes: usize,
    line: Option<usize>,
    announced: bool,
    settled: Option<Result<u16, StartupError>>,
}

impl Startup {
    pub fn reserve() -> io::Result<Self> {
        let deadline = Instant::now() + START_TIMEOUT;
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let std::net::SocketAddr::V4(endpoint) = listener.local_addr()? else {
            return Err(io::Error::other("unexpected OpenCode listener family"));
        };
        Ok(Self {
            listener,
            endpoint,
            deadline,
            output_bytes: 0,
            line: Some(0),
            announced: false,
            settled: None,
        })
    }

    /// For the lease controller's pinned bridge, not for publication to the SDK.
    /// The controller must retain this reservation and close any accepted sockets
    /// and listener clones before confirming cancellation.
    pub fn listener(&self) -> &TcpListener {
        &self.listener
    }

    /// Feed both child streams in bounded chunks. Only an exact complete stdout
    /// line can announce readiness; stderr is counted but never interpreted.
    /// After settlement the controller must continue draining without retention.
    pub fn stdout(&mut self, bytes: &[u8]) -> Result<(), StartupError> {
        self.charge(bytes.len())?;
        if self.settled.is_some() || self.announced {
            return Ok(());
        }
        for &byte in bytes {
            if byte == b'\n' {
                if matches!(self.line, Some(n) if n == MARKER.len() || n == MARKER.len() + 1) {
                    self.announced = true;
                    break;
                }
                self.line = Some(0);
            } else {
                self.line = self.line.and_then(|n| {
                    (MARKER.get(n) == Some(&byte) || (n == MARKER.len() && byte == b'\r'))
                        .then_some(n + 1)
                });
            }
        }
        Ok(())
    }

    pub fn stderr(&mut self, bytes: &[u8]) -> Result<(), StartupError> {
        self.charge(bytes.len())
    }

    fn charge(&mut self, count: usize) -> Result<(), StartupError> {
        match self.settled {
            Some(outcome) => return outcome.map(|_| ()),
            None if count > OUTPUT_LIMIT - self.output_bytes => {
                self.settled = Some(Err(StartupError::OutputLimit));
                return Err(StartupError::OutputLimit);
            }
            None => self.output_bytes += count,
        }
        Ok(())
    }

    /// Poll on a startup worker, not the shared dispatch loop. The bridge must
    /// service this probe concurrently. One attempt budgets 200 ms for all I/O;
    /// timeout or transport unavailability is pending until the startup deadline.
    /// A successful result is startup evidence, not ongoing liveness.
    pub fn poll_ready(
        &mut self,
        cancelled: impl Fn() -> bool,
    ) -> Result<Option<u16>, StartupError> {
        if let Some(outcome) = self.settled {
            if outcome.is_ok() && cancelled() {
                self.settled = Some(Err(StartupError::Cancelled));
                return Err(StartupError::Cancelled);
            }
            return outcome.map(Some);
        }
        let result = self.check_ready(cancelled);
        match result {
            Err(error) => self.settled = Some(Err(error)),
            Ok(Some(port)) => self.settled = Some(Ok(port)),
            Ok(None) => {}
        }
        result
    }

    fn check_ready(&self, cancelled: impl Fn() -> bool) -> Result<Option<u16>, StartupError> {
        self.check_budget(&cancelled)?;
        if !self.announced {
            return Ok(None);
        }
        let health = health::probe(self.endpoint, self.deadline, &cancelled);
        self.check_budget(&cancelled)?;
        match health {
            health::Result::Healthy => Ok(Some(self.endpoint.port())),
            health::Result::Pending => Ok(None),
            health::Result::Invalid => Err(StartupError::InvalidHealthResponse),
        }
    }

    fn check_budget(&self, cancelled: impl Fn() -> bool) -> Result<(), StartupError> {
        if cancelled() {
            return Err(StartupError::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(StartupError::TimedOut);
        }
        Ok(())
    }
}
