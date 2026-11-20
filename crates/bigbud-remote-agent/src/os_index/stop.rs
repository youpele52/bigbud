//! Cancel and deadline polling shared by the adapters that wait on another thread or process
//! (`locate` and Windows Search).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::search::StopReason;

/// Longest gap between cancel and deadline checks (the plan's cancel budget is 50 ms).
pub const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Why gathering must stop now, if it must: cancel wins over the deadline.
pub fn check_stop(cancel: &AtomicBool, deadline_at: Instant) -> Option<StopReason> {
    if cancel.load(Ordering::Relaxed) {
        Some(StopReason::Cancelled)
    } else if Instant::now() >= deadline_at {
        Some(StopReason::Deadline)
    } else {
        None
    }
}

/// How long to wait for the next event: until the deadline, at most [`POLL_INTERVAL`].
pub fn next_wait(deadline_at: Instant) -> Duration {
    deadline_at
        .saturating_duration_since(Instant::now())
        .min(POLL_INTERVAL)
}
