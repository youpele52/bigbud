use super::{ErrorCode, UNSUPPORTED};

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub(crate) enum HostVerification {
    #[default]
    Ed25519Key,
    Ed25519Certificate,
}

impl HostVerification {
    pub(super) fn parse(value: &str) -> Result<Self, ErrorCode> {
        match value {
            "ssh-ed25519" => Ok(Self::Ed25519Key),
            "ssh-ed25519-cert-v01@openssh.com" => Ok(Self::Ed25519Certificate),
            _ => Err(UNSUPPORTED),
        }
    }

    pub(crate) const fn option(self) -> &'static str {
        match self {
            Self::Ed25519Key => "HostKeyAlgorithms=ssh-ed25519",
            Self::Ed25519Certificate => "HostKeyAlgorithms=ssh-ed25519-cert-v01@openssh.com",
        }
    }
}
