//! Trusted bootstrap issuer composition (macOS, dormant). A BootstrapPermit is
//! minted only under the process-wide launch exclusion after: retained election
//! with verified root-free storage; a bound interactive-identity sample with no
//! invalidation; an untrusted-candidate preflight whose retained-descriptor
//! SHA-256 equals an APPROVED first-party generation; and a clean FD allow-set
//! audit. Production has no approved generation (M6.2), so issuance refuses.
//! Code-signature/signed-ancestry verification is not implemented (needs the
//! packaging/signing identity) and is NOT implied by a digest match.
mod generation;
mod issue;
#[cfg(test)]
mod tests;

pub use crate::worker::unix::LaunchGuard;
pub use generation::ApprovedGeneration;
pub use issue::IssueError;
