//! Dedicated paired-worker proof. Pairing authority comes from worker startup, never RPC.

use super::{DEADLINE, ErrorCode, HostKey, PinnedSsh, Transport, process, trust_store};
use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

#[cfg(test)]
#[path = "peer/tests.rs"]
mod tests;

const KEYGEN: &str = "/usr/bin/ssh-keygen";
/// The worker's fixed forced-command trigger.
pub(crate) const PEER_TRIGGER: &str = "bigbud-peer";
const PUBLIC_LIMIT: usize = 4096;
const UNSUPPORTED: ErrorCode = ErrorCode::ConfigUnsupported;
const AUTH: ErrorCode = ErrorCode::AuthRequired;
const CHANGED: ErrorCode = ErrorCode::HostKeyChanged;

impl Transport {
    /// Pass the same two trusted fingerprints on every call. Keep the returned
    /// pin snapshot alive through SSH authentication (or child exit). The
    /// command has no destination yet: the caller appends `-- host trigger`.
    pub(super) fn peer_ssh_base(
        &self,
        expected_host_fingerprint: &str,
        expected_coordinator_fingerprint: &str,
    ) -> Result<PinnedSsh, ErrorCode> {
        if self.config.alias_config.is_some()
            || self.config.system_config.is_some()
            || self.policy.is_some()
            || self.proof_agent.is_some()
            || self.config.dev_interactive_terminal
        {
            return Err(UNSUPPORTED);
        }
        check_pin_path(&self.config.known_hosts)?;
        let deadline = Instant::now() + DEADLINE;
        // The shared builder only checks identity metadata. Verify the exact
        // snapshot handed to OpenSSH, not a second read of the mutable store.
        let mut pinned = self.pinned_ssh("-T")?;
        let pin = trust_store::read(pinned._snapshot.path(), &self.scan_label)?.ok_or(CHANGED)?;
        if pin.key.fingerprint() != expected_host_fingerprint || self.scan(deadline)? != pin.key {
            return Err(CHANGED);
        }

        // Use exactly the path admitted by the shared builder (including its
        // normalization of trusted macOS path aliases).
        let args = pinned.command.get_args().collect::<Vec<_>>();
        let identity = PathBuf::from(sole_identity(&args).ok_or(UNSUPPORTED)?);
        // The scan may take time. Check the startup stamps immediately before
        // and again after any local credential reads. SSH reopens by path under
        // the same owner-private tree; root and the bootstrap account are trusted.
        let mut metadata_only = Command::new(&self.config.ssh);
        self.identities.apply_to(&mut metadata_only)?;
        verify_coordinator(&identity, expected_coordinator_fingerprint, deadline)?;
        self.identities.apply_to(&mut metadata_only)?;

        pinned
            .command
            .env_clear()
            .env("LC_ALL", "C")
            .args(["-o", "EscapeChar=none"]);
        Ok(pinned)
    }

    /// The dev paired-relay proof: the checked base plus the fixed trigger.
    pub(in super::super) fn pinned_peer_ssh(
        &self,
        expected_host_fingerprint: &str,
        expected_coordinator_fingerprint: &str,
    ) -> Result<PinnedSsh, ErrorCode> {
        let mut pinned =
            self.peer_ssh_base(expected_host_fingerprint, expected_coordinator_fingerprint)?;
        pinned.command.args(["--", &self.host, PEER_TRIGGER]);
        Ok(pinned)
    }
}

fn sole_identity<'a>(args: &[&'a std::ffi::OsStr]) -> Option<&'a std::ffi::OsStr> {
    let mut paths = args.windows(2).filter_map(|pair| match pair {
        [flag, path] if *flag == "-i" => Some(*path),
        _ => None,
    });
    let path = paths.next()?;
    paths.next().is_none().then_some(path)
}

fn check_pin_path(path: &Path) -> Result<(), ErrorCode> {
    // Unlike the regular picker, the worker's long-lived trust authority must
    // not depend on a snapshot directory beneath an untrusted writable ancestor.
    let relative = path.as_os_str().as_encoded_bytes().strip_prefix(b"/");
    if relative.is_none_or(|relative| {
        relative
            .split(|&byte| byte == b'/')
            .any(|part| part.is_empty() || matches!(part, b"." | b".."))
    }) {
        return Err(UNSUPPORTED);
    }
    // SAFETY: geteuid takes no arguments and observes only the current process.
    let uid = unsafe { libc::geteuid() };
    for ancestor in path.ancestors().skip(1) {
        #[cfg(target_os = "macos")]
        let real_path = ["/tmp", "/var"].into_iter().find_map(|alias| {
            ancestor.strip_prefix(alias).ok().map(|relative| {
                Path::new("/private")
                    .join(alias.trim_start_matches('/'))
                    .join(relative)
            })
        });
        #[cfg(target_os = "macos")]
        let ancestor = real_path.as_deref().unwrap_or(ancestor);
        let meta = fs::symlink_metadata(ancestor).map_err(|_| UNSUPPORTED)?;
        let root_sticky = meta.uid() == 0 && meta.mode() & 0o1000 != 0;
        if !meta.is_dir()
            || (meta.uid() != uid && meta.uid() != 0)
            || (meta.mode() & 0o022 != 0 && !root_sticky)
        {
            return Err(UNSUPPORTED);
        }
    }
    Ok(())
}

