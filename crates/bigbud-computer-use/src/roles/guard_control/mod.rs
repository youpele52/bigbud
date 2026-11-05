//! Guard control channel (macOS debug builds until the M6 switch): length-
//! prefixed `bigbud-protocol` control frames, parent→guard on stdin and
//! guard→parent on stdout. The pipe pair is private to the spawning Electron
//! process, which is the channel's only authentication (process lifetime);
//! frame contents never authenticate anyone.
//!
//! - The guard writes its `Hello` first. The parent answers with a compatible
//!   `human-control` Hello before `Status` is served.
//! - `Stop` is never refused (even before Hello): it raises a latching
//!   priority retirement and is answered with `Revoked` only once the latch is
//!   durably persisted, otherwise `ProtocolError{stop_unconfirmed}`.
//! - `Status` with only `request_id` set is a query; the reply carries the
//!   persisted safety record projection. `Resume` and every other frame are
//!   refused: the guard never clears a pause or opens admission.
//! - Clean EOF is the lifeline: orderly shutdown without a new latch. A
//!   malformed, truncated or incompatible stream latches and shuts down, as
//!   does a frame not completed within the 5 s per-frame deadline.
mod channel;
mod deadline;
mod framing;
mod session;
#[cfg(test)]
mod tests;

pub(crate) use channel::{ControlConfig, run_control};
