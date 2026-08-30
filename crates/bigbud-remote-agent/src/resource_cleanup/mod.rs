mod contract;
mod errors;
mod session;

use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

pub use session::run_stdio;

const MAX_ROOTS: usize = 16;
const MAX_RESOURCES: usize = 256;
const MAX_DEPTH: usize = 128;
const MAX_ENTRIES: usize = 1_000_000;
/// A single cleanup request must never account for an unbounded amount of known file data.
const MAX_KNOWN_BYTES: u64 = 16 * 1024 * 1024 * 1024;

static CLEANUP_CANCELLED: AtomicBool = AtomicBool::new(false);

fn reset_cancellation() {
    CLEANUP_CANCELLED.store(false, Ordering::Release);
}

fn request_cancellation() {
    CLEANUP_CANCELLED.store(true, Ordering::Release);
}

fn cancellation_requested() -> bool {
    CLEANUP_CANCELLED.load(Ordering::Acquire)
}
