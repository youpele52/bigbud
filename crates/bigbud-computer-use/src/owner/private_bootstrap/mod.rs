//! Dormant macOS bootstrap, never Driver/MCP stdin or a selected runtime.
//! Inherited-once courier carries a fixed private route prelude + credential,
//! then closes. A separate post-exec connection supplies kernel child identity.
//! Parent identity is checked before the child sends its credential.
//!
//! Transient sockets use a fresh private leaf under descriptor-validated
//! /private/tmp, separate from the durable election root. Other-UID substitution
//! is excluded by actual ACL/owner/mode/sticky checks. Hostile root or arbitrary
//! same-UID filesystem mutation is outside the approved plan's OS-isolation
//! scope; pre/post inode checks are NOT claimed to solve that threat. Cleanup
//! preserves observed replacement/ambiguity. No cwd/umask changes or SCM_RIGHTS.
//!
//! BootstrapPermit comes only from the trusted issuer (owner/issuer), which has
//! no approved first-party generation yet. Darwin creation/CLOEXEC repair is
//! not atomic, hence the process-wide LaunchGuard plus FD audit. Roles remain
//! disabled; same-process tests do not qualify cross-exec identity/inheritance.
mod acl;
mod child;
mod connect;
mod directory;
mod endpoint;
mod exchange;
mod io;
mod launch;
mod route;

pub use child::ChildBootstrap;
pub(in crate::owner) use launch::IssuerBinding;
pub use launch::{AwaitingChild, BootstrapPermit, ConnectedChild, DeliveryFailure, PendingChild};

#[cfg(test)]
mod endpoint_tests;
#[cfg(test)]
mod tests;

// Private integration fixture seams; absent from production builds.
#[cfg(test)]
#[allow(dead_code)]
pub(crate) mod dummy_fixture;
