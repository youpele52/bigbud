//! Exclusive root and bounded safety journal. This module cannot open admission.
#[cfg(target_os = "macos")]
mod durable_root;
mod fence;
mod journal;
#[cfg(not(target_os = "macos"))]
mod lock;
#[cfg(target_os = "macos")]
#[path = "lock.macos.rs"]
mod lock;
#[cfg(target_os = "macos")]
pub use durable_root::{DurableRoot, RootLayout};
mod paths;
mod priority;
pub mod record;
mod recovery;
#[cfg(target_os = "macos")]
mod retained_recovery;
#[cfg(target_os = "macos")]
pub use retained_recovery::{
    AttachRetirementError, AttachRetirementFailure, GRACEFUL_SHUTDOWN, GuardServiceConfig,
    GuardServiceConfigError, GuardServiceControl, GuardServiceExit, GuardServiceReport,
    GuardStatusSnapshot, MAX_CADENCE, QuiesceError, QuiesceOperation, QuiescedReplacement,
    RecoveryFailure, RetainedRecovery, RetirementSignalLane, RetirementStatus,
    RetirementStorageLane,
};
#[cfg(target_os = "macos")]
mod interactive_identity;
#[cfg(target_os = "macos")]
mod session_invalidation;
#[cfg(target_os = "macos")]
pub use interactive_identity::{InteractiveSnapshot, SnapshotError};
#[cfg(target_os = "macos")]
pub use session_invalidation::{SessionInvalidationCause, SessionInvalidator};
#[cfg(test)]
pub(crate) mod test_support;
#[cfg(test)]
mod tests;
pub use fence::{
    Acknowledged, ControllerLease, FenceError, GuardFence, SafetySink, Settlement, TransitionError,
    TransitionRefusal, UNACKNOWLEDGED_REVISION,
};
pub use journal::{Journal, JournalError};
pub use lock::{ControllingLock, LockError};
pub use paths::{RootEnvironment, UserPlatform, resolve_root};
pub use priority::{PriorityRetirement, RetirementCause};
pub use recovery::{Recovery, recover};
