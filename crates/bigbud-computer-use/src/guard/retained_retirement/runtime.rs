//! Executable guard scheduler: the signal lane and the storage lane each run on
//! their own scoped thread, so a stalled journal never delays TERM/KILL and a
//! stalled signal never delays durable denial. Cadence is <=100 ms, raised
//! causes wake the signal lane immediately, and every exit path joins both
//! threads before returning. Owners never leave the recovery: cancellation and
//! an exceeded shutdown budget return with roots/anchors retained (and Drop of
//! an unsettled anchor kills its exact group). Native syscalls still have no
//! arbitrary-stall bound: a thread blocked inside one (e.g. a stuck journal
//! flush) still delays this function's return, because both lanes are joined;
//! the shutdown budget bounds the signal lane, not a blocked storage syscall.
use super::*;
use std::{
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, Thread},
    time::{Duration, Instant},
};

pub const MAX_CADENCE: Duration = Duration::from_millis(100);
pub const GRACEFUL_SHUTDOWN: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardServiceConfigError {
    Cadence,
    ShutdownBudget,
}

#[derive(Debug, Clone, Copy)]
pub struct GuardServiceConfig {
    cadence: Duration,
    shutdown_budget: Duration,
}
impl GuardServiceConfig {
    pub fn new(cadence: Duration, budget: Duration) -> Result<Self, GuardServiceConfigError> {
        if cadence.is_zero() || cadence > MAX_CADENCE {
            return Err(GuardServiceConfigError::Cadence);
        }
        if budget.is_zero() || budget > GRACEFUL_SHUTDOWN {
            return Err(GuardServiceConfigError::ShutdownBudget);
        }
        Ok(Self {
            cadence,
            shutdown_budget: budget,
        })
    }
}
impl Default for GuardServiceConfig {
    fn default() -> Self {
        Self {
            cadence: MAX_CADENCE,
            shutdown_budget: GRACEFUL_SHUTDOWN,
        }
    }
}

