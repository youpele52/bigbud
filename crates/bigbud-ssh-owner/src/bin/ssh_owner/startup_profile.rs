//! Trusted production profile binding (W3.7).
//!
//! The binding is `bbso1:<kind>:<sha256-hex>` over the canonical state
//! directory, its device/inode identity and the initiating profile kind. The
//! owner recomputes it from `--state-dir`, so a caller cannot name one profile
//! and start an owner for another. Refusals are bounded, redacted JSON lines.

use sha2::{Digest, Sha256};
use std::{
    fs, io,
    io::Write,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

pub(super) const BINDING_SCHEMA: &str = "bigbud.ssh-owner.production-profile.v1";
const BINDING_PREFIX: &str = "bbso1";
const MAX_RECORD_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProfileKind {
    DesktopPackaged,
    DesktopDev,
    Standalone,
    RemoteBackend,
}

impl ProfileKind {
    /// Whether an owner of this kind may outlive its launcher. A non-surviving
    /// owner is bound to the launcher-lifetime descriptor (FD 3) and retires
    /// when the launcher is gone, even if it never shut its handle down.
    pub(super) fn survives_launcher(self) -> bool {
        !matches!(self, Self::DesktopDev)
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::DesktopPackaged => "desktop-packaged",
            Self::DesktopDev => "desktop-dev",
            Self::Standalone => "standalone",
            Self::RemoteBackend => "remote-backend",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "desktop-packaged" => Some(Self::DesktopPackaged),
            "desktop-dev" => Some(Self::DesktopDev),
            "standalone" => Some(Self::Standalone),
            "remote-backend" => Some(Self::RemoteBackend),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProfileRefusal {
    MissingFlag,
    Conflict,
    MalformedProfile,
    UnknownKind,
    StateDirectoryMissing,
    StateDirectoryNotCanonical,
    StateDirectoryUnsafe,
    ProfileMismatch,
    HelloMismatch,
}

impl ProfileRefusal {
    fn code(self) -> &'static str {
        match self {
            Self::MissingFlag => "production_flag_missing",
            Self::Conflict => "production_fixture_conflict",
            Self::MalformedProfile => "production_profile_malformed",
            Self::UnknownKind => "production_profile_kind_unknown",
            Self::StateDirectoryMissing => "production_state_dir_missing",
            Self::StateDirectoryNotCanonical => "production_state_dir_not_canonical",
            Self::StateDirectoryUnsafe => "production_state_dir_unsafe",
            Self::ProfileMismatch => "production_profile_mismatch",
            Self::HelloMismatch => "production_hello_profile_mismatch",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ProductionProfile {
    pub(super) kind: ProfileKind,
    pub(super) digest: [u8; 32],
}

impl ProductionProfile {
    pub(super) fn parse(text: &str) -> Result<Self, ProfileRefusal> {
        let mut parts = text.split(':');
        let prefix = parts.next().ok_or(ProfileRefusal::MalformedProfile)?;
        let kind = parts.next().ok_or(ProfileRefusal::MalformedProfile)?;
        let hex = parts.next().ok_or(ProfileRefusal::MalformedProfile)?;
        if prefix != BINDING_PREFIX || parts.next().is_some() {
            return Err(ProfileRefusal::MalformedProfile);
        }
        let kind = ProfileKind::parse(kind).ok_or(ProfileRefusal::UnknownKind)?;
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(ProfileRefusal::MalformedProfile);
        }
        let mut digest = [0; 32];
        for (byte, pair) in digest.iter_mut().zip(hex.as_bytes().chunks_exact(2)) {
            let pair = std::str::from_utf8(pair).map_err(|_| ProfileRefusal::MalformedProfile)?;
            *byte = u8::from_str_radix(pair, 16).map_err(|_| ProfileRefusal::MalformedProfile)?;
        }
        Ok(Self { kind, digest })
    }

    /// Recomputes the binding from the state directory named on the command line.
    pub(super) fn verify(&self, state_directory: &Path) -> Result<PathBuf, ProfileRefusal> {
        let canonical = fs::canonicalize(state_directory).map_err(|_| {
            if state_directory.exists() {
                ProfileRefusal::StateDirectoryNotCanonical
            } else {
                ProfileRefusal::StateDirectoryMissing
            }
        })?;
        if canonical != state_directory {
            return Err(ProfileRefusal::StateDirectoryNotCanonical);
        }
        let metadata =
            fs::symlink_metadata(&canonical).map_err(|_| ProfileRefusal::StateDirectoryMissing)?;
        if !metadata.is_dir() {
            return Err(ProfileRefusal::StateDirectoryNotCanonical);
        }
        // SAFETY: geteuid takes no arguments and observes only this process.
        let uid = unsafe { libc::geteuid() };
        if metadata.uid() != uid || metadata.mode() & 0o022 != 0 {
            return Err(ProfileRefusal::StateDirectoryUnsafe);
        }
        let path = canonical
            .to_str()
            .ok_or(ProfileRefusal::StateDirectoryNotCanonical)?;
        let expected = digest(
            self.kind,
            path,
            &metadata.dev().to_string(),
            &metadata.ino().to_string(),
        );
        if expected != self.digest {
            return Err(ProfileRefusal::ProfileMismatch);
        }
        Ok(canonical)
    }
}

pub(super) fn digest(kind: ProfileKind, path: &str, device: &str, inode: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(BINDING_SCHEMA.as_bytes());
    for part in [kind.as_str(), path, device, inode] {
        hasher.update([0]);
        hasher.update(part.as_bytes());
    }
    hasher.finalize().into()
}

/// One bounded, redacted refusal line. No paths, inodes or digests.
pub(super) fn report_refusal(refusal: ProfileRefusal, mut sink: impl Write) {
    let record = format!(
        "{{\"event\":\"ssh_owner_production_refused\",\"version\":1,\"code\":\"{}\"}}\n",
        refusal.code()
    );
    if record.len() <= MAX_RECORD_BYTES {
        let _ = sink.write_all(record.as_bytes());
    }
}

pub(super) fn report_startup_refusal(refusal: ProfileRefusal) {
    report_refusal(refusal, io::stderr().lock());
}

/// Hello binding mismatch is a typed refusal only in production mode.
pub(super) fn report_hello_if_production(production: bool) {
    if production {
        report_startup_refusal(ProfileRefusal::HelloMismatch);
    }
}

#[cfg(test)]
#[path = "startup_profile_tests.rs"]
mod tests;
