//! Native MCP mediation for the dormant supervised tuple (plan M2/M3):
//! strict request framing, the frozen 0.38.0 argument profile, final-dispatch
//! checks with owner stamping, and trusted egress projection. Platform-neutral
//! models with no transport, thread or I/O; legacy 0.9.1 stays selected.
pub mod dispatch;
pub mod egress;
#[path = "egress.read.rs"]
mod egress_read;
#[path = "egress.result.rs"]
mod egress_result;
pub mod frame;
pub mod held_input;
pub mod json_strict;
pub mod profile;
pub mod response;
pub mod restoration;
pub mod ticket;

#[cfg(test)]
#[path = "dispatch.tests.rs"]
mod dispatch_tests;
#[cfg(test)]
#[path = "egress.read.tests.rs"]
mod egress_read_tests;
#[cfg(test)]
#[path = "egress.result.tests.rs"]
mod egress_result_tests;
#[cfg(test)]
#[path = "egress.tests.rs"]
mod egress_tests;
#[cfg(test)]
#[path = "golden.tests.rs"]
mod golden_tests;
#[cfg(test)]
#[path = "held_input.tests.rs"]
mod held_input_tests;
#[cfg(test)]
#[path = "json_strict.tests.rs"]
mod json_strict_tests;
#[cfg(test)]
#[path = "profile.tests.rs"]
mod profile_tests;
#[cfg(test)]
#[path = "restoration.tests.rs"]
mod restoration_tests;
