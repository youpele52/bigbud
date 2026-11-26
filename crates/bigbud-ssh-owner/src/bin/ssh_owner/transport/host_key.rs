//! Host keys the owner pins (U23): OpenSSH's default host-key types minus
//! SHA-1 and DSA. `ssh-ed25519`, `ecdsa-sha2-nistp256/384/521` and `ssh-rsa`
//! keys (verified only with `rsa-sha2-512`/`rsa-sha2-256` signatures), each
//! validated exactly. Peer enrollment and jump observation stay ed25519-only
//! and use [`TYPE`].

use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::time::Instant;

#[path = "host_key/wire.rs"]
mod wire;

/// The ed25519 key type, for the lanes that remain ed25519-only.
pub(super) const TYPE: &str = "ssh-ed25519";
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/// Base64 of a 16384-bit RSA key blob fits well within this.
const MAX_ENCODED: usize = 3_072;
/// keyscan types, in the owner's preference order (ed25519 first).
#[cfg(unix)]
const SCAN_TYPES: &str = "ed25519,ecdsa,rsa";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum KeyType {
    Ed25519,
    EcdsaP256,
    EcdsaP384,
    EcdsaP521,
    Rsa,
}

impl KeyType {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "ssh-ed25519" => Self::Ed25519,
            "ecdsa-sha2-nistp256" => Self::EcdsaP256,
            "ecdsa-sha2-nistp384" => Self::EcdsaP384,
            "ecdsa-sha2-nistp521" => Self::EcdsaP521,
            "ssh-rsa" => Self::Rsa,
            _ => return None,
        })
    }

    /// The key-format name written in `known_hosts`.
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Ed25519 => TYPE,
            Self::EcdsaP256 => "ecdsa-sha2-nistp256",
            Self::EcdsaP384 => "ecdsa-sha2-nistp384",
            Self::EcdsaP521 => "ecdsa-sha2-nistp521",
            Self::Rsa => "ssh-rsa",
        }
    }

    #[cfg(any(unix, test))]
    /// The `HostKeyAlgorithms` entries that verify this key; RSA never SHA-1.
    pub(super) fn algorithms(self) -> &'static str {
        match self {
            Self::Rsa => "rsa-sha2-512,rsa-sha2-256",
            other => other.name(),
        }
    }
}

#[cfg(any(unix, test))]
/// A `known_hosts` key type the owner accepts (U23).
pub(super) fn accepted_type(name: &str) -> bool {
    KeyType::parse(name).is_some()
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct HostKey {
    kind: KeyType,
    encoded: String,
    blob: Vec<u8>,
}

impl HostKey {
    /// Exactly one record, of any accepted type.
    pub(super) fn from_keyscan(bytes: &[u8], host: &str) -> Option<Self> {
        let mut keys = Self::from_keyscan_all(bytes, host)?;
        (keys.len() == 1).then(|| keys.pop())?
    }

    /// Every record a multi-type keyscan printed, at most one per type, in the
    /// owner's preference order. Recent OpenSSH writes banner comments too.
    pub(super) fn from_keyscan_all(bytes: &[u8], host: &str) -> Option<Vec<Self>> {
        let mut keys: Vec<Self> = Vec::new();
        for row in std::str::from_utf8(bytes).ok()?.lines() {
            if row.is_empty() || row.starts_with('#') {
                continue;
            }
            let key = Self::from_record(row.as_bytes(), host)?;
            if keys.iter().any(|known| known.kind == key.kind) {
                return None;
            }
            keys.push(key);
        }
        keys.sort_by_key(|key| key.kind);
        (!keys.is_empty()).then_some(keys)
    }

    pub(super) fn from_record(bytes: &[u8], host: &str) -> Option<Self> {
        let record = std::str::from_utf8(bytes).ok()?;
        let record = record.strip_suffix('\n').unwrap_or(record);
        if record.contains(['\n', '\r']) {
            return None;
        }
        let (label, record) = record.split_once(' ')?;
        let (name, encoded) = record.split_once(' ')?;
        if label != host || encoded.len() > MAX_ENCODED {
            return None;
        }
        let kind = KeyType::parse(name)?;
        let blob = decode(encoded)?;
        (wire::validate(&blob) == Some(kind)).then(|| Self {
            kind,
            encoded: encoded.to_owned(),
            blob,
        })
    }

    #[cfg(any(unix, test))]
    pub(super) fn kind(&self) -> KeyType {
        self.kind
    }

    #[cfg(any(unix, test))]
    /// The key type as shown in trust approval (`ssh-ed25519`, `ssh-rsa`, ...).
    pub(super) fn key_type(&self) -> &'static str {
        self.kind.name()
    }

    pub(super) fn record(&self, host: &str) -> String {
        format!("{host} {} {}\n", self.kind.name(), self.encoded)
    }

    #[cfg(any(unix, test))]
    /// `<type> <base64>` without a comment or host label.
    pub(super) fn record_value(&self) -> String {
        format!("{} {}", self.kind.name(), self.encoded)
    }

    #[cfg(any(unix, test))]
    /// Lowercase `sha256:<hex>` over the decoded key blob, matching the peer
    /// grant's `coordinatorKeyFingerprint` form.
    pub(super) fn fingerprint_hex(&self) -> String {
        let digest = Sha256::digest(&self.blob);
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("sha256:{hex}")
    }

    /// OpenSSH's `SHA256:<base64, unpadded>` fingerprint, for every type.
    pub(super) fn fingerprint(&self) -> String {
        let digest = Sha256::digest(&self.blob);
        let mut fingerprint = String::with_capacity(50);
        fingerprint.push_str("SHA256:");
        let (groups, tail) = digest.as_slice().as_chunks::<3>();
        for &[a, b, c] in groups {
            fingerprint.extend([
                letter(a >> 2),
                letter(a << 4 | b >> 4),
                letter(b << 2 | c >> 6),
                letter(c),
            ]);
        }
        if let &[a, b] = tail {
            fingerprint.extend([letter(a >> 2), letter(a << 4 | b >> 4), letter(b << 2)]);
        }
        fingerprint
    }
}

