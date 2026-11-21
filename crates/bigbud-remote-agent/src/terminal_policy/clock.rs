//! Millisecond clocks. Policy code takes `now_ms` explicitly; the host loop reads it from a
//! [`Clock`], which tests (and R5's clock hook) replace with a [`FakeClock`].

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

/// Wall-clock milliseconds since the Unix epoch (0 if the clock is before it).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| {
                u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
            })
    }
}

/// A manually advanced clock; clones share the same time.
#[derive(Debug, Clone, Default)]
pub struct FakeClock(Arc<AtomicU64>);

impl FakeClock {
    pub fn new(start_ms: u64) -> Self {
        Self(Arc::new(AtomicU64::new(start_ms)))
    }

    pub fn set(&self, now_ms: u64) {
        self.0.store(now_ms, Ordering::Release);
    }

    pub fn advance(&self, delta_ms: u64) -> u64 {
        self.0
            .fetch_add(delta_ms, Ordering::AcqRel)
            .saturating_add(delta_ms)
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }
}
