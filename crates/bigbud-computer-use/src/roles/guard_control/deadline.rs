//! Independent per-frame deadline. A frame that starts but does not complete
//! within the bound latches and shuts the guard down, even though the reader
//! thread itself stays blocked inside the read.
use std::{
    sync::{Arc, Mutex, PoisonError},
    thread,
    time::{Duration, Instant},
};

pub(crate) const FRAME_DEADLINE: Duration = Duration::from_secs(5);
const WATCH_CADENCE: Duration = Duration::from_millis(100);

#[derive(Default)]
struct ClockState {
    started: Option<Instant>,
    finished: bool,
}

/// Shared between the reader (start/clear) and the watchdog (expiry).
#[derive(Clone, Default)]
pub(crate) struct FrameClock {
    inner: Arc<Mutex<ClockState>>,
}
impl FrameClock {
    fn with<T>(&self, f: impl FnOnce(&mut ClockState) -> T) -> T {
        f(&mut self.inner.lock().unwrap_or_else(PoisonError::into_inner))
    }
    pub(crate) fn start(&self) {
        self.with(|state| {
            state.started.get_or_insert_with(Instant::now);
        });
    }
    pub(crate) fn clear(&self) {
        self.with(|state| state.started = None);
    }
    pub(crate) fn finish(&self) {
        self.with(|state| state.finished = true);
    }
}

/// Detached watchdog; ends when the clock finishes or after one expiry.
pub(crate) fn watch(
    clock: FrameClock,
    deadline: Duration,
    on_expiry: impl FnOnce() + Send + 'static,
) {
    thread::spawn(move || {
        loop {
            thread::sleep(WATCH_CADENCE.min(deadline));
            let expired = clock.with(|state| {
                (!state.finished).then(|| {
                    state
                        .started
                        .is_some_and(|started| started.elapsed() >= deadline)
                })
            });
            match expired {
                None => return,
                Some(true) => {
                    on_expiry();
                    return;
                }
                Some(false) => {}
            }
        }
    });
}
