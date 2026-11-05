//! Owner/worker lifeline state independent of blocked execution. The guard owns
//! durable safety state; the owner must never become a second policy journal.
pub mod admission;
pub mod identity;
mod lifeline;
pub mod mediation;
#[cfg(test)]
mod tests;
pub use lifeline::{Lifeline, LifelineState};

#[cfg(unix)]
mod unix_auth;
#[cfg(unix)]
mod unix_bootstrap;
#[cfg(unix)]
mod unix_peer;
#[cfg(unix)]
pub use unix_auth::{AuthenticatedPeer, BootstrapCapability};
#[cfg(unix)]
mod independent_lifeline;
#[cfg(unix)]
pub use independent_lifeline::{IndependentLifeline, WatcherOutcome};
#[cfg(target_os = "macos")]
pub mod image_preflight;
#[cfg(target_os = "macos")]
pub mod issuer;
#[cfg(target_os = "macos")]
pub mod private_bootstrap;
