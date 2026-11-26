//! U24 owner-held peer pairing authority (W2 T-peer, U9).
//!
//! The production owner is the only writer of peer pins. Inspection returns a
//! one-time challenge bound to the exact host, port and presented key; only an
//! approval of that challenge writes a pin, under the owner's private profile
//! state, together with the login user and the coordinator key fingerprint at
//! approval. A relay request names only the pairing id, so no RPC can supply a
//! host, key, user or identity to dial.

use super::{ErrorCode, Outcome, Owner};
use crate::{
    Token,
    transport::peer_production::{self, PresentedKey},
    v1::{self, request::Operation},
};
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const PIN_DIR: &str = "peer-pairings";
const PIN_LIMIT: u64 = 4 * 1024;
const CHALLENGE_TTL: Duration = Duration::from_secs(300);
const MAX_CHALLENGES: usize = 8;

struct Challenge {
    token: Token,
    host: String,
    port: u16,
    key: PresentedKey,
    issued: Instant,
}

/// Owner-wide peer state: outstanding inspection challenges and the relay
/// channels (see `owner/backend.peer.rs`).
#[derive(Default)]
pub(crate) struct PeerState {
    challenges: Vec<Challenge>,
    pub(super) relays: super::backend::PeerRelays,
}

/// One stored pairing pin.
pub(super) struct PinRecord {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) user: String,
    pub(super) key: PresentedKey,
    /// `sha256:<hex>` of the coordinator key bound at approval.
    pub(super) coordinator: String,
}

impl PinRecord {
    fn reply(&self, pairing_id: &str) -> Outcome {
        Outcome::PeerPin(v1::PeerPin {
            pairing_id: pairing_id.to_owned(),
            host: self.host.clone(),
            port: u32::from(self.port),
            user: self.user.clone(),
            host_key_fingerprint: self.key.fingerprint(),
            coordinator_key_fingerprint: self.coordinator.clone(),
        })
    }

    fn encode(&self) -> String {
        format!(
            "host={}\nport={}\nuser={}\nkey={}\ncoordinator={}\n",
            self.host,
            self.port,
            self.user,
            self.key.public_key(),
            self.coordinator
        )
    }

    fn decode(text: &str) -> Option<Self> {
        let mut fields = text.lines().map(|line| line.split_once('='));
        let mut next = |name: &str| match fields.next()? {
            Some((key, value)) if key == name => Some(value.to_owned()),
            _ => None,
        };
        let record = Self {
            host: next("host")?,
            port: next("port")?.parse().ok().filter(|port| *port != 0)?,
            user: next("user").filter(|user| valid_user(user))?,
            key: PresentedKey::parse(&next("key")?)?,
            coordinator: next("coordinator").filter(|value| value.starts_with("sha256:"))?,
        };
        fields.next().is_none().then_some(record)
    }
}

/// The production U24 enrollment verbs (pin store and inspection).
pub(super) fn enrollment_verb(operation: &Operation) -> bool {
    matches!(
        operation,
        Operation::EnsurePeerCoordinatorKey(_)
            | Operation::InspectPeerHostKey(_)
            | Operation::ApprovePeerPin(_)
            | Operation::RevokePeerPin(_)
    )
}

/// Every U24 verb: owner-wide, no target binding and no target storage.
pub(super) fn owner_wide_verb(operation: &Operation) -> bool {
    enrollment_verb(operation)
        || matches!(
            operation,
            Operation::PeerRelayOpen(_)
                | Operation::PeerRelayStatus(_)
                | Operation::PeerRelayClose(_)
        )
}

impl Owner {
    /// Production only: the pin store and the images come from owner startup.
    pub(super) fn peer_authority(&self) -> Result<(&super::TargetAuthority, &Path), ErrorCode> {
        match (&self.authority, &self.owner_state_dir) {
            (Some(authority), Some(state)) if self.production => Ok((authority, state)),
            _ => Err(ErrorCode::OperationDenied),
        }
    }

