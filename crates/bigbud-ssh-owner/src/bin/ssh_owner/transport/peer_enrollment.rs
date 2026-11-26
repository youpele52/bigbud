//! Owner-executed peer enrollment (T-peer / U9). The coordinator identity is
//! provisioned and inspected inside the owner; no `ssh-keygen` or `ssh-keyscan`
//! launch exists in the TypeScript peer path.
//!
//! Authorization comes from the consumed verb grant, not from user SSH trust.
//! A host-key reply is metadata about the key the endpoint presented now: it is
//! not a saved pin, a credential or a relay authorization.

use super::{DEADLINE, ErrorCode, HostKey, Transport, host_key, peer, process};
use crate::v1;
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{self, Read},
    net::{Ipv4Addr, Ipv6Addr},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    time::Instant,
};

const KEY_FILE: &str = "peer_ed25519";
const KEY_DIR: &str = "peer-coordinator";
const KEYGEN_COMMENT: &str = "bigbud-peer";
const PUBLIC_LIMIT: usize = 4 * 1024;
const UNSUPPORTED: ErrorCode = ErrorCode::ConfigUnsupported;

impl Transport {
    /// Provision or reuse the dedicated coordinator key under the owner's own
    /// profile state. Only public metadata is returned. A corrupt, foreign or
    /// mismatched key refuses; it is never silently regenerated.
    pub(in super::super) fn ensure_peer_coordinator_key(
        &self,
        state_dir: &Path,
        profile_binding: &[u8],
    ) -> Result<v1::ProofPeerCoordinatorKey, ErrorCode> {
        let (key, _private) = ensure_coordinator(state_dir)?;
        Ok(v1::ProofPeerCoordinatorKey {
            public_key: key.record_value(),
            fingerprint: key.fingerprint_hex(),
            algorithm: host_key::TYPE.to_owned(),
            profile_binding: profile_binding.to_vec(),
        })
    }

    /// One-shot inspection of the exact host and port named by the request. The
    /// owner uses its validated OpenSSH keyscan image with fixed arguments and
    /// reads no trust store, identity, agent or user configuration.
    pub(in super::super) fn inspect_peer_host_key(
        &self,
        operand: &v1::ProofInspectPeerHostKey,
    ) -> Result<v1::ProofPeerHostKey, ErrorCode> {
        if self.config.alias_config.is_some()
            || self.config.system_config.is_some()
            || self.policy.is_some()
            || self.proof_agent.is_some()
            || self.config.dev_interactive_terminal
        {
            return Err(UNSUPPORTED);
        }
        self.require_direct_route()?;
        let key = scan_endpoint(self.images.keyscan()?, &operand.host, operand.port)?;
        Ok(v1::ProofPeerHostKey {
            key_type: host_key::TYPE.to_owned(),
            fingerprint: key.fingerprint(),
            public_key: key.record_value(),
        })
    }
}

/// Provision or reuse the dedicated coordinator key under the owner's own
/// profile state; returns its public half and the private key path. A corrupt,
/// foreign or mismatched key refuses; it is never silently regenerated.
pub(super) fn ensure_coordinator(state_dir: &Path) -> Result<(HostKey, PathBuf), ErrorCode> {
    let directory = private_state_dir(state_dir)?.join(KEY_DIR);
    match fs::symlink_metadata(&directory) {
        Ok(_) => private_directory(&directory)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            DirBuilder::new()
                .mode(0o700)
                .create(&directory)
                .map_err(|_| UNSUPPORTED)?;
            private_directory(&directory)?;
        }
        Err(_) => return Err(UNSUPPORTED),
    }
    let private = directory.join(KEY_FILE);
    let sidecar = directory.join(format!("{KEY_FILE}.pub"));
    let present = private_key(&private)?;
    let existing = read_public(&sidecar)?;
    let key = if present {
        // An existing key is authoritative. A missing or mismatched public
        // sidecar is a corrupt provision, not a reason to regenerate.
        let derived = derive_public(&private)?;
        match existing {
            Some(public) if public == derived => derived,
            _ => return Err(UNSUPPORTED),
        }
    } else {
        if existing.is_some() {
            return Err(UNSUPPORTED);
        }
        generate_keypair(&private)?;
        let derived = derive_public(&private)?;
        match read_public(&sidecar)? {
            Some(public) if public == derived => derived,
            _ => return Err(UNSUPPORTED),
        }
    };
    Ok((key, private))
}

/// One-shot scan of the exact host and port with a validated keyscan image and
/// fixed arguments; no trust store, identity, agent or user configuration.
pub(super) fn scan_endpoint(
    mut scanner: std::process::Command,
    host: &str,
    port: u32,
) -> Result<HostKey, ErrorCode> {
    let family = enrollment_host(host)?;
    if port == 0 || port > u32::from(u16::MAX) {
        return Err(ErrorCode::InvalidOperands);
    }
    if let Some(family) = family {
        scanner.arg(family);
    }
    scanner
        .args(["-T", "10", "-t", "ed25519", "-p"])
        .arg(port.to_string())
        .arg("--")
        .arg(host);
    let output = process::run(scanner, Instant::now() + DEADLINE, PUBLIC_LIMIT).map_err(
        |error| match error {
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            process::Failure::TimedOut | process::Failure::Io => ErrorCode::TransportLost,
        },
    )?;
    if !output.status.success() || output.truncated {
        return Err(ErrorCode::TransportLost);
    }
    HostKey::from_keyscan(&output.stdout, &scan_label(host, port)).ok_or(ErrorCode::TransportLost)
}