/// Strict padded or unpadded standard Base64.
fn decode(encoded: &str) -> Option<Vec<u8>> {
    let body = encoded.trim_end_matches('=');
    let padding = encoded.len() - body.len();
    if padding > 2 || (padding > 0 && !encoded.len().is_multiple_of(4)) || body.len() % 4 == 1 {
        return None;
    }
    let mut bits = 0u32;
    let mut count = 0;
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for &byte in body.as_bytes() {
        bits = bits << 6 | u32::from(digit(byte)?);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push(u8::try_from(bits >> count & 0xff).ok()?);
            bits &= (1 << count) - 1;
        }
    }
    // Unused trailing bits must be zero (canonical encoding).
    (bits == 0).then_some(out)
}

fn digit(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[allow(
    clippy::indexing_slicing,
    reason = "a six-bit index is in range for the 64-byte alphabet"
)]
fn letter(bits: u8) -> char {
    BASE64[usize::from(bits & 63)] as char
}

#[cfg(unix)]
impl super::Transport {
    /// Every accepted host key the server offers, in preference order.
    pub(super) fn scan_keys(&self, deadline: Instant) -> Result<Vec<HostKey>, super::ErrorCode> {
        use super::{ErrorCode, process};
        // No user, identity, SSH options, or inherited environment reach keyscan.
        self.require_direct_route()?;
        let mut scanner = self.images.keyscan()?;
        scanner
            .args([self.family, "-T", "10", "-t", SCAN_TYPES, "-p"])
            .arg(self.config.port.to_string())
            .arg(&self.host);
        let output = process::run(scanner, deadline, 16 * 1024).map_err(|error| match error {
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            _ => ErrorCode::TransportLost,
        })?;
        if !output.status.success() || output.truncated {
            return Err(ErrorCode::TransportLost);
        }
        HostKey::from_keyscan_all(&output.stdout, &self.scan_label).ok_or(ErrorCode::TransportLost)
    }

    /// The most preferred host key the server offers.
    pub(super) fn scan(&self, deadline: Instant) -> Result<HostKey, super::ErrorCode> {
        self.scan_keys(deadline)?
            .into_iter()
            .next()
            .ok_or(super::ErrorCode::TransportLost)
    }
}

#[cfg(test)]
#[path = "host_key/fixtures.rs"]
pub(super) mod fixtures;

#[cfg(test)]
#[path = "host_key/tests.rs"]
mod tests;

#[cfg(test)]
mod ed25519_tests {
    use super::*;

    #[test]
    fn matches_openssh_fingerprint_and_requires_exact_record() {
        let label = "[127.0.0.1]:2200";
        let record = format!(
            "{label} {TYPE} AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"
        );
        let key = HostKey::from_record(record.as_bytes(), label).expect("synthetic host key");
        assert_eq!(
            key.fingerprint(),
            "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk"
        );
        let scan = format!("# fixture SSH-2.0-OpenSSH\n{record}");
        assert!(HostKey::from_keyscan(scan.as_bytes(), label).is_some());
        assert!(HostKey::from_keyscan(scan.repeat(2).as_bytes(), label).is_none());
        assert!(HostKey::from_record(scan.as_bytes(), label).is_none());
        assert!(HostKey::from_record(record.as_bytes(), "127.0.0.1").is_none());
        assert!(HostKey::from_record(record.repeat(2).as_bytes(), label).is_none());
        assert!(
            HostKey::from_record(record.replace("AAAAIA", "AAAAJA").as_bytes(), label).is_none()
        );
    }
}
