//! Actual Unix EOF watcher source, not the fake-clock lease model. No production
//! role invokes it yet. Its constructor starts exactly one named thread; caller
//! must provide an exclusively owned authenticated CLOEXEC local endpoint.
//! It carries no data, credentials or execution responses after bootstrap.
//!
//! Same-process socket/thread regressions do not qualify child lifecycle. The
//! watcher does not itself retire execution roots: the guard must independently
//! service PriorityRetirement and run qualified exact-root retirement. Windows
//! pipe/lifeline implementation and role/bootstrap wiring remain unfinished.
use crate::guard::{PriorityRetirement, RetirementCause};
use std::{
    io::{self, Read},
    net::Shutdown,
    os::unix::net::UnixStream,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const POLL: Duration = Duration::from_millis(100);
const JOIN_POLL: Duration = Duration::from_millis(10);
const MAX_JOIN: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherOutcome {
    Cancelled,
    ParentLost,
    Malformed,
    IoFailed,
    Panicked,
}

#[must_use = "retain the watcher and explicitly stop_and_join it during shutdown"]
pub struct IndependentLifeline {
    cancel: Arc<AtomicBool>,
    interrupt: UnixStream,
    thread: Option<JoinHandle<WatcherOutcome>>,
    requests: PriorityRetirement,
}
impl IndependentLifeline {
    /// Dormant composition for a trusted, exclusively owned bootstrap endpoint.
    /// Authentication failure revokes too; no watcher or admission is fabricated.
    /// Only this bounded handshake may precede the silent lifeline on the stream.
    pub fn bootstrap(
        capability: &mut super::BootstrapCapability,
        stream: UnixStream,
        requests: PriorityRetirement,
    ) -> io::Result<Self> {
        let result = capability
            .authenticate_stream(stream)
            .and_then(|peer| Self::start(peer, requests.clone()));
        if result.is_err() {
            requests.raise(RetirementCause::LifelineIo);
        }
        result
    }

    /// Only role/lifetime-authenticated endpoints can enter the watcher. Full
    /// bootstrap delivery, root persistence and retirement wiring remain gated.
    pub fn start(peer: super::AuthenticatedPeer, requests: PriorityRetirement) -> io::Result<Self> {
        let parent_loss = match peer.role {
            crate::Role::Guard => RetirementCause::GuardLost,
            crate::Role::Owner => RetirementCause::OwnerLost,
            crate::Role::Worker => RetirementCause::WorkerLost,
            crate::Role::Broker => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid lifeline role",
                ));
            }
        };
        let mut stream = peer.stream;
        super::unix_peer::ensure_private_fd(&stream)?;
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(POLL))?;
        let interrupt = stream.try_clone()?;
        super::unix_peer::ensure_private_fd(&interrupt)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let thread_cancel = Arc::clone(&cancel);
        let thread_requests = requests.clone();
        let thread = thread::Builder::new()
            .name("cua-lifeline".into())
            .spawn(move || {
                let mut byte = [0_u8; 1];
                loop {
                    if thread_cancel.load(Ordering::SeqCst) {
                        return WatcherOutcome::Cancelled;
                    }
                    match stream.read(&mut byte) {
                        Ok(0) => {
                            if thread_cancel.load(Ordering::SeqCst) {
                                return WatcherOutcome::Cancelled;
                            }
                            thread_requests.raise(parent_loss);
                            return WatcherOutcome::ParentLost;
                        }
                        Ok(_) => {
                            thread_requests.raise(RetirementCause::MalformedLifeline);
                            return WatcherOutcome::Malformed;
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                io::ErrorKind::WouldBlock
                                    | io::ErrorKind::TimedOut
                                    | io::ErrorKind::Interrupted
                            ) => {}
                        Err(_) => {
                            if thread_cancel.load(Ordering::SeqCst) {
                                return WatcherOutcome::Cancelled;
                            }
                            thread_requests.raise(RetirementCause::LifelineIo);
                            return WatcherOutcome::IoFailed;
                        }
                    }
                }
            })?;
        Ok(Self {
            cancel,
            interrupt,
            thread: Some(thread),
            requests,
        })
    }

    fn cancel(&self) {
        self.requests.revoke();
        self.cancel.store(true, Ordering::SeqCst);
        match self.interrupt.shutdown(Shutdown::Both) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotConnected => {}
            Err(_) => self.requests.raise(RetirementCause::LifelineIo),
        }
    }
    /// Err retains the unsettled handle, never asserts the watcher/process died.
    /// This is a thread-join deadline, not a physical input/retirement deadline.
    pub fn stop_and_join(mut self, budget: Duration) -> Result<WatcherOutcome, Self> {
        self.cancel();
        if budget > MAX_JOIN {
            return Err(self);
        }
        let Some(deadline) = Instant::now().checked_add(budget) else {
            return Err(self);
        };
        while self
            .thread
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
        {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(self);
            };
            if remaining.is_zero() {
                return Err(self);
            }
            thread::sleep(JOIN_POLL.min(remaining));
        }
        match self.thread.take() {
            Some(thread) => Ok(match thread.join() {
                Ok(outcome) => outcome,
                Err(_) => {
                    self.requests.raise(RetirementCause::LifelineIo);
                    WatcherOutcome::Panicked
                }
            }),
            None => Ok(WatcherOutcome::Cancelled),
        }
    }
}
#[cfg(test)]
#[path = "independent_lifeline.tests.rs"]
mod tests;

impl Drop for IndependentLifeline {
    fn drop(&mut self) {
        // Last-resort bounded-I/O cancellation only; orderly shutdown MUST call
        // stop_and_join and retain Err until settled. Never wait on MCP locks.
        self.cancel();
        if self.thread.as_ref().is_some_and(JoinHandle::is_finished)
            && let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            self.requests.raise(RetirementCause::LifelineIo);
        }
    }
}
