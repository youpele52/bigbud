//! Unselected Windows picker proof: exact IPv4 loopback, Ed25519 public key only.

#[path = "transport/folders.rs"]
mod folders;
#[path = "transport/host_key.rs"]
mod host_key;
mod inbox;
mod process;
mod trust;

use super::v1::{ErrorCode, Folder, Folders};
use host_key::HostKey;
use inbox::Inbox;
use std::{
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use trust::{FixturePath, TrustFile};

const HOST: &str = "127.0.0.1";
const DEADLINE: Duration = Duration::from_secs(10);
const SCAN_LIMIT: usize = 4096;
const LIST_LIMIT: usize = 1024 * 1024;

pub(super) struct TransportConfig {
    pub host: IpAddr,
    pub port: u16,
    pub user: String,
    pub identity: PathBuf,
    pub known_hosts: PathBuf,
}

#[derive(Clone)]
pub(super) struct ObservedHostKey {
    pub verified: bool,
    pub fingerprint: String,
    pub key_type: String,
    raw: HostKey,
    scope: Arc<()>,
}

pub(super) struct WindowsTransport {
    inbox: Inbox,
    port: u16,
    user: String,
    identity: FixturePath,
    known_hosts: FixturePath,
    label: String,
    scope: Arc<()>,
}

impl WindowsTransport {
    pub(super) fn new(config: TransportConfig) -> Result<Self, ErrorCode> {
        if config.host != IpAddr::V4(Ipv4Addr::LOCALHOST)
            || config.port == 0
            || !valid_user(&config.user)
        {
            return Err(ErrorCode::ConfigUnsupported);
        }
        let identity = FixturePath::new(&config.identity)?;
        let known_hosts = FixturePath::new(&config.known_hosts)?;
        if identity.as_str().eq_ignore_ascii_case(known_hosts.as_str()) {
            return Err(ErrorCode::ConfigUnsupported);
        }
        let label = if config.port == 22 {
            HOST.to_owned()
        } else {
            format!("[{HOST}]:{}", config.port)
        };
        Ok(Self {
            inbox: Inbox::resolve()?,
            port: config.port,
            user: config.user,
            identity,
            known_hosts,
            label,
            scope: Arc::new(()),
        })
    }

    pub(super) fn inspect(&self) -> Result<ObservedHostKey, ErrorCode> {
        let deadline = Instant::now() + DEADLINE;
        let pinned = TrustFile::read(&self.known_hosts, &self.label)?;
        let raw = self.scan(deadline, ErrorCode::TransportLost)?;
        let verified = match pinned.key() {
            Some(key) if *key == raw => true,
            Some(_) => return Err(ErrorCode::HostKeyChanged),
            None => false,
        };
        Ok(ObservedHostKey {
            verified,
            fingerprint: raw.fingerprint(),
            key_type: host_key::TYPE.to_owned(),
            raw,
            scope: Arc::clone(&self.scope),
        })
    }

    pub(super) fn approve(&self, expected: &ObservedHostKey) -> Result<(), ErrorCode> {
        if !Arc::ptr_eq(&expected.scope, &self.scope)
            || expected.verified
            || expected.key_type != host_key::TYPE
            || expected.fingerprint != expected.raw.fingerprint()
        {
            return Err(ErrorCode::OperationDenied);
        }
        let deadline = Instant::now() + DEADLINE;
        let present = self.scan(deadline, ErrorCode::TransportLost)?;
        if present != expected.raw {
            return Err(ErrorCode::HostKeyChanged);
        }
        TrustFile::approve(&self.known_hosts, &self.label, &present, deadline)
    }

    pub(super) fn list_folders(&self, path: Option<&str>) -> Result<Folders, ErrorCode> {
        let deadline = Instant::now() + DEADLINE;
        let remote = folders::command(path)?;
        let pinned = TrustFile::read(&self.known_hosts, &self.label)?;
        let pin = pinned.key().ok_or(ErrorCode::TrustRequired)?;
        if *pin != self.scan(deadline, ErrorCode::ListTimedOut)? {
            return Err(ErrorCode::HostKeyChanged);
        }
        // The credential isn't even opened until we've matched the unauthenticated
        // probe to the approved key. Strict host checking against the *same*, held
        // file protects the separate SSH handshake if the endpoint changed again.
        let _identity = self.identity.open(false)?;
        let ssh = self.inbox.ssh(
            self.port,
            &self.user,
            &self.identity,
            &self.known_hosts,
            &remote,
        );
        let output =
            process::run(ssh, deadline, LIST_LIMIT, SCAN_LIMIT).map_err(|error| match error {
                process::Failure::TimedOut => ErrorCode::ListTimedOut,
                process::Failure::Spawn => ErrorCode::OwnerUnavailable,
                process::Failure::Io => ErrorCode::TransportLost,
            })?;
        match output.status.code() {
            Some(0) => folders::parse(&output.stdout.bytes, output.stdout.truncated),
            Some(3) => Err(ErrorCode::ListPathUnavailable),
            Some(255) => Err(ssh_failure(&output.stderr.bytes)),
            None => Err(ErrorCode::TransportLost),
            _ => Err(ErrorCode::ListFailed),
        }
    }

    fn scan(&self, deadline: Instant, on_timeout: ErrorCode) -> Result<HostKey, ErrorCode> {
        let scanner = self.inbox.keyscan(self.port);
        let output =
            process::run(scanner, deadline, SCAN_LIMIT, SCAN_LIMIT).map_err(
                |error| match error {
                    process::Failure::Spawn => ErrorCode::OwnerUnavailable,
                    process::Failure::TimedOut => on_timeout,
                    process::Failure::Io => ErrorCode::TransportLost,
                },
            )?;
        if !output.status.success() || output.stdout.truncated || output.stderr.truncated {
            return Err(ErrorCode::TransportLost);
        }
        HostKey::from_keyscan(&output.stdout.bytes, &self.label).ok_or(ErrorCode::TransportLost)
    }
}

fn valid_user(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 64
        && user
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && user
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn ssh_failure(stderr: &[u8]) -> ErrorCode {
    let stderr = String::from_utf8_lossy(stderr);
    if stderr.contains("administratively prohibited")
        || stderr.contains("MaxSessions")
        || stderr.contains("Too many sessions")
    {
        ErrorCode::SessionQuota
    } else if stderr.contains("Host key verification failed")
        || stderr.contains("no matching host key type found")
    {
        ErrorCode::HostKeyChanged
    } else if let Some(methods) = permitted_methods(&stderr) {
        if bigbud_ssh_owner::windows_password_gate::requires_unsupported_password(methods) {
            // Key-only Windows never collects a password or OTP.
            ErrorCode::WindowsPasswordUnsupported
        } else {
            ErrorCode::AuthRequired
        }
    } else if stderr.contains("Permission denied (") {
        ErrorCode::AuthRequired
    } else if stderr.contains("Bad configuration option") || stderr.contains("Unsupported option") {
        ErrorCode::ConfigUnsupported
    } else {
        ErrorCode::TransportLost
    }
}

/// Extract the authenticated method list from `Permission denied (...)`.
fn permitted_methods(stderr: &str) -> Option<&str> {
    let start = stderr.find("Permission denied (")? + "Permission denied (".len();
    let rest = stderr.get(start..)?;
    let end = rest.find(')')?;
    rest.get(..end)
}

#[cfg(test)]
mod tests;
