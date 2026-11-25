//! Local Windows owner-pipe transport for bounded v1 frames.
//!
//! General owner endpoints require an independently obtained process handle
//! before framed I/O. The separate request-only helper endpoint pins its
//! OS-observed client and checks lineage to the retained SSH launch before a
//! grant can be claimed. Neither is a boundary against deliberate same-user
//! compromise or enables any credential capability.

mod policy;

#[cfg(windows)]
mod pipe;
#[cfg(windows)]
mod process;
#[cfg(windows)]
mod security;

#[cfg(windows)]
pub use pipe::{OwnerPipe, PipeReadiness, VerifiedPipe, connect};
#[cfg(windows)]
pub(crate) use pipe::{helper, random_token};
#[cfg(windows)]
pub use policy::PipeName;
#[cfg(windows)]
pub use process::ExpectedPipePeer;
