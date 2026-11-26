//! U24 production peer enrollment and relay: the transport-side pieces.
//!
//! The owner-wide coordinator key, a one-shot presented-key scan, the exact
//! known-hosts record a pairing pin is stored as, and the pinned SSH command
//! for one relay channel. Pairing authority (which pin, which user, which
//! coordinator key) comes only from the owner's own pin store; see
//! `owner/peer.rs`.

use super::{
    ErrorCode, HostKey, PinnedSsh, Transport, TransportConfig, host_key, peer, peer_enrollment,
};
use crate::openssh_image::Images;
use std::path::{Path, PathBuf};

pub(crate) use peer::PEER_TRIGGER;

/// The coordinator key's public metadata and its owner-private key path.
pub(crate) struct CoordinatorKey {
    pub(crate) public_key: String,
    /// `sha256:<hex>` of the public key blob (the peer grant form).
    pub(crate) fingerprint: String,
    pub(crate) algorithm: &'static str,
    pub(crate) private: PathBuf,
}

/// Provision or reuse the owner-wide coordinator key. A corrupt, foreign or
/// unsafe key is `PeerKeyCorrupt`; it is never regenerated.
pub(crate) fn coordinator_key(state_dir: &Path) -> Result<CoordinatorKey, ErrorCode> {
    let (key, private) = peer_enrollment::ensure_coordinator(state_dir).map_err(corrupt)?;
    Ok(CoordinatorKey {
        public_key: key.record_value(),
        fingerprint: key.fingerprint_hex(),
        algorithm: host_key::TYPE,
        private,
    })
}

fn corrupt(error: ErrorCode) -> ErrorCode {
    match error {
        ErrorCode::ConfigUnsupported => ErrorCode::PeerKeyCorrupt,
        other => other,
    }
}

/// The key one endpoint presented. Opaque outside the transport so only an
/// actual scan can produce one.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct PresentedKey(HostKey);

impl PresentedKey {
    pub(crate) fn key_type(&self) -> &'static str {
        self.0.key_type()
    }

    /// OpenSSH `SHA256:<base64>`.
    pub(crate) fn fingerprint(&self) -> String {
        self.0.fingerprint()
    }

    /// `<type> <base64>`.
    pub(crate) fn public_key(&self) -> String {
        self.0.record_value()
    }

    /// Parse a stored `<type> <base64>` value back (pin store reads).
    pub(crate) fn parse(value: &str) -> Option<Self> {
        peer::public_key(value.as_bytes()).map(Self)
    }
}

/// One-shot scan of `host`:`port` with the validated system keyscan image.
pub(crate) fn inspect(
    ssh: &Path,
    keyscan: &Path,
    host: &str,
    port: u32,
) -> Result<PresentedKey, ErrorCode> {
    let images = Images::bind(ssh, keyscan)?;
    peer_enrollment::scan_endpoint(images.keyscan()?, host, port).map(PresentedKey)
}

impl Transport {
    /// The known-hosts record this transport reads its pin from.
    pub(crate) fn peer_pin_record(&self, key: &PresentedKey) -> String {
        key.0.record(&self.scan_label)
    }

    /// The checked relay command: the pin must still match the live scan and
    /// the identity must still be the bound coordinator key. The caller appends
    /// the destination and `PEER_TRIGGER`.
    pub(crate) fn production_peer_ssh(
        &self,
        host_fingerprint: &str,
        coordinator_fingerprint: &str,
    ) -> Result<(PinnedSsh, String), ErrorCode> {
        let pinned = self
            .peer_ssh_base(host_fingerprint, coordinator_fingerprint)
            .map_err(|error| match error {
                ErrorCode::HostKeyChanged => ErrorCode::PeerPinMismatch,
                ErrorCode::AuthRequired => ErrorCode::PeerAuthRefused,
                ErrorCode::ConfigUnsupported => ErrorCode::PeerKeyCorrupt,
                other => other,
            })?;
        Ok((pinned, self.host.clone()))
    }
}

/// A production peer transport is a plain pinned route: no alias policy, no
/// system config, no workspace root and no interactive terminal.
pub(crate) fn peer_config(
    ssh: PathBuf,
    keyscan: PathBuf,
    address: std::net::IpAddr,
    port: u16,
    user: String,
    identity: PathBuf,
    known_hosts: PathBuf,
) -> TransportConfig {
    TransportConfig {
        ssh,
        keyscan,
        host: address,
        port,
        user,
        identity,
        known_hosts,
        alias_config: None,
        system_config: None,
        workspace_root: None,
        dev_interactive_terminal: false,
        // Dialled and pinned under the address; see `resolve_peer_host`.
        host_identity: super::HostIdentity::default(),
    }
}
