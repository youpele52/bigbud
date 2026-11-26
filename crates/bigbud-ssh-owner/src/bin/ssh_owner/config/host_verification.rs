use super::{ErrorCode, UNSUPPORTED};

/// U23: host-key algorithms a plain pinned key may use (OpenSSH defaults
/// minus SHA-1 `ssh-rsa` and DSA).
const KEY_ALGORITHMS: [&str; 6] = [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "rsa-sha2-512",
    "rsa-sha2-256",
];

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub(crate) enum HostVerification {
    /// A plain pinned host key of any accepted type (U23). The launch passes
    /// exactly the pinned types; the name predates multi-type pins.
    #[default]
    Ed25519Key,
    Ed25519Certificate,
}

impl HostVerification {
    pub(super) fn parse(value: &str) -> Result<Self, ErrorCode> {
        if value == "ssh-ed25519-cert-v01@openssh.com" {
            return Ok(Self::Ed25519Certificate);
        }
        // A user list drawn only from the accepted algorithms selects key
        // pinning; no modifier, SHA-1 `ssh-rsa`, DSA or other certificate.
        let plain = !value.is_empty()
            && value
                .split(',')
                .all(|algorithm| KEY_ALGORITHMS.contains(&algorithm));
        if plain {
            Ok(Self::Ed25519Key)
        } else {
            Err(UNSUPPORTED)
        }
    }

    pub(crate) const fn option(self) -> &'static str {
        match self {
            Self::Ed25519Key => "HostKeyAlgorithms=ssh-ed25519",
            Self::Ed25519Certificate => "HostKeyAlgorithms=ssh-ed25519-cert-v01@openssh.com",
        }
    }
}