pub(super) fn keygen() -> Result<Command, ErrorCode> {
    let path = Path::new(KEYGEN);
    for ancestor in path.ancestors().skip(1) {
        let meta = fs::symlink_metadata(ancestor).map_err(|_| UNSUPPORTED)?;
        if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
            return Err(UNSUPPORTED);
        }
    }
    let meta = fs::symlink_metadata(path).map_err(|_| UNSUPPORTED)?;
    if !meta.is_file() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
        return Err(UNSUPPORTED);
    }
    Ok(Command::new(path))
}

fn verify_coordinator(identity: &Path, expected: &str, deadline: Instant) -> Result<(), ErrorCode> {
    let mut command = keygen()?;
    // This local helper reads only the admitted private key and emits its
    // public half. Explicit empty passphrase and null stdin prohibit prompts.
    // process clears the environment and bounds both output streams; neither
    // diagnostics, comments, key material nor paths escape these typed errors.
    command.args(["-y", "-P", "", "-f"]).arg(identity);
    let output = process::run_with_combined_output_limit(command, deadline, PUBLIC_LIMIT).map_err(
        |error| match error {
            process::Failure::Spawn => ErrorCode::OwnerUnavailable,
            process::Failure::TimedOut => ErrorCode::TransportLost,
            process::Failure::Io => AUTH,
        },
    )?;
    if !output.status.success() || output.truncated {
        return Err(AUTH);
    }
    let derived = public_key(&output.stdout).ok_or(AUTH)?;
    let fingerprint = derived.fingerprint();
    if expected != fingerprint && !matches_grant_fingerprint(expected, &fingerprint) {
        return Err(AUTH);
    }

    // OpenSSH may offer the implicit public sidecar before it loads the
    // private key. Do not permit an unrelated public identity to be offered.
    let mut sidecar = identity.as_os_str().to_owned();
    sidecar.push(".pub");
    match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(sidecar)
    {
        Ok(file) => {
            // SAFETY: geteuid takes no arguments and observes only the current process.
            let uid = unsafe { libc::geteuid() };
            let meta = file.metadata().map_err(|_| AUTH)?;
            if !meta.is_file() || meta.uid() != uid || meta.nlink() != 1 || meta.mode() & 0o022 != 0
            {
                return Err(AUTH);
            }
            let mut bytes = Vec::new();
            file.take(PUBLIC_LIMIT as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| AUTH)?;
            if bytes.len() > PUBLIC_LIMIT || public_key(&bytes).as_ref() != Some(&derived) {
                return Err(AUTH);
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(AUTH),
    }
    Ok(())
}

pub(super) fn public_key(bytes: &[u8]) -> Option<HostKey> {
    let row = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    if row.iter().any(|&byte| matches!(byte, b'\r' | b'\n' | 0)) {
        return None;
    }
    let mut fields = row
        .split(|&byte| matches!(byte, b' ' | b'\t'))
        .filter(|field| !field.is_empty());
    let kind = std::str::from_utf8(fields.next()?).ok()?;
    let encoded = std::str::from_utf8(fields.next()?).ok()?;
    // Reuse the existing strict Ed25519 wire-key parser. The artificial
    // label is local to validation; comments are not interpreted or logged.
    HostKey::from_record(
        format!("coordinator {kind} {encoded}").as_bytes(),
        "coordinator",
    )
}

fn matches_grant_fingerprint(expected: &str, openssh: &str) -> bool {
    let Some(hex) = expected
        .strip_prefix("sha256:")
        .filter(|hex| hex.len() == 64)
    else {
        return false;
    };
    let Some(base64) = openssh.strip_prefix("SHA256:") else {
        return false;
    };
    const BASE64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut base64 = base64.bytes();
    let mut carry = 0_u8;
    let mut bits = 0;
    for byte in hex.bytes() {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => return false,
        };
        carry = carry << 4 | digit;
        bits += 4;
        if bits >= 6 {
            bits -= 6;
            if BASE64.get(usize::from((carry >> bits) & 63)).copied() != base64.next() {
                return false;
            }
        }
    }
    BASE64.get(usize::from((carry << (6 - bits)) & 63)).copied() == base64.next()
        && base64.next().is_none()
}
