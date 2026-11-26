//! Validated target descriptor: bounded fields and a canonical digest.
//!
//! Bounds are enforced before any filesystem or policy work. No credential
//! bytes, raw config text or caller-chosen transport options cross this
//! boundary.

pub(crate) use crate::config::Host;
use crate::config::{host_name::MAX_HOST, safe_token};
use crate::v1::{self, ErrorCode, TargetAuthMode, TargetKind};
use prost::Message;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

const DESCRIPTOR_MAGIC: &[u8] = b"bigbud.ssh_owner.target_descriptor.v1\0";
pub(crate) const MAX_DESCRIPTOR_BYTES: usize = 4 * 1024;
pub(crate) const MAX_TARGETS: usize = 8;
const MAX_TARGET_ID: usize = 1024;
const MAX_USER: usize = 64;
const MAX_PATH: usize = 1024;
const MAX_HOST_KEY_ALIAS: usize = 255;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Alias,
    Structured,
}

/// One validated target descriptor. Only owner-checked fields, never raw
/// config text, credential bytes or caller-chosen transport options.
#[derive(Clone, Debug)]
pub(crate) struct Descriptor {
    pub(crate) target_id: String,
    pub(crate) kind: Kind,
    pub(crate) host: Host,
    pub(crate) port: u16,
    pub(crate) user: String,
    pub(crate) identity: PathBuf,
    pub(crate) trust: PathBuf,
    /// Explicit known-hosts name; `None` uses the host's own label.
    pub(crate) host_key_alias: Option<String>,
    generation: Vec<u8>,
    digest: [u8; 32],
}

impl Descriptor {
    /// Bounds first, then semantic checks. Refusals are typed and happen before
    /// any transport work.
    pub(crate) fn parse(wire: &v1::TargetDescriptor) -> Result<Self, ErrorCode> {
        if wire.encoded_len() > MAX_DESCRIPTOR_BYTES {
            return Err(ErrorCode::InvalidOperands);
        }
        let kind = match wire.kind() {
            TargetKind::Alias => Kind::Alias,
            TargetKind::Structured => Kind::Structured,
            TargetKind::Unspecified => return Err(ErrorCode::InvalidOperands),
        };
        if wire.target_id.is_empty()
            || wire.target_id.len() > MAX_TARGET_ID
            || wire.target_id.chars().any(char::is_control)
            || wire.user.is_empty()
            || wire.user.len() > MAX_USER
            || !wire
                .user
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
            || wire.host.is_empty()
            || wire.host.len() > MAX_HOST
            || wire.host_key_alias.len() > MAX_HOST_KEY_ALIAS
            || wire.host_key_alias.chars().any(char::is_control)
            || !matches!(wire.generation.len(), 0 | 32)
        {
            return Err(ErrorCode::InvalidOperands);
        }
        let host = Host::parse(&wire.host).ok_or(ErrorCode::InvalidOperands)?;
        let host_key_alias = match wire.host_key_alias.as_str() {
            "" => None,
            alias if safe_token(alias, MAX_HOST_KEY_ALIAS) => Some(alias.to_owned()),
            _ => return Err(ErrorCode::InvalidOperands),
        };
        let port = u16::try_from(wire.port).map_err(|_| ErrorCode::InvalidOperands)?;
        if port == 0 {
            return Err(ErrorCode::InvalidOperands);
        }
        let identity = literal_path(&wire.identity_reference)?;
        let trust = literal_path(&wire.trust_reference)?;
        if identity == trust {
            return Err(ErrorCode::InvalidOperands);
        }
        // v1 admits key mode only. Agent and password are typed unsupported
        // policy, never a partial admission or a credential prompt.
        match wire.auth_mode() {
            TargetAuthMode::Key => {}
            TargetAuthMode::Unspecified => return Err(ErrorCode::InvalidOperands),
            TargetAuthMode::Agent | TargetAuthMode::Password => {
                return Err(ErrorCode::ConfigUnsupported);
            }
        }
        let digest = digest(wire);
        Ok(Self {
            target_id: wire.target_id.clone(),
            kind,
            host,
            port,
            user: wire.user.clone(),
            identity,
            trust,
            host_key_alias,
            generation: wire.generation.clone(),
            digest,
        })
    }

    pub(crate) fn generation(&self) -> &[u8] {
        &self.generation
    }

    pub(crate) fn digest(&self) -> [u8; 32] {
        self.digest
    }
}

fn literal_path(value: &str) -> Result<PathBuf, ErrorCode> {
    if value.is_empty() || value.len() > MAX_PATH || value.as_bytes().contains(&0) {
        return Err(ErrorCode::InvalidOperands);
    }
    let path = PathBuf::from(value);
    if !crate::transport::identity_is_literal(&path) {
        return Err(ErrorCode::InvalidOperands);
    }
    Ok(path)
}

/// Canonical descriptor digest: distinguishes a changed descriptor for the same
/// target id from a stale generation.
fn digest(wire: &v1::TargetDescriptor) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(DESCRIPTOR_MAGIC);
    let port = wire.port.to_string();
    for part in [
        wire.target_id.as_str(),
        wire.kind.to_string().as_str(),
        wire.host.as_str(),
        port.as_str(),
        wire.user.as_str(),
        wire.auth_mode.to_string().as_str(),
        wire.identity_reference.as_str(),
        wire.host_key_alias.as_str(),
        wire.trust_reference.as_str(),
    ] {
        hasher.update([0]);
        hasher.update(part.as_bytes());
    }
    hasher.finalize().into()
}

#[cfg(test)]
#[path = "targets.descriptor.tests.rs"]
mod tests;
