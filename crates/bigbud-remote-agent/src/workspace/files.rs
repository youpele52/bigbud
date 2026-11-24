#[cfg(not(unix))]
use std::fs;
#[cfg(not(unix))]
use std::fs::{File, OpenOptions};
#[cfg(not(unix))]
use std::io::Write;
use std::io::{Read, Seek, SeekFrom};
#[cfg(not(unix))]
use std::path::Path;
#[cfg(not(unix))]
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

#[cfg(not(unix))]
use super::path::validate_relative_path;
use super::{MAX_TEXT_PREVIEW_BYTES, MAX_WRITE_BYTES};
use super::{WorkspaceError, WorkspaceRoot, map_io};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadFileResult {
    pub bytes: Vec<u8>,
    pub total_bytes: u64,
    pub truncated: bool,
}

impl WorkspaceRoot {
    pub fn read_file(
        &self,
        relative_path: &str,
        offset: u64,
        requested_bytes: usize,
    ) -> Result<ReadFileResult, WorkspaceError> {
        let mut file = self.open_file(relative_path)?;
        let metadata = file.metadata().map_err(map_io)?;
        if !metadata.is_file() {
            return Err(WorkspaceError::NotRegularFile);
        }
        let total_bytes = metadata.len();
        if offset >= total_bytes || requested_bytes == 0 {
            return Ok(ReadFileResult {
                bytes: Vec::new(),
                total_bytes,
                truncated: false,
            });
        }

        let limit = requested_bytes.min(MAX_TEXT_PREVIEW_BYTES);
        file.seek(SeekFrom::Start(offset)).map_err(map_io)?;
        let available = total_bytes - offset;
        let read_limit = available.min(limit as u64);
        let mut bytes = Vec::with_capacity(read_limit as usize);
        file.take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(map_io)?;
        Ok(ReadFileResult {
            truncated: available > limit as u64,
            bytes,
            total_bytes,
        })
    }

    pub fn write_file(
        &self,
        relative_path: &str,
        bytes: &[u8],
        expected_sha256: Option<&str>,
    ) -> Result<u64, WorkspaceError> {
        if bytes.len() > MAX_WRITE_BYTES {
            return Err(WorkspaceError::WriteLimitExceeded);
        }
        #[cfg(unix)]
        {
            self.write_file_unix(relative_path, bytes, expected_sha256)
        }
        #[cfg(not(unix))]
        {
            self.write_file_fallback(relative_path, bytes, expected_sha256)
        }
    }

    #[cfg(not(unix))]
    fn write_file_fallback(
        &self,
        relative_path: &str,
        bytes: &[u8],
        expected_sha256: Option<&str>,
    ) -> Result<u64, WorkspaceError> {
        let relative = validate_relative_path(relative_path)?;
        let Some(file_name) = relative.file_name() else {
            return Err(WorkspaceError::InvalidPath(relative_path.to_owned()));
        };
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let parent_path = self.resolve_or_create_directory(parent)?;
        let target = parent_path.join(file_name);
        let _target_lock = lock_target(&parent_path, &target)?;
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            if metadata.file_type().is_symlink() {
                return Err(WorkspaceError::SymlinkComponent);
            }
            if !metadata.file_type().is_file() {
                return Err(WorkspaceError::NotRegularFile);
            }
        }
        if let Some(expected) = expected_sha256.filter(|value| !value.is_empty()) {
            let actual = match self.open_file(relative_path) {
                Ok(mut current) => Some(reader_sha256(&mut current)?),
                Err(WorkspaceError::NotFound(_)) => None,
                Err(error) => return Err(error),
            };
            if actual.as_deref() != Some(expected) {
                return Err(WorkspaceError::WriteConflict {
                    expected: expected.to_owned(),
                    actual,
                });
            }
        }
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| WorkspaceError::Io(std::io::Error::other(error)))?
            .as_nanos();
        let temporary = parent_path.join(format!(".bigbud-write-{}-{suffix}", std::process::id()));
        let mut file = OpenOptions::new();
        file.write(true).create_new(true);
        let mut temporary_file = file.open(&temporary).map_err(map_io)?;
        if let Err(error) = temporary_file
            .write_all(bytes)
            .and_then(|_| temporary_file.sync_all())
        {
            let _ = fs::remove_file(&temporary);
            return Err(WorkspaceError::Io(error));
        }
        drop(temporary_file);
        if let Err(error) = fs::rename(&temporary, &target) {
            let _ = fs::remove_file(&temporary);
            return Err(WorkspaceError::Io(error));
        }
        Ok(bytes.len() as u64)
    }
}

/// Lowercase hex SHA-256 of `bytes`: the content version reported for workspace writes.
pub fn content_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[allow(clippy::indexing_slicing)]
pub(super) fn reader_sha256(reader: &mut impl Read) -> Result<String, WorkspaceError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(map_io)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(not(unix))]
pub(super) fn lock_target(parent: &Path, target: &Path) -> Result<File, WorkspaceError> {
    let name = format!(
        ".bigbud-lock-{}",
        content_sha256(target.to_string_lossy().as_bytes())
    );
    let lock_path = parent.join(name);
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(map_io)?;
    Ok(lock)
}
