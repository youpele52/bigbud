//! Target identity (plan M3 "Store platform-qualified application selectors";
//! M3.identity). A live target is bound to a VERIFIED identity read by the
//! owner from the OS, never to a Driver-reported name or bundle string:
//! process creation identity, executable path and (macOS) the enclosing
//! bundle and its CFBundle identifier. Labels are presentation only. A pid
//! whose identity cannot be verified is excluded, not guessed.
mod policy;
#[cfg(test)]
mod policy_tests;
mod verified;

#[cfg(target_os = "macos")]
mod bundle_macos;
#[cfg(target_os = "macos")]
mod source_macos;

pub use policy::{HardBlocks, IdentityAppPolicy, IdentityPolicy, IdentityPolicyError};
pub use verified::{
    BundleIdentity, FileIdentity, IdentitySource, VerifiedApp, enclosing_bundle, file_identity,
    inside_app_bundle,
};

#[cfg(target_os = "macos")]
pub use source_macos::MacIdentitySource;
