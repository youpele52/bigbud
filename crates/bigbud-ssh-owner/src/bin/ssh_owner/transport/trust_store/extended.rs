//! Ordered trust sources for the scoped config path. A matching unsupported
//! or revoked policy is a refusal, never permission to enroll a different key.
use super::super::host_key;
use super::{ErrorCode, HostKey, Pin, READ_ONLY, check_directory, hashed, options};
use crate::config::HostVerification;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, Write},
    os::fd::AsRawFd,
    os::unix::fs::MetadataExt,
    path::Path,
    time::Instant,
};

const MAX_SOURCE_BYTES: u64 = 64 * 1024;
const MAX_SOURCES: usize = 16;
const MAX_HOST_FIELD: usize = 1024;
const MAX_LINE: usize = 4096;
const MAX_HASHED_ROWS: usize = 32;
const CHANGED: ErrorCode = ErrorCode::HostKeyChanged;

pub(in super::super) struct Inspection {
    pub(in super::super) pin: Option<Pin>,
    pub(in super::super) stamp: [u8; 32],
}

pub(in super::super) fn read(
    paths: &[&Path],
    label: &str,
    deadline: Instant,
) -> Result<Inspection, ErrorCode> {
    inspect(paths, label, deadline, None, HostVerification::Ed25519Key)
}

pub(in super::super) fn read_certificate_authority(
    paths: &[&Path],
    label: &str,
    deadline: Instant,
) -> Result<Option<Pin>, ErrorCode> {
    inspect(
        paths,
        label,
        deadline,
        None,
        HostVerification::Ed25519Certificate,
    )
    .map(|inspection| inspection.pin)
}

fn inspect(
    paths: &[&Path],
    label: &str,
    deadline: Instant,
    first_file: Option<&File>,
    verification: HostVerification,
) -> Result<Inspection, ErrorCode> {
    let Some(first) = paths.first() else {
        return Err(ErrorCode::ConfigUnsupported);
    };
    if paths.len() > MAX_SOURCES {
        return Err(ErrorCode::ConfigUnsupported);
    }
    // The matcher stages its single validated record beside the first source,
    // which is the only file this path ever appends to.
    let directory = check_directory(first)?;
    let mut selection = Selection {
        label,
        pin: None,
        hashes: 0,
        deadline,
        verification,
        directory,
    };
    let mut digest = Sha256::new();
    for (index, path) in paths.iter().enumerate() {
        if Instant::now() >= deadline {
            return Err(ErrorCode::TransportLost);
        }
        check_directory(path)?;
        let file;
        let current = if index == 0
            && let Some(locked) = first_file
        {
            locked
        } else {
            file = options().open(path).map_err(|_| READ_ONLY)?;
            &file
        };
        let bytes = read_source(current, index == 0 && first_file.is_some())?;
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(&bytes);
        selection.scan(&bytes)?;
    }
    Ok(Inspection {
        pin: selection.pin,
        stamp: digest.finalize().into(),
    })
}

fn read_source(mut file: &File, writable: bool) -> Result<Vec<u8>, ErrorCode> {
    let metadata = file.metadata().map_err(|_| READ_ONLY)?;
    // SAFETY: observes only the current process credential.
    let euid = unsafe { libc::geteuid() };
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.mode() & 0o022 != 0
        || !(metadata.uid() == euid || (!writable && metadata.uid() == 0))
    {
        return Err(READ_ONLY);
    }
    file.rewind().map_err(|_| READ_ONLY)?;
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| READ_ONLY)?;
    let after = file.metadata().map_err(|_| READ_ONLY)?;
    let changed = |meta: &std::fs::Metadata| {
        (
            meta.ctime(),
            meta.ctime_nsec(),
            meta.mtime(),
            meta.mtime_nsec(),
        )
    };
    if bytes.len() as u64 > MAX_SOURCE_BYTES
        || bytes.len() as u64 != metadata.len()
        || changed(&metadata) != changed(&after)
    {
        return Err(CHANGED);
    }
    Ok(bytes)
}

pub(in super::super) fn approve(
    enrollment: &Path,
    paths: &[&Path],
    label: &str,
    key: &HostKey,
    stamp: [u8; 32],
    hash: bool,
    deadline: Instant,
) -> Result<(), ErrorCode> {
    if paths.first().copied() != Some(enrollment) {
        return Err(READ_ONLY);
    }
    let directory = check_directory(enrollment)?;
    let mut file = options()
        .append(true)
        .open(enrollment)
        .map_err(|_| READ_ONLY)?;
    // SAFETY: live private descriptor; nonblocking advisory lock.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == -1 {
        return Err(READ_ONLY);
    }
    let result = (|| {
        let record = if hash {
            hashed::create(directory, label, key, deadline)?
        } else {
            key.record(label)
        };
        let current = inspect(
            paths,
            label,
            deadline,
            Some(&file),
            HostVerification::Ed25519Key,
        )?;
        if current.stamp != stamp {
            return Err(CHANGED);
        }
        if let Some(pin) = current.pin {
            return pin.check_key(key);
        }
        let bytes = read_source(&file, true)?;
        let needs_newline = !bytes.is_empty() && !bytes.ends_with(b"\n");
        if bytes.len() as u64 + record.len() as u64 + u64::from(needs_newline) > MAX_SOURCE_BYTES {
            return Err(READ_ONLY);
        }
        if Instant::now() >= deadline {
            return Err(ErrorCode::TransportLost);
        }
        let record = if needs_newline {
            format!("\n{record}")
        } else {
            record
        };
        file.write_all(record.as_bytes()).map_err(|_| READ_ONLY)
    })();
    // SAFETY: the descriptor is still live and owns the advisory lock.
    let unlocked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) } == 0;
    result.and(if unlocked { Ok(()) } else { Err(READ_ONLY) })
}