    pub(super) fn dispatch_peer_enrollment(
        &mut self,
        operation: Operation,
    ) -> Result<Outcome, ErrorCode> {
        let (authority, state) = self.peer_authority()?;
        let state = state.to_path_buf();
        match operation {
            Operation::EnsurePeerCoordinatorKey(_) => {
                let key = peer_production::coordinator_key(&state)?;
                Ok(Outcome::PeerCoordinatorKey(v1::PeerCoordinatorKey {
                    public_key: key.public_key,
                    fingerprint: key.fingerprint,
                    algorithm: key.algorithm.to_owned(),
                }))
            }
            Operation::InspectPeerHostKey(operand) => {
                let (ssh, keyscan) = authority.openssh();
                let key = peer_production::inspect(ssh, keyscan, &operand.host, operand.port)?;
                let port = u16::try_from(operand.port).map_err(|_| ErrorCode::InvalidOperands)?;
                let token = crate::random_token().map_err(|_| ErrorCode::OwnerUnavailable)?;
                let now = Instant::now();
                let challenges = &mut self.peer.challenges;
                challenges.retain(|challenge| now - challenge.issued < CHALLENGE_TTL);
                if challenges.len() >= MAX_CHALLENGES {
                    challenges.remove(0);
                }
                let reply = v1::PeerHostKey {
                    key_type: key.key_type().to_owned(),
                    fingerprint: key.fingerprint(),
                    public_key: key.public_key(),
                    challenge: token.to_vec(),
                };
                challenges.push(Challenge {
                    token,
                    host: operand.host,
                    port,
                    key,
                    issued: now,
                });
                Ok(Outcome::PeerHostKey(reply))
            }
            Operation::ApprovePeerPin(approval) => {
                if !valid_pairing_id(&approval.pairing_id) || !valid_user(&approval.user) {
                    return Err(ErrorCode::InvalidOperands);
                }
                // One-time: a presented challenge is consumed even when refused.
                let now = Instant::now();
                let index = self
                    .peer
                    .challenges
                    .iter()
                    .position(|challenge| challenge.token.as_slice() == approval.challenge)
                    .ok_or(ErrorCode::PeerPinUnknown)?;
                let challenge = self.peer.challenges.remove(index);
                if now - challenge.issued >= CHALLENGE_TTL {
                    return Err(ErrorCode::PeerPinUnknown);
                }
                let coordinator = peer_production::coordinator_key(&state)?;
                let record = PinRecord {
                    host: challenge.host,
                    port: challenge.port,
                    user: approval.user,
                    key: challenge.key,
                    coordinator: coordinator.fingerprint,
                };
                write_private(&pin_path(&state, &approval.pairing_id)?, &record.encode())?;
                Ok(record.reply(&approval.pairing_id))
            }
            Operation::RevokePeerPin(revoke) => {
                if !valid_pairing_id(&revoke.pairing_id) {
                    return Err(ErrorCode::InvalidOperands);
                }
                self.peer.relays.revoke_pairing(&revoke.pairing_id)?;
                let record =
                    read_pin(&state, &revoke.pairing_id)?.ok_or(ErrorCode::PeerPinUnknown)?;
                remove(&pin_path(&state, &revoke.pairing_id)?)?;
                remove(&known_hosts_path(&state, &revoke.pairing_id)?)?;
                Ok(record.reply(&revoke.pairing_id))
            }
            _ => Err(ErrorCode::OperationDenied),
        }
    }
}

/// A lowercase UUID v4, as the server's pairing ids are.
pub(super) fn valid_pairing_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => byte == b'4',
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

/// The pairing user pattern `^[a-z_][a-z0-9_.-]{0,31}$`.
fn valid_user(value: &str) -> bool {
    let bytes = value.as_bytes();
    let first = bytes.first().copied();
    bytes.len() <= 32
        && first.is_some_and(|byte| byte.is_ascii_lowercase() || byte == b'_')
        && bytes.iter().all(|&byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_.-".contains(&byte)
        })
}

fn private_dir(state: &Path) -> Result<PathBuf, ErrorCode> {
    let directory = state.join(PIN_DIR);
    match DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(ErrorCode::PeerKeyCorrupt),
    }
    // SAFETY: geteuid takes no arguments and observes only the current process.
    let uid = unsafe { libc::geteuid() };
    let meta = fs::symlink_metadata(&directory).map_err(|_| ErrorCode::PeerKeyCorrupt)?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Err(ErrorCode::PeerKeyCorrupt);
    }
    Ok(directory)
}

fn pin_path(state: &Path, pairing_id: &str) -> Result<PathBuf, ErrorCode> {
    Ok(private_dir(state)?.join(format!("{pairing_id}.pin")))
}

pub(super) fn known_hosts_path(state: &Path, pairing_id: &str) -> Result<PathBuf, ErrorCode> {
    Ok(private_dir(state)?.join(format!("{pairing_id}.known_hosts")))
}

pub(super) fn read_pin(state: &Path, pairing_id: &str) -> Result<Option<PinRecord>, ErrorCode> {
    let path = pin_path(state, pairing_id)?;
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
    {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ErrorCode::PeerKeyCorrupt),
        Ok(file) => file,
    };
    // SAFETY: geteuid takes no arguments and observes only the current process.
    let uid = unsafe { libc::geteuid() };
    let meta = file.metadata().map_err(|_| ErrorCode::PeerKeyCorrupt)?;
    if !meta.is_file() || meta.uid() != uid || meta.nlink() != 1 || meta.mode() & 0o077 != 0 {
        return Err(ErrorCode::PeerKeyCorrupt);
    }
    let mut text = String::new();
    file.take(PIN_LIMIT + 1)
        .read_to_string(&mut text)
        .map_err(|_| ErrorCode::PeerKeyCorrupt)?;
    if text.len() as u64 > PIN_LIMIT {
        return Err(ErrorCode::PeerKeyCorrupt);
    }
    PinRecord::decode(&text)
        .map(Some)
        .ok_or(ErrorCode::PeerKeyCorrupt)
}

/// Atomic owner-private replacement: a fresh 0600 file, then rename(2).
pub(super) fn write_private(path: &Path, contents: &str) -> Result<(), ErrorCode> {
    let mut staged = path.as_os_str().to_owned();
    staged.push(".tmp");
    let staged = PathBuf::from(staged);
    remove(&staged)?;
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&staged)
        .and_then(|mut file| {
            file.write_all(contents.as_bytes())?;
            file.sync_all()
        })
        .and_then(|()| fs::rename(&staged, path));
    if written.is_err() {
        // The staged file is ours; a failed cleanup leaves only a stale temp.
        let _cleanup = fs::remove_file(&staged);
        return Err(ErrorCode::PeerKeyCorrupt);
    }
    Ok(())
}

fn remove(path: &Path) -> Result<(), ErrorCode> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ErrorCode::PeerKeyCorrupt),
    }
}

#[cfg(test)]
#[path = "peer_store.tests.rs"]
mod tests;
