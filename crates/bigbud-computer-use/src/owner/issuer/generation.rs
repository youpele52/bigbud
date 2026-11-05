//! Approved first-party artifact generation: the only digest the issuer may
//! accept. Production has NO constructor: verified immutable generations need
//! M6.2 staging/hash approval, so issuance fails closed today.
use crate::Role;
use std::io;

pub struct ApprovedGeneration {
    pub(super) role: Role,
    pub(super) generation: String,
    pub(super) digest: [u8; 32],
}
impl ApprovedGeneration {
    /// Always refuses until verified per-target generations exist (M6.2).
    pub fn selected(_role: Role) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no verified first-party artifact generation is approved (M6.2 blocked)",
        ))
    }
    #[cfg(test)]
    pub(crate) fn fixture(role: Role, generation: &str, digest: [u8; 32]) -> Self {
        Self {
            role,
            generation: generation.into(),
            digest,
        }
    }
}
