use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    thread::Thread,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RetirementCause {
    GuardLost = 1,
    OwnerLost = 2,
    WorkerLost = 4,
    MalformedLifeline = 8,
    LifelineIo = 16,
    SessionInvalidated = 32,
    /// Orderly guard shutdown: retire exact owned roots before exit.
    Shutdown = 64,
    /// Explicit human Stop from the trusted control channel: latches durably
    /// (unlike `Shutdown`) and retires every owned root.
    HumanStop = 128,
}

/// Independent reserved retirement capacity. Raising a cause first revokes
/// admission, then coalesces a bit; data-queue saturation cannot reject it.
/// Only a future authenticated guard transaction can supply reopening. This
/// foundation intentionally exposes no method that opens admission.
#[derive(Clone)]
pub struct PriorityRetirement {
    inner: Arc<State>,
}
struct State {
    closed: AtomicBool,
    causes: AtomicU8,
    /// Optional guard-service wakeup. Raising uses try_lock + unpark only, so
    /// it never blocks or allocates; contention falls back to service cadence.
    waker: Mutex<Option<Thread>>,
}
impl Default for PriorityRetirement {
    fn default() -> Self {
        Self {
            inner: Arc::new(State {
                closed: AtomicBool::new(true),
                causes: AtomicU8::new(0),
                waker: Mutex::new(None),
            }),
        }
    }
}
impl PriorityRetirement {
    pub fn revoke(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
    }
    pub fn raise(&self, cause: RetirementCause) {
        self.revoke();
        self.inner.causes.fetch_or(cause as u8, Ordering::SeqCst);
        if let Ok(waker) = self.inner.waker.try_lock()
            && let Some(thread) = waker.as_ref()
        {
            thread.unpark();
        }
    }
    /// Registers/clears the single guard-service signal thread wakeup.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))] // macOS service only
    pub(crate) fn set_waker(&self, thread: Option<Thread>) {
        *self
            .inner
            .waker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = thread;
    }
    pub fn admission_closed(&self) -> bool {
        self.inner.closed.load(Ordering::SeqCst)
    }
    /// Consuming a pending request never reopens admission. Guard must preserve
    /// retirement/unknown evidence independently of these transient wakeups.
    pub fn take_causes(&self) -> u8 {
        self.inner.causes.swap(0, Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retirement_is_reserved_coalescing_and_sticky_closed() {
        let requests = PriorityRetirement::default();
        let owner = requests.clone();
        for _ in 0..10_000 {
            owner.raise(RetirementCause::OwnerLost);
        }
        requests.raise(RetirementCause::WorkerLost);
        assert!(requests.admission_closed());
        assert_eq!(
            requests.take_causes(),
            RetirementCause::OwnerLost as u8 | RetirementCause::WorkerLost as u8
        );
        assert_eq!(requests.take_causes(), 0);
        assert!(requests.admission_closed());
    }
}
