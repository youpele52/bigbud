//! Owner-retained listener and bounded readiness for one OpenCode v2 lease.

#[path = "startup.tests.rs"]
#[cfg(test)]
mod tests;

use super::probe;
use crate::owner_opencode::{OUTPUT_LIMIT, Ready, ReadyFailure, ReadyPort};
use std::{
    io,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    time::{Duration, Instant},
};

const START_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_LINE: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum StartupError {
    Cancelled,
    TimedOut,
    OutputLimit,
    InvalidReadiness,
}

/// OpenCode v2 readiness: exactly one JSON line containing a `url` whose
/// loopback host and port are the owner-selected endpoint, followed by an
/// authenticated `/api/info` probe that reports a v2 server. The advertised URL
/// never selects the endpoint; it can only confirm the one already chosen.
pub(super) struct Startup {
    listener: TcpListener,
    endpoint: SocketAddrV4,
    remote: SocketAddrV4,
    password: String,
    deadline: Instant,
    output_bytes: usize,
    line: Vec<u8>,
    overflow: bool,
    announced: bool,
    settled: Option<Result<ReadyPort, StartupError>>,
}

impl Startup {
    pub(super) fn reserve(remote: SocketAddrV4) -> io::Result<Self> {
        let deadline = Instant::now() + START_TIMEOUT;
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let std::net::SocketAddr::V4(endpoint) = listener.local_addr()? else {
            return Err(io::Error::other("unexpected OpenCode v2 listener family"));
        };
        let Ok(password) = crate::random_token() else {
            return Err(io::Error::other("OpenCode v2 credential unavailable"));
        };
        Ok(Self {
            listener,
            endpoint,
            remote,
            password: crate::owner_opencode::hex(&password),
            deadline,
            output_bytes: 0,
            line: Vec::with_capacity(MAX_LINE),
            overflow: false,
            announced: false,
            settled: None,
        })
    }

    fn charge(&mut self, count: usize) -> Result<(), StartupError> {
        match &self.settled {
            Some(Ok(_)) => return Ok(()),
            Some(Err(error)) => return Err(*error),
            None if count > OUTPUT_LIMIT - self.output_bytes => {
                self.settled = Some(Err(StartupError::OutputLimit));
                return Err(StartupError::OutputLimit);
            }
            None => self.output_bytes += count,
        }
        Ok(())
    }

    fn ingest_line(&mut self) {
        if self.overflow {
            self.overflow = false;
            self.line.clear();
            return;
        }
        if self.settled.is_some() || self.announced {
            self.line.clear();
            return;
        }
        // Only a complete line naming the owner-selected port is evidence.
        if readiness_port(&self.line) == Some(self.remote.port()) {
            self.announced = true;
        }
        self.line.clear();
    }

    fn check_ready(
        &mut self,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Option<ReadyPort>, StartupError> {
        self.check_budget(cancelled)?;
        if !self.announced {
            return Ok(None);
        }
        self.check_budget(cancelled)?;
        match probe::info(self.endpoint, &self.password, self.deadline, cancelled) {
            probe::Result::Healthy => Ok(Some(ReadyPort {
                port: self.endpoint.port(),
                secret: Some(self.password.clone()),
            })),
            probe::Result::Pending => Ok(None),
            probe::Result::Invalid => Err(StartupError::InvalidReadiness),
        }
    }

    fn check_budget(&self, cancelled: &dyn Fn() -> bool) -> Result<(), StartupError> {
        if cancelled() {
            return Err(StartupError::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(StartupError::TimedOut);
        }
        Ok(())
    }
}

impl Ready for Startup {
    fn listener(&self) -> &TcpListener {
        &self.listener
    }

    fn stdout(&mut self, bytes: &[u8]) -> Result<(), ()> {
        self.charge(bytes.len()).map_err(|_| ())?;
        if self.settled.is_some() || self.announced {
            return Ok(());
        }
        for &byte in bytes {
            if byte == b'\n' {
                self.ingest_line();
            } else if self.line.len() < MAX_LINE {
                self.line.push(byte);
            } else {
                self.overflow = true;
            }
        }
        Ok(())
    }

    fn stderr(&mut self, bytes: &[u8]) -> Result<(), ()> {
        self.charge(bytes.len()).map_err(|_| ())
    }

    fn poll(&mut self, cancelled: &dyn Fn() -> bool) -> Result<Option<ReadyPort>, ReadyFailure> {
        if let Some(outcome) = self.settled.clone() {
            if outcome.is_ok() && cancelled() {
                self.settled = Some(Err(StartupError::Cancelled));
                return Err(ReadyFailure::Cancelled);
            }
            return outcome.map(Some).map_err(failure);
        }
        let result = self.check_ready(cancelled);
        match &result {
            Err(error) => self.settled = Some(Err(*error)),
            Ok(Some(ready)) => self.settled = Some(Ok(ready.clone())),
            Ok(None) => {}
        }
        result.map_err(failure)
    }

    fn launch_secret(&self) -> Option<&str> {
        Some(&self.password)
    }
}

fn failure(error: StartupError) -> ReadyFailure {
    match error {
        StartupError::Cancelled => ReadyFailure::Cancelled,
        _ => ReadyFailure::Rejected,
    }
}

/// Extracts the port from `{"url":"http://127.0.0.1:<port>"}` with no trailing
/// path, query or fragment. Any other shape is not readiness evidence.
fn readiness_port(line: &[u8]) -> Option<u16> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    let url = value.get("url")?.as_str()?;
    let rest = url.strip_prefix("http://")?;
    let (host, port) = rest.split_once(':')?;
    if host != "127.0.0.1"
        || port.is_empty()
        || port.len() > 5
        || !port.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    (port > 0).then_some(port)
}
