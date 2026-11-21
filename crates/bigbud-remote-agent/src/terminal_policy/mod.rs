//! Terminal activity tracking, process probing, memory sampling and lifecycle policy (terminal
//! lifecycle plan, R3). Everything here is pure decision logic plus OS probes; R5 owns the
//! loop, the PTY locks and the notices.

mod activity;
#[path = "activity.idle.rs"]
mod activity_idle;
pub mod admission;
pub mod clock;
mod engine;
pub mod memory;
mod policy;
mod pressure;
pub mod probe;

pub use activity::{
    ActivityTracker, OwnerHint, PRESSURE_OUTPUT_WINDOW_MS, RESIZE_REDRAW_GRACE_MS,
    SIDEBAR_OUTPUT_WINDOW_MS, ViewState,
};
pub use activity_idle::{IdleEvent, IdleTimings};
pub use clock::{Clock, FakeClock, SystemClock};
pub use engine::{PolicyAction, PolicyEngine, TerminalRef, is_pressure_candidate};
pub use memory::MemorySampler;
pub use policy::{HostPolicy, PolicyState, PolicyUpdate};
pub use pressure::{MemorySample, MemoryThresholds, PressureGovernor, PressureLevel, classify};
pub use probe::{ForegroundReason, ProcessProbe};

#[cfg(test)]
#[path = "activity.tests.rs"]
mod activity_tests;
#[cfg(test)]
#[path = "admission.tests.rs"]
mod admission_tests;
#[cfg(test)]
#[path = "engine.tests.rs"]
mod engine_tests;
