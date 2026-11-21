//! Host-side terminal screen model, snapshot serializer and query parser (terminal lifecycle
//! plan, R1).
//!
//! - [`ScreenModel`] applies PTY output to a `vt100` 0.18.1 grid. A scanner that mirrors the
//!   `vte` state machine holds back incomplete sequences (the pending escape tail), detects
//!   queries, tracks what `vt100` does not model, and rewrites the few sequences `vt100`
//!   handles differently from xterm.js.
//! - [`ScreenModel::copy`] takes the immutable fence copy (F1); [`ScreenCopy::serialize`] turns
//!   it into ANSI within both snapshot caps, reporting every difference through `fidelity`.
//! - [`ScreenActor`] owns one model on its own thread: bounded `try_feed`, fenced snapshots,
//!   the rebuild state machine of §14, and `catch_unwind` around every feed.

mod actor;
mod checkpoint;
mod copy;
mod fidelity;
mod marks;
mod model;
mod probe;
mod query;
mod scanner;
mod serialize;
mod tracker;

pub use actor::{
    ActorEvent, ActorSpawnError, FeedOutcome, FenceError, InvalidReason, ModelState, RebuildError,
    RebuildTicket, ScreenActor, ScreenActorConfig,
};
pub use checkpoint::CheckpointError;
pub use copy::ScreenCopy;
pub use fidelity::{Exclusion, ExclusionKind, Fidelity, FidelityReport};
pub use model::{
    DEFAULT_SCROLLBACK_ROWS, FeedOutput, MAX_SCROLLBACK_ROWS, ScreenError, ScreenGeometry,
    ScreenModel,
};
pub use query::{DetectedQuery, ModeState, ReplyContext, reply as query_reply};
pub use serialize::{
    MAX_ANSI_UTF8_BYTES, MAX_ANSI_UTF16_UNITS, ScreenSnapshot, SnapshotError, SnapshotLimits,
};

#[cfg(test)]
mod tests;
