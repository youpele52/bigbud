//! Restricted `nc %h %p` route helper. The owner resolves the program once on
//! the profile's approved absolute PATH entries, pins the exact image, and
//! revalidates that pin immediately before every launch. The helper receives
//! two structured operands, no environment, no inherited descriptors besides
//! its two pipes, and never any credential or askpass grant.

use super::ErrorCode;
use crate::config::connector::ConnectorProgram;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

const UNAVAILABLE: ErrorCode = ErrorCode::RouteUnavailable;
const MAX_IMAGE: u64 = 16 * 1024 * 1024;
const MAX_PATH_ENTRIES: usize = 4;

/// Trusted startup facts: the release-qualified image digest and the
/// initiating profile's approved PATH directories, in search order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ConnectorApproval {
    image: [u8; 32],
    path: Vec<PathBuf>,
}

impl ConnectorApproval {
    pub(crate) fn new(image: [u8; 32], path: Vec<PathBuf>) -> Result<Self, ErrorCode> {
        if path.is_empty()
            || path.len() > MAX_PATH_ENTRIES
            || path.iter().any(|entry| !entry.is_absolute())
        {
            return Err(ErrorCode::ConfigUnsupported);
        }
        Ok(Self { image, path })
    }

    pub(crate) fn fingerprint_into(&self, digest: &mut Sha256) {
        digest.update(b"connector\0");
        digest.update(self.image);
        for entry in &self.path {
            digest.update(entry.as_os_str().as_encoded_bytes());
            digest.update([0]);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    dev: u64,
    ino: u64,
    size: u64,
    mtime: i64,
    mtime_nsec: i64,
    mode: u32,
    uid: u32,
}

#[derive(Debug)]
pub(crate) struct PinnedConnector {
    path: PathBuf,
    stamp: Stamp,
    image: [u8; 32],
}

/// Qualify without executing anything. A bare name resolves to the first
/// existing `nc` on the approved PATH; if that candidate is substituted the
/// route is unavailable rather than silently searching further.
pub(crate) fn qualify(
    program: &ConnectorProgram,
    approval: Option<&ConnectorApproval>,
) -> Result<PinnedConnector, ErrorCode> {
    let approval = approval.ok_or(UNAVAILABLE)?;
    let path = match program {
        ConnectorProgram::Absolute(path) => path.clone(),
        ConnectorProgram::Bare => approval
            .path
            .iter()
            .map(|entry| entry.join("nc"))
            .find(|candidate| fs::symlink_metadata(candidate).is_ok())
            .ok_or(UNAVAILABLE)?,
    };
    let (stamp, image) = inspect(&path)?;
    if image != approval.image {
        return Err(UNAVAILABLE);
    }
    Ok(PinnedConnector { path, stamp, image })
}

fn stamp(path: &Path) -> Result<Stamp, ErrorCode> {
    let meta = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE)?;
    // SAFETY: geteuid takes no arguments and observes only this process.
    let euid = unsafe { libc::geteuid() };
    let parent = path
        .parent()
        .and_then(|parent| fs::symlink_metadata(parent).ok())
        .ok_or(UNAVAILABLE)?;
    if !meta.file_type().is_file()
        || meta.mode() & 0o022 != 0
        || meta.mode() & 0o111 == 0
        || meta.len() > MAX_IMAGE
        || (meta.uid() != 0 && meta.uid() != euid)
        || !parent.is_dir()
        || parent.mode() & 0o022 != 0
    {
        return Err(UNAVAILABLE);
    }
    Ok(Stamp {
        dev: meta.dev(),
        ino: meta.ino(),
        size: meta.len(),
        mtime: meta.mtime(),
        mtime_nsec: meta.mtime_nsec(),
        mode: meta.mode(),
        uid: meta.uid(),
    })
}

fn inspect(path: &Path) -> Result<(Stamp, [u8; 32]), ErrorCode> {
    let before = stamp(path)?;
    let mut file = File::open(path).map_err(|_| UNAVAILABLE)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_IMAGE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    let opened = file.metadata().map_err(|_| UNAVAILABLE)?;
    if opened.dev() != before.dev
        || opened.ino() != before.ino
        || bytes.len() as u64 != before.size
        || stamp(path)? != before
    {
        return Err(UNAVAILABLE);
    }
    Ok((before, Sha256::digest(&bytes).into()))
}

impl PinnedConnector {
    pub(crate) fn revalidate(&self) -> Result<(), ErrorCode> {
        let (stamp, image) = inspect(&self.path)?;
        if stamp != self.stamp || image != self.image {
            return Err(UNAVAILABLE);
        }
        Ok(())
    }

    /// Launch `nc <host> <port>` with structured argv and private pipes only.
    pub(crate) fn spawn(&self, host: &str, port: u16) -> Result<Child, ErrorCode> {
        self.revalidate()?;
        Command::new(&self.path)
            .arg(host)
            .arg(port.to_string())
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| UNAVAILABLE)
    }
}

impl super::Transport {
    pub(super) fn bind_connector(&mut self, facts: &crate::config::RouteFacts) {
        self.connector = self
            .policy
            .as_ref()
            .and_then(|policy| policy.connector.as_ref())
            .map(|program| qualify(program, facts.connector()));
    }

    /// The direct-route guard for every SSH child and host-key scan.
    pub(super) fn require_direct_route(&self) -> Result<(), ErrorCode> {
        if self.connector.is_some() {
            return Err(ErrorCode::RouteUnavailable);
        }
        Ok(())
    }

    pub(super) fn connector(&self) -> Option<Result<&PinnedConnector, ErrorCode>> {
        self.connector
            .as_ref()
            .map(|result| result.as_ref().map_err(|error| *error))
    }

    /// SSH for the owner-managed connector link only; the caller supplies the
    /// helper's pipes as this child's stdio with `ProxyCommand=-`.
    pub(super) fn connector_pinned_ssh(&self, tty: &str) -> Result<super::PinnedSsh, ErrorCode> {
        self.connector().ok_or(ErrorCode::RouteUnavailable)??;
        let pin = self.pin()?.ok_or(ErrorCode::TrustRequired)?;
        self.build_ssh_for_pin(tty, None, false, &pin, super::HostVerification::Ed25519Key)
    }
}

#[cfg(test)]
#[path = "connector_tests.rs"]
mod tests;
