mod core;

#[cfg(unix)]
pub use core::read_events;
pub use core::{
    MAX_OUTPUT_BYTES, PtyError, PtyEvent, PtyHandle, PtyJob, PtyOutputChunk, PtySnapshot, PtyState,
    run_events,
};
