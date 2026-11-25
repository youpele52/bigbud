use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::time::Instant;

pub(super) const TYPE: &str = "ssh-ed25519";
const BLOB_PREFIX: &[u8] = b"\0\0\0\x0bssh-ed25519\0\0\0\x20";
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

#[derive(Clone, PartialEq, Eq)]
pub(super) struct HostKey {
    encoded: String,
    blob: Vec<u8>,
}

impl HostKey {
    pub(super) fn from_keyscan(bytes: &[u8], host: &str) -> Option<Self> {
        // Recent OpenSSH writes its banner comment to stdout alongside the key.
        // Accept exactly one key record; an extra record is not a first-use prompt.
        let mut rows = std::str::from_utf8(bytes)
            .ok()?
            .lines()
            .filter(|row| !row.is_empty() && !row.starts_with('#'));
        let row = rows.next()?;
        if rows.next().is_some() {
            return None;
        }
        Self::from_record(row.as_bytes(), host)
    }

    pub(super) fn from_record(bytes: &[u8], host: &str) -> Option<Self> {
        let record = std::str::from_utf8(bytes).ok()?;
        let record = record.strip_suffix('\n').unwrap_or(record);
        if record.contains(['\n', '\r']) {
            return None;
        }
        let (label, record) = record.split_once(' ')?;
        let (kind, encoded) = record.split_once(' ')?;
        if label != host || kind != TYPE || encoded.len() != 68 {
            return None;
        }
        let mut blob = Vec::with_capacity(51);
        // An Ed25519 SSH wire blob is exactly 51 bytes (no Base64 padding).
        for &[a, b, c, d] in encoded.as_bytes().as_chunks::<4>().0 {
            let (a, b, c, d) = (digit(a)?, digit(b)?, digit(c)?, digit(d)?);
            blob.extend([a << 2 | b >> 4, b << 4 | c >> 2, c << 6 | d]);
        }
        blob.starts_with(BLOB_PREFIX).then(|| Self {
            encoded: encoded.to_owned(),
            blob,
        })
    }

    pub(super) fn record(&self, host: &str) -> String {
        format!("{host} {TYPE} {}\n", self.encoded)
    }

    /// `<type> <base64>` without a comment or host label.
    pub(super) fn record_value(&self) -> String {
        format!("{TYPE} {}", self.encoded)
    }

    /// Lowercase `sha256:<hex>` over the decoded key blob, matching the peer
    /// grant's `coordinatorKeyFingerprint` form.
    pub(super) fn fingerprint_hex(&self) -> String {
        let digest = Sha256::digest(&self.blob);
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("sha256:{hex}")
    }

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
    pub(super) fn scan(&self, deadline: Instant) -> Result<HostKey, super::ErrorCode> {
        use super::{ErrorCode, process};
        // No user, identity, SSH options, or inherited environment reach keyscan.
        self.require_direct_route()?;
        let mut scanner = self.images.keyscan()?;
        scanner
            .args([self.family, "-T", "10", "-t", "ed25519", "-p"])
            .arg(self.config.port.to_string())
            .arg(&self.host);
        let output = process::run(scanner, deadline, 4096).map_err(|error| match error {
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            _ => ErrorCode::TransportLost,
        })?;
        if !output.status.success() || output.truncated {
            return Err(ErrorCode::TransportLost);
        }
        HostKey::from_keyscan(&output.stdout, &self.scan_label).ok_or(ErrorCode::TransportLost)
    }
}

#[cfg(test)]
mod tests {
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
