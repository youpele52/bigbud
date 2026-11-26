//! Local child leases and the live proxy enum.

#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::ProductionProxy;
use super::v1::{self, ErrorCode};
use crate::Token;
use crate::transport::PinnedSsh;
use std::fs::File;
use std::io;
use std::os::unix::process::ExitStatusExt;
use std::process::{Child, ExitStatus, Stdio};
use std::sync::mpsc::{self, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

const MAX_CLOSE_MS: u32 = 5_000;
const TERM_GRACE: Duration = Duration::from_millis(250);
const POLL: Duration = Duration::from_millis(5);

type Reaper = SyncSender<(Child, PinnedSsh)>;

struct Running {
    child: Child,
    pin: PinnedSsh,
    reap: Reaper,
}

// Pre-arm the exceptional cleanup path before spawn. A stuck child must not
// make Drop unbounded, nor release the host pin while it is still running.
pub(crate) fn deferred_reaper() -> io::Result<Reaper> {
    let (send, recv) = mpsc::sync_channel::<(Child, PinnedSsh)>(1);
    thread::Builder::new()
        .name("proof-agent-proxy-reap".into())
        .spawn(move || {
            if let Ok((mut child, _pin)) = recv.recv() {
                let _kill_requested = child.kill();
                let _reaped_or_no_child = child.wait();
            }
        })?;
    Ok(send)
}

pub(crate) struct AgentProxyLease {
    token: Token,
    pid: u32,
    running: Option<Running>,
    exit: Option<ExitStatus>,
}

impl AgentProxyLease {
    pub(super) fn launch(
        mut pinned: PinnedSsh,
        host: &str,
        remote: &str,
        [stdin, stdout, stderr]: [File; 3],
        token: Token,
        reap: Reaper,
    ) -> Result<Self, ErrorCode> {
        pinned
            .command
            .args(["-o", "EscapeChar=none", "--", host, remote]);
        Self::launch_pinned(pinned, [stdin, stdout, stderr], token, reap)
    }

    pub(super) fn launch_pinned(
        mut pinned: PinnedSsh,
        [stdin, stdout, stderr]: [File; 3],
        token: Token,
        reap: Reaper,
    ) -> Result<Self, ErrorCode> {
        let child = pinned
            .command
            .env_clear()
            .env("LC_ALL", "C")
            .stdin(stdin)
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .map_err(|_| ErrorCode::OwnerUnavailable)?;
        // Command is reusable and still owns the inherited pipe ends. Close
        // those copies now so only SSH can hold them open, not the pin lease.
        pinned
            .command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        Ok(Self {
            token,
            pid: child.id(),
            running: Some(Running {
                child,
                pin: pinned,
                reap,
            }),
            exit: None,
        })
    }

    fn refresh_exit(&mut self) -> Result<bool, ErrorCode> {
        if let Some(running) = &mut self.running {
            let Some(exit) = running
                .child
                .try_wait()
                .map_err(|_| ErrorCode::OutcomeUnknown)?
            else {
                return Ok(false);
            };
            self.exit = Some(exit);
            self.running = None;
        }
        Ok(true)
    }

    pub(super) fn status(&mut self) -> Result<v1::ProofAgentProxyStatus, ErrorCode> {
        let closed = self.refresh_exit()?;
        Ok(v1::ProofAgentProxyStatus {
            lease: self.token.to_vec(),
            pid: self.pid,
            closed,
            code: self.exit.and_then(|exit| exit.code()),
            signal: self.exit.and_then(|exit| exit.signal()),
        })
    }

    pub(super) fn close(
        &mut self,
        terminate: bool,
        timeout_ms: u32,
    ) -> Result<v1::ProofAgentProxyStatus, ErrorCode> {
        let timeout = Duration::from_millis(u64::from(timeout_ms.min(MAX_CLOSE_MS)));
        let start = Instant::now();
        if terminate && !self.refresh_exit()? {
            let pid = i32::try_from(self.pid).map_err(|_| ErrorCode::OutcomeUnknown)?;
            // SAFETY: this positive PID belongs to our direct, not-yet-reaped
            // child. Only this lease can wait for it until ownership is moved
            // to the fallback reaper. We never signal a request-supplied PID.
            let _term_requested = unsafe { libc::kill(pid, libc::SIGTERM) };
            if !self.wait_until(start + TERM_GRACE.min(timeout / 2))?
                && let Some(running) = &mut self.running
            {
                // Only reaping confirms termination, even if kill succeeded.
                let _kill_requested = running.child.kill();
            }
        }
        if self.wait_until(start + timeout)? {
            self.status()
        } else {
            Err(ErrorCode::OutcomeUnknown)
        }
    }

    fn wait_until(&mut self, deadline: Instant) -> Result<bool, ErrorCode> {
        loop {
            if self.refresh_exit()? {
                return Ok(true);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            thread::sleep(remaining.min(POLL));
        }
    }
}

impl Drop for AgentProxyLease {
    fn drop(&mut self) {
        let _close = self.close(true, 500);
        if let Some(Running { child, pin, reap }) = self.running.take() {
            // The receiver cannot leave recv before the only send or sender
            // drop. In particular no worker ever waits/reaps concurrently with us.
            let _transferred_to_reaper = reap.send((child, pin));
        }
    }
}

/// A live proxy lease belonging to exactly one target and generation. Fixture
/// mode keeps its startup-transferred pipes; production keeps its private mux
/// session. Both answer the same status/close protocol.
pub(crate) enum AgentProxy {
    Fixture(AgentProxyLease),
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Production(ProductionProxy),
}

impl AgentProxy {
    pub(crate) fn status(&mut self) -> Result<v1::ProofAgentProxyStatus, ErrorCode> {
        match self {
            Self::Fixture(lease) => lease.status(),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Self::Production(proxy) => proxy.status(),
        }
    }

    pub(crate) fn close(
        &mut self,
        terminate: bool,
        timeout_ms: u32,
    ) -> Result<v1::ProofAgentProxyStatus, ErrorCode> {
        match self {
            Self::Fixture(lease) => lease.close(terminate, timeout_ms),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Self::Production(proxy) => proxy.close(terminate, timeout_ms),
        }
    }
}
