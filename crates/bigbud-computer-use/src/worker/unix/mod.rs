//! Dormant native primitives, not a qualified bootstrap or permission to admit
//! work. The held group anchor must outlive all execution helpers. No PID/name
//! recovery path may construct an anchor or signal an unowned process group.
mod anchor;
mod exclusion;
mod identity;
#[cfg(any(target_os = "linux", test))]
mod identity_linux;
#[cfg(target_os = "macos")]
mod identity_macos;
#[cfg(target_os = "linux")]
mod pidfd;
#[cfg(test)]
mod tests;
pub use anchor::{
    AnchorError, AnchoredGroup, BootstrapError, ClosureState, RetirementSignal, SettleError,
    SettledRoot,
};
pub use exclusion::LaunchGuard;
pub use identity::{ProcessIdentity, inspect};
