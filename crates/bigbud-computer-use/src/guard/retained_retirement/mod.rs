//! Actual-anchor retirement for one retained recovery/election. Disjoint
//! signal/storage lanes may be borrowed concurrently; `runtime` is the only
//! code that starts (scoped, always-joined) threads, and only when explicitly
//! invoked. Settlement reaps an owner only after its known non-detaching
//! closure is confirmed, then storage durably removes that exact root. Native
//! syscalls have no qualified arbitrary-stall latency guarantee. Dropping the
//! WHOLE recovery drops owners, whose Drop sends an exact-group KILL without
//! reaping; durable roots remain, so the next recovery starts unsettled.
mod attachment;
mod clock;
mod dispatch;
mod lanes;
mod storage;
pub(super) use lanes::Observation;
pub use lanes::{RetirementSignalLane, RetirementStorageLane};
mod quiesce;
#[cfg(test)]
#[path = "quiesce.tests.rs"]
mod quiesce_tests;
mod runtime;
mod service;
mod status;
use super::{RecoveryFailure, RetainedRecovery};
use crate::{guard::RetirementCause, worker::unix::AnchoredGroup};
pub(super) use dispatch::OwnedRetirement;
pub use dispatch::RetirementStatus;
use dispatch::Target;
pub use quiesce::{QuiesceError, QuiesceOperation, QuiescedReplacement};
pub use runtime::{
    GRACEFUL_SHUTDOWN, GuardServiceConfig, GuardServiceConfigError, GuardServiceControl,
    GuardServiceExit, GuardServiceReport, MAX_CADENCE,
};
pub use status::GuardStatusSnapshot;

#[derive(Debug)]
pub enum AttachRetirementFailure {
    AlreadyAttached,
    RootMismatch,
    Storage,
}
/// Every failed attach returns ALL supplied owners, including storage failure.
#[must_use = "retain anchors; an attachment error is not process settlement"]
pub struct AttachRetirementError {
    pub anchors: Vec<AnchoredGroup>,
    pub failure: AttachRetirementFailure,
}

#[cfg(test)]
mod tests;
