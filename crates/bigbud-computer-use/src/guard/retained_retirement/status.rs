//! Bounded guard status projection, published by the storage lane after each
//! flush so the control channel can answer Status/Stop without borrowing the
//! recovery. Safety metadata only (the durable record), never authority.
use super::{RecoveryFailure, RetirementStorageLane};
use crate::guard::record::SafetyRecord;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardStatusSnapshot {
    pub record: SafetyRecord,
    /// A requested durable denial was attempted and storage reports no failure:
    /// the record's latch/epoch is the persisted answer to that request.
    pub denial_persisted: bool,
    /// No sticky storage failure (a retained session invalidation is a write).
    pub storage_ok: bool,
}

impl RetirementStorageLane<'_, '_> {
    pub(super) fn snapshot(&self) -> Option<GuardStatusSnapshot> {
        let record = self.fence.as_ref()?.record().clone();
        let storage_ok = self
            .failure
            .as_ref()
            .is_none_or(|failure| matches!(failure, RecoveryFailure::SessionInvalidated(_)));
        Some(GuardStatusSnapshot {
            record,
            denial_persisted: *self.retirement_attempted && storage_ok,
            storage_ok,
        })
    }
}
