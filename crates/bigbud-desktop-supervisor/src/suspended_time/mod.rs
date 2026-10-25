//! Total time the machine has spent suspended since boot.
//!
//! The reading is the difference between a clock that counts suspend and one
//! that does not, so it grows only while the machine sleeps and is immune to
//! wall-clock changes. The TypeScript server compares successive heartbeat
//! readings and decides what a jump means; this module only measures.

mod convert;
mod source;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

pub use source::read_system_suspended_millis;

/// A source of raw readings. `None` means the platform clock is unavailable.
pub type SuspendedTimeSource = fn() -> Option<u64>;

/// Monotonic, never-regressing view over a raw suspended-time source.
///
/// The two platform clocks are read one after the other, so a raw reading can
/// jitter slightly backwards, and a transient read failure must not look like
/// a reset to zero (the next good reading would then look like a long sleep).
#[derive(Debug)]
pub struct SuspendedTime {
    source: SuspendedTimeSource,
    last_millis: u64,
}

impl SuspendedTime {
    pub fn system() -> Self {
        Self::from_source(read_system_suspended_millis)
    }

    pub fn from_source(source: SuspendedTimeSource) -> Self {
        Self {
            source,
            last_millis: 0,
        }
    }

    /// Returns the suspended milliseconds since boot, never lower than a
    /// previous result. Unavailable platforms report a constant 0.
    pub fn read_millis(&mut self) -> u64 {
        self.last_millis = next_reading(self.last_millis, (self.source)());
        self.last_millis
    }
}

fn next_reading(last_millis: u64, reading: Option<u64>) -> u64 {
    match reading {
        Some(millis) => last_millis.max(millis),
        // A failed read keeps the last good value so a later success is not
        // mistaken for a sudden suspend of the whole uptime.
        None => last_millis,
    }
}
