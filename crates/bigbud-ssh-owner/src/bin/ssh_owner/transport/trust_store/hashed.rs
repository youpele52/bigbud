use super::{
    ErrorCode, HostKey, MAX_PIN_BYTES, NEXT_SNAPSHOT, Pin, READ_ONLY, options, read_private_bytes,
};
use crate::transport::process;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

pub(super) const LOOKUP_LIMIT: Duration = Duration::from_secs(1);
const KEYGEN: &str = "/usr/bin/ssh-keygen";
const CHANGED: ErrorCode = ErrorCode::HostKeyChanged;

pub(super) fn create(
    directory: &Path,
    label: &str,
    key: &HostKey,
    deadline: Instant,
) -> Result<String, ErrorCode> {
    let deadline = deadline.min(Instant::now() + LOOKUP_LIMIT);
    let command = keygen()?;
    let staging = staging_directory(directory)?;
    let generated = hash_in_staging(command, &staging.join("pin"), label, key, deadline);
    // ssh-keygen -H saves the clear record as pin.old. Remove all staging
    // entries on success *or* error, and never copy back if removal fails.
    fs::remove_dir_all(staging).map_err(|_| READ_ONLY)?;
    let bytes = generated?;
    let pin = read(&bytes, label, deadline, directory).map_err(|error| match error {
        ErrorCode::TransportLost => error,
        _ => READ_ONLY,
    })?;
    if &pin.key != key {
        return Err(READ_ONLY);
    }
    Ok(pin.record)
}

fn staging_directory(directory: &Path) -> Result<PathBuf, ErrorCode> {
    for _ in 0..16 {
        let nonce = NEXT_SNAPSHOT.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(
            ".bigbud-picker-stage-{}-{nonce}",
            std::process::id()
        ));
        match fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(READ_ONLY),
        }
    }
    Err(READ_ONLY)
}

fn hash_in_staging(
    mut command: Command,
    path: &Path,
    label: &str,
    key: &HostKey,
    deadline: Instant,
) -> Result<Vec<u8>, ErrorCode> {
    options()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(key.record(label).as_bytes()))
        .map_err(|_| READ_ONLY)?;
    command.args(["-H", "-f"]).arg(path);
    let output =
        process::run_with_combined_output_limit(command, deadline, 4096).map_err(helper_failure)?;
    if !output.status.success() || output.truncated {
        return Err(READ_ONLY);
    }
    let file = options().open(path).map_err(|_| READ_ONLY)?;
    let bytes = read_private_bytes(&file, MAX_PIN_BYTES)?;
    if bytes.len() as u64 > MAX_PIN_BYTES {
        return Err(READ_ONLY);
    }
    Ok(bytes)
}

pub(super) fn read(
    bytes: &[u8],
    label: &str,
    deadline: Instant,
    directory: &Path,
) -> Result<Pin, ErrorCode> {
    let record = std::str::from_utf8(bytes).map_err(|_| CHANGED)?;
    let (field, _) = record.split_once(' ').ok_or(CHANGED)?;
    validate_field(field)?;
    // Validate the entire single, unmarked Ed25519 record before invoking the
    // matcher. In particular, never let OpenSSH select a row from a mixed file.
    let key = HostKey::from_record(bytes, field).ok_or(CHANGED)?;
    let record = key.record(field);
    if !match_record(&record, label, deadline, directory)? {
        return Err(CHANGED);
    }
    Ok(Pin { key, record })
}

pub(super) fn validate_field(field: &str) -> Result<(), ErrorCode> {
    let (salt, mac) = field
        .strip_prefix("|1|")
        .and_then(|fields| fields.split_once('|'))
        .ok_or(CHANGED)?;
    if !sha1_field(salt) || !sha1_field(mac) {
        return Err(CHANGED);
    }
    Ok(())
}

pub(super) fn matches_field(
    field: &str,
    label: &str,
    deadline: Instant,
    directory: &Path,
) -> Result<bool, ErrorCode> {
    validate_field(field)?;
    // Only the host field participates in HMAC matching. Do not hand untrusted key/marker data to the helper.
    let record = format!(
        "{field} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"
    );
    match_record(&record, label, deadline, directory)
}

fn match_record(
    record: &str,
    label: &str,
    deadline: Instant,
    directory: &Path,
) -> Result<bool, ErrorCode> {
    // Use system OpenSSH's HMAC-SHA1 matcher instead of adding a crypto
    // dependency. It only ever sees this one validated record, not ambient
    // known_hosts, and cannot connect to the host.
    //
    // `-F` takes a path, so the record is staged in the same private directory
    // that `create` uses. It must not be offered on `/dev/stdin`: that path
    // resolves through fdescfs on macOS, whose lookup intermittently fails with
    // EBADF for a child spawned while other threads spawn processes. A
    // transient platform failure must never become a trust-store refusal.
    let staging = staging_directory(directory)?;
    let path = staging.join("known_hosts");
    let staged = options()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut file| file.write_all(record.as_bytes()))
        .map_err(|_| READ_ONLY);
    let matched = staged.and_then(|()| {
        let mut command = keygen()?;
        command.args(["-q", "-F", label, "-f"]).arg(&path);
        let output = process::run(
            command,
            deadline.min(Instant::now() + LOOKUP_LIMIT),
            record.len(),
        )
        .map_err(helper_failure)?;
        match output.status.code() {
            Some(0)
                if !output.truncated
                    && output.stderr.is_empty()
                    && output.stdout == record.as_bytes() =>
            {
                Ok(true)
            }
            Some(1) if output.stdout.is_empty() && output.stderr.is_empty() => Ok(false),
            _ => Err(READ_ONLY),
        }
    });
    fs::remove_dir_all(staging).map_err(|_| READ_ONLY)?;
    matched
}

fn keygen() -> Result<Command, ErrorCode> {
    let metadata = fs::symlink_metadata(KEYGEN).map_err(|_| READ_ONLY)?;
    if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(READ_ONLY);
    }
    Ok(Command::new(KEYGEN))
}

fn helper_failure(error: process::Failure) -> ErrorCode {
    match error {
        process::Failure::TimedOut => ErrorCode::TransportLost,
        _ => READ_ONLY,
    }
}

// Both OpenSSH v1 fields are exactly 20 bytes, encoded in canonical padded
// Base64. The penultimate character has two unused (zero) bits.
fn sha1_field(field: &str) -> bool {
    let [prefix @ .., tail, b'='] = field.as_bytes() else {
        return false;
    };
    prefix.len() == 26
        && prefix
            .iter()
            .all(|&byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
        && b"AEIMQUYcgkosw048".contains(tail)
}