struct Selection<'a> {
    label: &'a str,
    pin: Option<Pin>,
    hashes: usize,
    deadline: Instant,
    verification: HostVerification,
    directory: &'a Path,
}

impl Selection<'_> {
    fn scan(&mut self, bytes: &[u8]) -> Result<(), ErrorCode> {
        let text = std::str::from_utf8(bytes).map_err(|_| CHANGED)?;
        for line in text.lines() {
            if line.len() > MAX_LINE || line.bytes().any(|b| b.is_ascii_control() && b != b'\t') {
                return Err(CHANGED);
            }
            let line = line.trim_start_matches([' ', '\t']);
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut fields = line.split_ascii_whitespace();
            let first = fields.next().ok_or(CHANGED)?;
            let (marker, hosts) = if first.starts_with('@') {
                (Some(first), fields.next().ok_or(CHANGED)?)
            } else {
                (None, first)
            };
            if !self.matches(hosts)? {
                continue;
            }
            let ca = match (self.verification, marker) {
                (_, Some("@revoked")) => return Err(CHANGED),
                (HostVerification::Ed25519Key, None) => false,
                // The certificate slice intentionally admits exact host-key
                // aliases only. Matching wildcard/hash CA policy is refused.
                (HostVerification::Ed25519Certificate, Some("@cert-authority"))
                    if hosts.eq_ignore_ascii_case(self.label) =>
                {
                    true
                }
                _ => return Err(ErrorCode::ConfigUnsupported),
            };
            let kind = fields.next().ok_or(CHANGED)?;
            let key = fields.next().ok_or(CHANGED)?;
            if ca && kind != host_key::TYPE {
                return Err(ErrorCode::ConfigUnsupported);
            }
            // U23: like OpenSSH, a key type the owner does not accept (DSA,
            // security-key or unknown) is skipped rather than trusted.
            if !host_key::accepted_type(kind) {
                continue;
            }
            let snapshot_host = if hosts.starts_with('|') {
                hosts
            } else {
                self.label
            };
            let record = format!("{snapshot_host} {kind} {key}\n");
            let key = HostKey::from_record(record.as_bytes(), snapshot_host).ok_or(CHANGED)?;
            let record = if ca {
                format!("@cert-authority {record}")
            } else {
                record
            };
            match &mut self.pin {
                // A certificate authority stays a single exact key.
                Some(existing) if ca => existing.check_key(&key)?,
                Some(existing) => existing.add(key, &record)?,
                None => self.pin = Some(Pin::single(record, key)),
            }
        }
        Ok(())
    }

    fn matches(&mut self, hosts: &str) -> Result<bool, ErrorCode> {
        if hosts.starts_with('|') {
            self.hashes += 1;
            if self.hashes > MAX_HASHED_ROWS {
                return Err(ErrorCode::ConfigUnsupported);
            }
            return hashed::matches_field(hosts, self.label, self.deadline, self.directory);
        }
        pattern_list(hosts, self.label)
    }
}

fn pattern_list(patterns: &str, label: &str) -> Result<bool, ErrorCode> {
    if patterns.len() > MAX_HOST_FIELD {
        return Err(ErrorCode::ConfigUnsupported);
    }
    let mut positive = false;
    let mut negative = false;
    for pattern in patterns.split(',') {
        let (pattern, negate) = pattern
            .strip_prefix('!')
            .map_or((pattern, false), |value| (value, true));
        if pattern.is_empty()
            || !pattern
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"[]:._-?*".contains(&byte))
        {
            return Err(ErrorCode::ConfigUnsupported);
        }
        if wildcard(pattern.as_bytes(), label.as_bytes()) {
            if negate {
                negative = true;
            } else {
                positive = true;
            }
        }
    }
    Ok(positive && !negative)
}

fn wildcard(pattern: &[u8], label: &[u8]) -> bool {
    let (mut p, mut n) = (0, 0);
    let mut star = None;
    while let Some(&byte) = label.get(n) {
        match pattern.get(p) {
            Some(b'*') => {
                p += 1;
                star = Some((p, n));
            }
            Some(mark) if *mark == b'?' || mark.eq_ignore_ascii_case(&byte) => {
                p += 1;
                n += 1;
            }
            _ => {
                if let Some((resume, consumed)) = star {
                    p = resume;
                    n = consumed + 1;
                    star = Some((resume, n));
                } else {
                    return false;
                }
            }
        }
    }
    pattern
        .get(p..)
        .is_some_and(|tail| tail.iter().all(|byte| *byte == b'*'))
}

#[cfg(test)]
mod tests;
