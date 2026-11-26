//! In-app credential state of one target transport (v1.credential.proto).
//!
//! A target needs a credential when its descriptor names password
//! authentication (POSIX owners only; U3 keeps Windows key-only) or when its
//! identity file is encrypted. The secret itself never reaches this module:
//! the owner's credential master consumes it once through the askpass helper.
//! What this module keeps is the control path of that verified master, so every
//! other lease of the target multiplexes over it, and the typed refusal for a
//! credential target without one.

use super::{ErrorCode, Transport};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// What a target needs before any SSH process may start for it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum CredentialMode {
    #[default]
    None,
    Password,
    KeyPassphrase,
}

impl CredentialMode {
    /// Key mode needs a passphrase exactly when its identity is encrypted.
    pub(crate) fn of_identity(identity: &Path) -> Self {
        if identity_is_encrypted(identity) {
            Self::KeyPassphrase
        } else {
            Self::None
        }
    }
}

/// The control path of the target's unlocked credential master. Shared by the
/// transport (readers) and the master (publish on ready, clear on reap).
#[derive(Clone, Default)]
pub(crate) struct MuxPath(Arc<Mutex<Option<PathBuf>>>);

impl MuxPath {
    pub(crate) fn publish(&self, path: PathBuf) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(path);
        }
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }

    pub(crate) fn get(&self) -> Option<PathBuf> {
        self.0.lock().ok().and_then(|slot| slot.clone())
    }
}

const MAX_KEY_BYTES: u64 = 64 * 1024;
const OPENSSH_BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_END: &str = "-----END OPENSSH PRIVATE KEY-----";
const OPENSSH_MAGIC: &[u8] = b"openssh-key-v1\0";

/// Whether the private key at `path` is passphrase-protected. Unreadable or
/// unrecognized files are treated as unencrypted: the key-mode handshake then
/// reports its own typed failure, and nothing is guessed from prompt text.
pub(crate) fn identity_is_encrypted(path: &Path) -> bool {
    let mut text = String::new();
    let Ok(file) = File::open(path) else {
        return false;
    };
    if file.take(MAX_KEY_BYTES).read_to_string(&mut text).is_err() {
        return false;
    }
    if text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----")
        || text.contains("Proc-Type: 4,ENCRYPTED")
    {
        return true;
    }
    let Some(body) = text
        .split_once(OPENSSH_BEGIN)
        .and_then(|(_, rest)| rest.split_once(OPENSSH_END))
        .map(|(body, _)| body)
    else {
        return false;
    };
    let Some(bytes) = decode_base64(body) else {
        return false;
    };
    // magic, then the length-prefixed cipher name.
    let Some(rest) = bytes.strip_prefix(OPENSSH_MAGIC) else {
        return false;
    };
    let Some((length, rest)) = rest.split_first_chunk::<4>() else {
        return false;
    };
    let length = u32::from_be_bytes(*length) as usize;
    rest.get(..length).is_some_and(|cipher| cipher != b"none")
}

fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

impl Transport {
    /// The descriptor named password authentication for this target.
    pub(crate) fn require_password_credential(&mut self) {
        self.credential = CredentialMode::Password;
    }

    pub(crate) fn credential_mode(&self) -> CredentialMode {
        self.credential
    }

    pub(crate) fn credential_mux(&self) -> &MuxPath {
        &self.mux
    }

    /// The identity a passphrase prompt names (`-i` argument order).
    pub(crate) fn credential_identity(&self) -> Option<&Path> {
        self.identities.first_path()
    }

    /// For a credential target, the unlocked master's control path; without
    /// one, a typed refusal before any SSH process starts. `None` for a
    /// key-only target, which keeps its own direct connection.
    pub(super) fn credential_route(&self) -> Result<Option<PathBuf>, ErrorCode> {
        match self.credential {
            CredentialMode::None => Ok(None),
            CredentialMode::Password | CredentialMode::KeyPassphrase => self
                .mux
                .get()
                .map(Some)
                .ok_or(ErrorCode::CredentialRequired),
        }
    }
}

#[cfg(test)]
#[path = "credential.tests.rs"]
mod tests;
