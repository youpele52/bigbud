mod core;

pub use core::{
    CLOSE_GRACE, CloseOutcome, LaunchOutcome, LaunchStage, LaunchUnknown, MAX_OUTPUT_BYTES,
    OutputBytes, PtyError, PtyEvent, PtyHandle, PtyJob, PtyOutputChunk, PtySnapshot, PtyState,
    RebuildRing, run_events,
};
#[cfg(unix)]
pub use core::{
    CleanupOwner, InputOutcome, InputReceipt, pending_cleanup_settled, read_events,
    run_events_gated,
};
