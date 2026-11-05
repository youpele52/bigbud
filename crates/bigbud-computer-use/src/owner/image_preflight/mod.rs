//! Dormant macOS staging preflight for an explicitly UNTRUSTED candidate.
//! This is not cryptographic identity, signature verification, signed ancestry,
//! native-closure qualification, or permission to execute. No descriptor/path
//! escape or conversion to BootstrapPermit exists. The eventual trusted issuer
//! must add those checks and bind retained election/recovery, interactive login
//! and continuity, global launch exclusion, child FD allow-set/startup ownership.
//! Metadata/name checks detect observed changes, not atomic isolation against
//! malicious root or arbitrary same-user programs. No filesystem repair occurs.
mod candidate;
mod digest;
mod macho;
#[cfg(test)]
pub(crate) mod macho_tests;
mod metadata;

pub use candidate::ImagePreflight;
