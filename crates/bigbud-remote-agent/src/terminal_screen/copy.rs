//! The immutable copy taken at a snapshot fence (F1, §9.1). The actor clones the grid and
//! side state, hands the copy to the snapshot worker, and resumes feeding at once; every
//! serialization step runs on the copy, so a snapshot never stalls the actor's queue.

use super::serialize::{self, ScreenSnapshot, SnapshotError, SnapshotLimits};
use super::tracker::Tracker;

pub struct ScreenCopy {
    pub(crate) screen: vt100::Screen,
    pub(crate) tracker: Tracker,
    pub(crate) pending_tail: Vec<u8>,
    pub(crate) discarded: u64,
    pub(crate) through_sequence: u64,
    pub(crate) estimated_bytes: usize,
}

impl ScreenCopy {
    /// The last output sequence applied before the fence (the snapshot's `through_sequence`).
    pub fn through_sequence(&self) -> u64 {
        self.through_sequence
    }

    /// Bytes this copy holds; counted in `screen_model_bytes` while a transfer is in flight.
    pub fn estimated_bytes(&self) -> usize {
        self.estimated_bytes
    }

    pub fn serialize(self, limits: &SnapshotLimits) -> Result<ScreenSnapshot, SnapshotError> {
        serialize::serialize(self, limits)
    }
}

impl std::fmt::Debug for ScreenCopy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ScreenCopy")
            .field("through_sequence", &self.through_sequence)
            .field("estimated_bytes", &self.estimated_bytes)
            .finish_non_exhaustive()
    }
}
