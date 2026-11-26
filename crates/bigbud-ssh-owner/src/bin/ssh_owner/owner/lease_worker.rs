//! One lease worker thread: cancellation, a streaming flag and the settled
//! outcome. Shared by the U15 Git upload and receive leases and the W2
//! T-backend deployment step and relay leases, so all observe, retire and reap
//! identically.
use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const CLOSE_BUDGET: Duration = Duration::from_millis(1750);
const POLL: Duration = Duration::from_millis(5);

/// What a running worker reads: whether it was cancelled, and how to report
/// that its child is streaming.
pub(crate) struct Signals {
    cancelled: Arc<AtomicBool>,
    streaming: Arc<AtomicBool>,
}

impl Signals {
    pub(crate) fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(crate) fn streaming(&self) {
        self.streaming.store(true, Ordering::Release);
    }
}

pub(crate) struct Worker<O> {
    cancelled: Arc<AtomicBool>,
    streaming: Arc<AtomicBool>,
    handle: Option<JoinHandle<O>>,
    settled: Option<O>,
    /// Reported if the thread panicked: its child's fate is unknown.
    panicked: O,
}

impl<O: Clone + Send + 'static> Worker<O> {
    pub(crate) fn spawn(
        name: &str,
        panicked: O,
        run: impl FnOnce(Signals) -> O + Send + 'static,
    ) -> io::Result<Self> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let streaming = Arc::new(AtomicBool::new(false));
        let signals = Signals {
            cancelled: Arc::clone(&cancelled),
            streaming: Arc::clone(&streaming),
        };
        let handle = thread::Builder::new()
            .name(name.into())
            .spawn(move || run(signals))?;
        Ok(Self {
            cancelled,
            streaming,
            handle: Some(handle),
            settled: None,
            panicked,
        })
    }

    /// The settled outcome, once the thread has finished.
    pub(crate) fn settled(&mut self) -> Option<O> {
        if self.handle.as_ref().is_some_and(JoinHandle::is_finished) {
            let panicked = self.panicked.clone();
            self.settled = self
                .handle
                .take()
                .map(|handle| handle.join().unwrap_or(panicked));
        }
        self.settled.clone()
    }

    pub(crate) fn is_streaming(&self) -> bool {
        self.streaming.load(Ordering::Acquire)
    }

    /// Cancel and wait within the close budget; `None` if still running.
    pub(crate) fn retire(&mut self) -> Option<O> {
        self.cancelled.store(true, Ordering::Release);
        let deadline = Instant::now() + CLOSE_BUDGET;
        loop {
            if let Some(outcome) = self.settled() {
                return Some(outcome);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(POLL);
        }
    }
}

impl<O> Drop for Worker<O> {
    fn drop(&mut self) {
        // Never leave a detached worker running past its lease.
        self.cancelled.store(true, Ordering::Release);
    }
}
