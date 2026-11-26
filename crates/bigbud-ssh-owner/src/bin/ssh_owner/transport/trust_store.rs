pub(super) mod extended;
mod hashed;

use super::{ErrorCode, HostKey};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

const READ_ONLY: ErrorCode = ErrorCode::TrustStoreReadOnly;
/// U23: one record of any accepted type, up to a 16384-bit RSA key.
const MAX_PIN_BYTES: u64 = 4096;
const MAX_STORE_BYTES: u64 = 64 * 1024;
static NEXT_SNAPSHOT: AtomicU64 = AtomicU64::new(0);

pub(super) fn check_directory(path: &Path) -> Result<&Path, ErrorCode> {
    let parent = path.parent().ok_or(READ_ONLY)?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| READ_ONLY)?;
    // SAFETY: geteuid takes no arguments and observes the current process only.
    let euid = unsafe { libc::geteuid() };
    if !metadata.is_dir() || metadata.mode() & 0o077 != 0 || metadata.uid() != euid {
        return Err(READ_ONLY);
    }
    Ok(parent)
}

pub(super) struct Pin {
    /// The most preferred pinned key.
    pub(super) key: HostKey,
    /// U23: pinned keys of other types for the same host (at most one per
    /// type), from the same trust sources. The snapshot record holds them all.
    others: Vec<HostKey>,
    record: String,
}

pub(super) fn read(path: &Path, label: &str) -> Result<Option<Pin>, ErrorCode> {
    read_with_hashing(path, label, true)
}

// The cancellable direct picker admits only plain pins: taking a trust
// snapshot must not launch a separate ssh-keygen matcher in this lane.
#[cfg(target_os = "macos")]
pub(super) fn read_plain(path: &Path, label: &str) -> Result<Option<Pin>, ErrorCode> {
    read_with_hashing(path, label, false)
}

fn read_with_hashing(
    path: &Path,
    label: &str,
    allow_hashing: bool,
) -> Result<Option<Pin>, ErrorCode> {
    let directory = check_directory(path)?;
    match options().open(path) {
        Ok(file) => {
            let hashed_deadline = allow_hashing.then(|| Instant::now() + hashed::LOOKUP_LIMIT);
            read_store(&file, label, hashed_deadline, directory).map(|store| store.pin)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(READ_ONLY),
    }
}

pub(super) fn approve(
    path: &Path,
    label: &str,
    key: &HostKey,
    hash_known_hosts: bool,
    deadline: Instant,
) -> Result<(), ErrorCode> {
    if Instant::now() >= deadline {
        return Err(ErrorCode::TransportLost);
    }
    let directory = check_directory(path)?;
    let mut file = options()
        .append(true)
        .create(true)
        .open(path)
        .map_err(|_| READ_ONLY)?;
    // SAFETY: the descriptor is live for the duration of the advisory lock;
    // LOCK_NB prevents another approval from blocking the operation.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == -1 {
        return Err(READ_ONLY);
    }
    let result = approve_locked(&mut file, directory, label, key, hash_known_hosts, deadline);
    // Unlock explicitly: a concurrent child spawn can briefly inherit this
    // open file description until exec, even though the fd is close-on-exec.
    // SAFETY: the descriptor is still live and owns the advisory lock above.
    let unlocked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) } == 0;
    result.and(if unlocked { Ok(()) } else { Err(READ_ONLY) })
}

fn approve_locked(
    file: &mut File,
    directory: &Path,
    label: &str,
    key: &HostKey,
    hash_known_hosts: bool,
    deadline: Instant,
) -> Result<(), ErrorCode> {
    let mut store = read_store(file, label, Some(deadline), directory)?;
    if let Some(pin) = &store.pin {
        return pin.check_key(key);
    }
    let mut record = if hash_known_hosts {
        let generated = hashed::create(directory, label, key, deadline)?;
        // The helper takes time; re-read from the start before appending so a
        // pin installed by a fixture writer without our lock is not masked.
        store = read_store(file, label, Some(deadline), directory)?;
        if let Some(pin) = &store.pin {
            return pin.check_key(key);
        }
        generated
    } else {
        key.record(label)
    };
    if record.len() as u64 > MAX_PIN_BYTES {
        return Err(READ_ONLY);
    }
    if store.needs_newline {
        record.insert(0, '\n');
    }
    if store.len + record.len() as u64 > MAX_STORE_BYTES {
        return Err(READ_ONLY);
    }
    if Instant::now() >= deadline {
        return Err(ErrorCode::TransportLost);
    }
    // Never truncate or replace. A partial key record fails closed.
    file.write_all(record.as_bytes()).map_err(|_| READ_ONLY)
}

fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    // In particular reject FIFO hangs and a symlink destination before reading/writing.
    options
        .read(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    options
}

#[path = "trust_store/pin.rs"]
mod pin;

fn read_private_bytes(mut file: &File, limit: u64) -> Result<Vec<u8>, ErrorCode> {
    let metadata = file.metadata().map_err(|_| READ_ONLY)?;
    // SAFETY: geteuid takes no arguments and observes the current process only.
    let euid = unsafe { libc::geteuid() };
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != euid
    {
        return Err(READ_ONLY);
    }
    file.rewind().map_err(|_| READ_ONLY)?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| READ_ONLY)?;
    Ok(bytes)
}

struct Store {
    pin: Option<Pin>,
    len: u64,
    needs_newline: bool,
}

fn read_store(
    file: &File,
    label: &str,
    hashed_deadline: Option<Instant>,
    directory: &Path,
) -> Result<Store, ErrorCode> {
    let bytes = read_private_bytes(file, MAX_STORE_BYTES)?;
    let len = bytes.len() as u64;
    if len > MAX_STORE_BYTES {
        return Err(ErrorCode::HostKeyChanged);
    }
    let pin = single_record(&bytes)?
        .map(|record| parse_pin(record, label, hashed_deadline, directory))
        .transpose()?;
    Ok(Store {
        pin,
        len,
        needs_newline: !bytes.is_empty() && !bytes.ends_with(b"\n"),
    })
}

fn single_record(bytes: &[u8]) -> Result<Option<&[u8]>, ErrorCode> {
    let mut record = None;
    for line in bytes.split_inclusive(|&byte| byte == b'\n') {
        // Reserve the terminator even at EOF so a later append cannot
        // push the now-terminated line over the same read limit.
        if line.len() as u64 + u64::from(!line.ends_with(b"\n")) > MAX_PIN_BYTES {
            return Err(ErrorCode::HostKeyChanged);
        }
        let row = match line.strip_suffix(b"\n") {
            Some(row) => row.strip_suffix(b"\r").unwrap_or(row),
            None => line,
        };
        if row
            .iter()
            .any(|&byte| byte.is_ascii_control() && byte != b'\t')
        {
            return Err(ErrorCode::HostKeyChanged);
        }
        match row.iter().find(|&&byte| !matches!(byte, b' ' | b'\t')) {
            None | Some(b'#') => continue,
            _ => {}
        }
        // Inspect the entire bounded file before accepting the only candidate.
        // Never skip a competing, marked, unrelated or malformed key record.
        if record.replace(row).is_some() {
            return Err(ErrorCode::HostKeyChanged);
        }
    }
    Ok(record)
}

fn parse_pin(
    bytes: &[u8],
    label: &str,
    hashed_deadline: Option<Instant>,
    directory: &Path,
) -> Result<Pin, ErrorCode> {
    if bytes.starts_with(b"|") {
        let deadline = hashed_deadline.ok_or(ErrorCode::ConfigUnsupported)?;
        return hashed::read(bytes, label, deadline, directory);
    }
    let key = HostKey::from_record(bytes, label).ok_or(ErrorCode::HostKeyChanged)?;
    Ok(Pin::single(key.record(label), key))
}

pub(super) struct Snapshot(PathBuf);

impl Snapshot {
    pub(super) fn new(path: &Path, pin: &Pin) -> Result<Self, ErrorCode> {
        let directory = check_directory(path)?;
        for _ in 0..16 {
            let nonce = NEXT_SNAPSHOT.fetch_add(1, Ordering::Relaxed);
            let path = directory.join(format!(".bigbud-picker-pin-{}-{nonce}", std::process::id()));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
            {
                Ok(mut file) => {
                    let snapshot = Self(path);
                    file.write_all(pin.record.as_bytes())
                        .map_err(|_| READ_ONLY)?;
                    return Ok(snapshot);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(READ_ONLY),
            }
        }
        Err(READ_ONLY)
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        // Scoped to the disposable fixture directory; bootstrap owns final cleanup.
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests;