/// Cross-thread cancel/shutdown requests. Neither request opens admission,
/// clears pause or settles roots; cancellation is not retirement.
#[derive(Clone, Default)]
pub struct GuardServiceControl {
    inner: Arc<ControlState>,
}
#[derive(Default)]
struct ControlState {
    cancel: AtomicBool,
    shutdown: AtomicBool,
    threads: Mutex<Vec<Thread>>,
    /// Latest storage-lane projection; read-only status, never authority.
    status: Mutex<Option<GuardStatusSnapshot>>,
}
impl GuardServiceControl {
    pub fn cancel(&self) {
        self.inner.cancel.store(true, Ordering::SeqCst);
        self.wake();
    }
    pub fn request_shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        self.wake();
    }
    fn wake(&self) {
        for thread in self.lock().iter() {
            thread.unpark();
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Thread>> {
        self.inner
            .threads
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
    /// Latest published status, `None` until the storage lane's first pass.
    pub fn status(&self) -> Option<GuardStatusSnapshot> {
        self.inner
            .status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
    fn publish(&self, snapshot: Option<GuardStatusSnapshot>) {
        if snapshot.is_some() {
            *self
                .inner
                .status
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = snapshot;
        }
    }
    fn cancelled(&self) -> bool {
        self.inner.cancel.load(Ordering::SeqCst)
    }
    fn shutdown(&self) -> bool {
        self.inner.shutdown.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardServiceExit {
    /// Owners and roots retained; NOT retirement.
    Cancelled,
    /// Every attached root reaped and durably removed.
    ShutdownSettled,
    /// Denial persisted where possible; owners/roots retained for forced handling.
    ShutdownBudgetExceeded,
    /// A lane unwound; sticky unknown/interrupted evidence is retained.
    LaneInterrupted,
}

#[derive(Debug, Clone, Copy)]
pub struct GuardServiceReport {
    pub exit: GuardServiceExit,
    pub status: Option<RetirementStatus>,
    pub storage_ok: bool,
}

#[derive(Default)]
struct Shared {
    settled: AtomicBool,
    /// Signal lane completed a sample after observing shutdown, so every cause
    /// raised before `request_shutdown` has been taken and published as a
    /// durable-denial request. Storage settles only after seeing this first.
    shutdown_sampled: AtomicBool,
    budget_exceeded: AtomicBool,
    abort: AtomicBool,
    /// Storage thread only: the signal lane must not unpark itself every pass
    /// (that would spin). Its own Shutdown raise costs one extra pass only.
    storage: std::sync::OnceLock<Thread>,
}
/// Unwinding (or any exit) of one lane releases the other promptly.
struct ReleaseOnExit<'a>(&'a Shared, &'a GuardServiceControl);
impl Drop for ReleaseOnExit<'_> {
    fn drop(&mut self) {
        if thread::panicking() {
            self.0.abort.store(true, Ordering::SeqCst);
        }
        self.1.wake();
    }
}

impl RetainedRecovery<'_> {
    /// Runs until cancellation, settled shutdown or the shutdown budget. Never
    /// called by roles yet; the executable still refuses activation.
    pub fn run_guard_service(
        &mut self,
        control: &GuardServiceControl,
        config: GuardServiceConfig,
    ) -> GuardServiceReport {
        let priority = self.session.retirement_requests();
        let shared = Shared::default();
        let (mut signal, mut storage) = self.split_retirement();
        let (signal_result, storage_result) = thread::scope(|scope| {
            let (shared, priority) = (&shared, &priority);
            let signal_thread = scope.spawn(move || {
                control.lock().push(thread::current());
                priority.set_waker(Some(thread::current()));
                let _release = ReleaseOnExit(shared, control);
                let mut status = None;
                let mut shutdown_started: Option<Instant> = None;
                loop {
                    if control.shutdown() && shutdown_started.is_none() {
                        shutdown_started = Some(Instant::now());
                        priority.raise(RetirementCause::Shutdown);
                    }
                    status = signal.service().or(status);
                    if shutdown_started.is_some() {
                        shared.shutdown_sampled.store(true, Ordering::SeqCst);
                    }
                    if let Some(storage) = shared.storage.get() {
                        storage.unpark();
                    }
                    if control.cancelled()
                        || shared.settled.load(Ordering::SeqCst)
                        || shared.abort.load(Ordering::SeqCst)
                    {
                        break;
                    }
                    if shutdown_started
                        .is_some_and(|start| start.elapsed() >= config.shutdown_budget)
                    {
                        signal.require_durable_denial();
                        shared.budget_exceeded.store(true, Ordering::SeqCst);
                        break;
                    }
                    let wait = signal
                        .next_deadline()
                        .map_or(config.cadence, |deadline| deadline.min(config.cadence));
                    thread::park_timeout(wait);
                }
                priority.set_waker(None);
                status
            });
            let storage_thread = scope.spawn(move || {
                control.lock().push(thread::current());
                let _registered = shared.storage.set(thread::current());
                let _release = ReleaseOnExit(shared, control);
                loop {
                    // Read BEFORE flushing: a latching cause raised with the
                    // shutdown request is then persisted by this flush.
                    let sampled = shared.shutdown_sampled.load(Ordering::SeqCst);
                    let stop = control.cancelled()
                        || shared.budget_exceeded.load(Ordering::SeqCst)
                        || shared.abort.load(Ordering::SeqCst);
                    // Always flush once more on exit: denial published by the
                    // signal lane immediately before stopping is persisted.
                    // A retained session invalidation is a successful write.
                    let ok = matches!(
                        storage.flush(),
                        Ok(()) | Err(RecoveryFailure::SessionInvalidated(_))
                    );
                    control.publish(storage.snapshot());
                    if sampled && storage.settlement_persisted() {
                        shared.settled.store(true, Ordering::SeqCst);
                        return ok;
                    }
                    if stop {
                        return ok;
                    }
                    thread::park_timeout(config.cadence);
                }
            });
            (signal_thread.join(), storage_thread.join())
        });
        control.lock().clear();
        let interrupted = signal_result.is_err() || storage_result.is_err();
        let exit = if interrupted {
            GuardServiceExit::LaneInterrupted
        } else if shared.settled.load(Ordering::SeqCst) {
            GuardServiceExit::ShutdownSettled
        } else if shared.budget_exceeded.load(Ordering::SeqCst) {
            GuardServiceExit::ShutdownBudgetExceeded
        } else {
            GuardServiceExit::Cancelled
        };
        GuardServiceReport {
            exit,
            status: signal_result.ok().flatten(),
            storage_ok: storage_result.unwrap_or(false) && !interrupted,
        }
    }
}

#[cfg(test)]
#[path = "runtime.tests.rs"]
mod tests;
