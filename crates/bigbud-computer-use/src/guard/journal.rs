use super::record::{MAX_RECORD_BYTES, SafetyRecord};
use std::io;
#[cfg(not(target_os = "macos"))]
use std::{
    fs::{self, File},
    io::Read,
};
#[cfg(target_os = "macos")]
mod macos;
#[cfg(all(test, target_os = "macos"))]
mod macos_tests;

mod codec;
#[cfg(test)]
mod tests;
#[cfg(not(any(windows, target_os = "macos")))]
use std::{
    fs::OpenOptions,
    io::Write,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
#[cfg(not(any(windows, target_os = "macos")))]
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub enum JournalError {
    Invalid,
    UnsupportedDurability,
    Io(io::Error),
}
impl From<io::Error> for JournalError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

/// File adapter for a previously verified private root held under ControllingLock.
/// Atomic replace+flush source is not evidence of per-OS full-flush qualification.
/// Windows replacement remains explicitly unavailable, never delete-then-rename.
pub struct Journal<'lock> {
    lock: &'lock super::ControllingLock,
}
impl<'lock> Journal<'lock> {
    pub(super) fn for_lock(lock: &'lock super::ControllingLock) -> Self {
        Self { lock }
    }
    #[cfg(not(target_os = "macos"))]
    pub fn read(&self) -> Result<Option<SafetyRecord>, JournalError> {
        let path = self.lock.directory.join("safety.v1");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(metadata) if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES as u64 => {
                return Err(JournalError::Invalid);
            }
            Ok(_) => {}
        }
        let mut bytes = Vec::new();
        File::open(path)?
            .take((MAX_RECORD_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        codec::decode(&bytes).map(Some)
    }
    #[cfg(not(target_os = "macos"))]
    pub fn replace(&self, record: &SafetyRecord) -> Result<(), JournalError> {
        let bytes = codec::encode(record)?;
        replace(&self.lock.directory, &bytes)
    }
}

#[cfg(windows)]
fn replace(_directory: &std::path::Path, _bytes: &[u8]) -> Result<(), JournalError> {
    Err(JournalError::UnsupportedDurability)
}
#[cfg(not(any(windows, target_os = "macos")))]
fn replace(directory: &Path, bytes: &[u8]) -> Result<(), JournalError> {
    // No existing temporary is touched. Overflow/collision is an error, not a
    // fallback to overwriting someone else's file.
    let sequence = TEMP_SEQUENCE
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .map_err(|_| JournalError::Invalid)?;
    let temporary = directory.join(format!("safety.v1.{}.{}.tmp", std::process::id(), sequence));
    let destination = directory.join("safety.v1");
    if let Ok(metadata) = fs::symlink_metadata(&destination)
        && !metadata.is_file()
    {
        return Err(JournalError::Invalid);
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| -> Result<(), JournalError> {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &destination)?;
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        match fs::remove_file(&temporary) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    result
}
