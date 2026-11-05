//! Execution identities and dormant containment primitives; not an active launcher.
mod environment;
mod identity;
#[cfg(test)]
mod tests;
#[cfg(unix)]
pub mod unix;
#[cfg(windows)]
pub mod windows;
mod windows_launch;
pub use identity::{ExecutionRoot, Observation, RetirementDecision, retirement_decision};

pub use environment::{EnvironmentError, ManagedEnvironment, build_environment};