fn private_state_dir(state_dir: &Path) -> Result<PathBuf, ErrorCode> {
    if !state_dir.is_absolute()
        || state_dir
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        || state_dir.as_os_str().as_encoded_bytes().contains(&0)
    {
        return Err(UNSUPPORTED);
    }
    private_directory(state_dir)?;
    Ok(state_dir.to_path_buf())
}

fn private_directory(path: &Path) -> Result<(), ErrorCode> {
    // SAFETY: geteuid takes no arguments and observes only the current process.
    let uid = unsafe { libc::geteuid() };
    let meta = fs::symlink_metadata(path).map_err(|_| UNSUPPORTED)?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Err(UNSUPPORTED);
    }
    Ok(())
}

/// True only for a private, single-link regular file owned by this account.
fn private_key(path: &Path) -> Result<bool, ErrorCode> {
    // SAFETY: geteuid takes no arguments and observes only the current process.
    let uid = unsafe { libc::geteuid() };
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(UNSUPPORTED),
        Ok(meta) => {
            if meta.is_file() && meta.uid() == uid && meta.nlink() == 1 && meta.mode() & 0o077 == 0
            {
                Ok(true)
            } else {
                Err(UNSUPPORTED)
            }
        }
    }
}

fn read_public(path: &Path) -> Result<Option<HostKey>, ErrorCode> {
    // SAFETY: geteuid takes no arguments and observes only the current process.
    let uid = unsafe { libc::geteuid() };
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(UNSUPPORTED),
        Ok(file) => file,
    };
    let meta = file.metadata().map_err(|_| UNSUPPORTED)?;
    if !meta.is_file() || meta.uid() != uid || meta.nlink() != 1 || meta.mode() & 0o022 != 0 {
        return Err(UNSUPPORTED);
    }
    let mut bytes = Vec::new();
    file.take(PUBLIC_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNSUPPORTED)?;
    if bytes.len() > PUBLIC_LIMIT {
        return Err(UNSUPPORTED);
    }
    peer::public_key(&bytes).map(Some).ok_or(UNSUPPORTED)
}

fn generate_keypair(private: &Path) -> Result<(), ErrorCode> {
    let mut command = peer::keygen()?;
    // Fixed Ed25519 and an explicit empty passphrase: the owner never prompts.
    command
        .args(["-q", "-t", "ed25519", "-N", "", "-C", KEYGEN_COMMENT, "-f"])
        .arg(private);
    let output =
        process::run_with_combined_output_limit(command, Instant::now() + DEADLINE, PUBLIC_LIMIT)
            .map_err(|error| match error {
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            _ => UNSUPPORTED,
        })?;
    if !output.status.success() || output.truncated {
        return Err(UNSUPPORTED);
    }
    private_key(private)?.then_some(()).ok_or(UNSUPPORTED)
}

fn derive_public(private: &Path) -> Result<HostKey, ErrorCode> {
    let mut command = peer::keygen()?;
    // `-y` prints only the public half; `-P ""` and null stdin prohibit prompts.
    command.args(["-y", "-P", "", "-f"]).arg(private);
    let output =
        process::run_with_combined_output_limit(command, Instant::now() + DEADLINE, PUBLIC_LIMIT)
            .map_err(|error| match error {
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            _ => UNSUPPORTED,
        })?;
    if !output.status.success() || output.truncated {
        return Err(UNSUPPORTED);
    }
    peer::public_key(&output.stdout).ok_or(UNSUPPORTED)
}

/// An exact IP literal or DNS name with no user, port, option or credential
/// syntax. Returns the bounded address-family flag for a literal.
fn enrollment_host(host: &str) -> Result<Option<&'static str>, ErrorCode> {
    if host.is_empty()
        || host.len() > 253
        || host.starts_with('-')
        || host
            .bytes()
            .any(|byte| byte.is_ascii_control() || matches!(byte, b' ' | b'@' | b'/' | b'\\'))
    {
        return Err(ErrorCode::InvalidOperands);
    }
    if host.parse::<Ipv4Addr>().is_ok() {
        return Ok(Some("-4"));
    }
    if host.parse::<Ipv6Addr>().is_ok() {
        return Ok(Some("-6"));
    }
    if host.contains(':') {
        return Err(ErrorCode::InvalidOperands);
    }
    for label in host.split('.') {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(ErrorCode::InvalidOperands);
        }
    }
    Ok(None)
}

fn scan_label(host: &str, port: u32) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrollment_host_accepts_only_bare_hosts_and_literals() {
        assert_eq!(enrollment_host("127.0.0.1"), Ok(Some("-4")));
        assert_eq!(enrollment_host("::1"), Ok(Some("-6")));
        assert_eq!(enrollment_host("w1.example.test"), Ok(None));
        for host in [
            "",
            "-oProxyCommand=x",
            "user@w1.example.test",
            "w1.example.test:22",
            "w1 .example.test",
            "w1..example.test",
            "bad/../host",
            "w1.example.test\n",
        ] {
            assert_eq!(
                enrollment_host(host),
                Err(ErrorCode::InvalidOperands),
                "{host:?}"
            );
        }
    }

    #[test]
    fn scan_labels_match_openssh_keyscan_records() {
        assert_eq!(scan_label("w1.example.test", 22), "w1.example.test");
        assert_eq!(
            scan_label("w1.example.test", 2222),
            "[w1.example.test]:2222"
        );
        assert_eq!(scan_label("::1", 22), "::1");
    }
}
