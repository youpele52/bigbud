//! Platform-neutral native owner admission state (M2). Deterministic models
//! fed by authenticated, role-bound channels; no transport, thread or I/O.
//! Nothing here is wired to a selected runtime; legacy 0.9.1 stays selected.
pub mod authority;
#[cfg(test)]
#[path = "authority.tests.rs"]
mod authority_tests;
pub mod clocks;
#[cfg(test)]
#[path = "clocks.tests.rs"]
mod clocks_tests;
pub mod control;
#[cfg(test)]
#[path = "control.tests.rs"]
mod control_tests;
pub mod hello;
#[cfg(test)]
#[path = "hello.tests.rs"]
mod hello_tests;
pub mod human_recovery;
pub mod ledger;
#[cfg(test)]
#[path = "ledger.tests.rs"]
mod ledger_tests;
pub mod limits;
pub mod policy;
pub mod policy_canonical;
#[cfg(test)]
#[path = "policy_canonical.tests.rs"]
mod policy_canonical_tests;
#[cfg(test)]
#[path = "policy.tests.rs"]
mod policy_tests;
pub mod references;
#[cfg(test)]
#[path = "references.selection.tests.rs"]
mod references_selection_tests;
#[cfg(test)]
#[path = "references.tests.rs"]
mod references_tests;
pub mod scheduler;
#[cfg(test)]
#[path = "scheduler.tests.rs"]
mod scheduler_tests;
pub mod session;
