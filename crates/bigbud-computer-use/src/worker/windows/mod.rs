//! Dormant Windows execution containment (compile-checked only; never run).
//! Suspended root -> no-breakaway kill-on-close Job -> durable root handoff ->
//! resume. Only the guard/owner hold the noninheritable Job handle; no handle
//! is inherited by the child (bInheritHandles = FALSE). The inherited-once
//! bootstrap courier for Windows (handle-list attributes) is NOT implemented.
mod ffi;
mod job;
pub use job::{ContainedRoot, SuspendedRoot};
