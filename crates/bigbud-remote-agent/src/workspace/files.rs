#[cfg(not(unix))]
use std::fs;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::ffi::CString;
#[cfg(not(unix))]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

use sha2::{Digest, Sha256};

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

    #[cfg(unix)]
    fn write_file_unix(
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
        let parent_directory = self.open_or_create_directory(parent)?;
        let target_name = CString::new(file_name.as_bytes())
            .map_err(|_| WorkspaceError::InvalidPath(relative_path.to_owned()))?;
        let _target_lock = lock_target_at(parent_directory.as_raw_fd(), relative_path)?;

        let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
        let metadata_result = unsafe {
            libc::fstatat(
                parent_directory.as_raw_fd(),
                target_name.as_ptr(),
                &mut metadata,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if metadata_result < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(map_io(error));
            }
        } else {
            let file_type = metadata.st_mode & libc::S_IFMT;
            if file_type == libc::S_IFLNK {
                return Err(WorkspaceError::SymlinkComponent);
            }
            if file_type != libc::S_IFREG {
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
        let temporary_name = CString::new(format!(".bigbud-write-{}-{suffix}", std::process::id()))
            .map_err(|_| WorkspaceError::InvalidPath(relative_path.to_owned()))?;
        let temporary_descriptor = unsafe {
            libc::openat(
                parent_directory.as_raw_fd(),
                temporary_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
                0o600,
            )
        };
        if temporary_descriptor < 0 {
            return Err(map_io(std::io::Error::last_os_error()));
        }
        let mut temporary_file = unsafe { File::from_raw_fd(temporary_descriptor) };
        if let Err(error) = temporary_file
            .write_all(bytes)
            .and_then(|_| temporary_file.sync_all())
        {
            unsafe {
                libc::unlinkat(parent_directory.as_raw_fd(), temporary_name.as_ptr(), 0);
            }
            return Err(WorkspaceError::Io(error));
        }
        drop(temporary_file);
        let rename_result = unsafe {
            libc::renameat(
                parent_directory.as_raw_fd(),
                temporary_name.as_ptr(),
                parent_directory.as_raw_fd(),
                target_name.as_ptr(),
            )
        };
        if rename_result < 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                libc::unlinkat(parent_directory.as_raw_fd(), temporary_name.as_ptr(), 0);
            }
            return Err(WorkspaceError::Io(error));
        }
        parent_directory.sync_all().map_err(map_io)?;
        Ok(bytes.len() as u64)
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

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn reader_sha256(reader: &mut impl Read) -> Result<String, WorkspaceError> {
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

#[cfg(unix)]
fn lock_target_at(
    parent_fd: std::os::unix::io::RawFd,
    relative_path: &str,
) -> Result<File, WorkspaceError> {
    let name = CString::new(format!(
        ".bigbud-lock-{}",
        hex_sha256(relative_path.as_bytes())
    ))
    .map_err(|_| WorkspaceError::InvalidPath(relative_path.to_owned()))?;
    let descriptor = unsafe {
        libc::openat(
            parent_fd,
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        return Err(map_io(std::io::Error::last_os_error()));
    }
    let lock = unsafe { File::from_raw_fd(descriptor) };
    let result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) };
    if result == -1 {
        return Err(map_io(std::io::Error::last_os_error()));
    }
    Ok(lock)
}

#[cfg(not(unix))]
fn lock_target(parent: &Path, target: &Path) -> Result<File, WorkspaceError> {
    let name = format!(
        ".bigbud-lock-{}",
        hex_sha256(target.to_string_lossy().as_bytes())
    );
    let lock_path = parent.join(name);
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(map_io)?;
    #[cfg(unix)]
    {
        let result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) };
        if result == -1 {
            return Err(map_io(std::io::Error::last_os_error()));
        }
    }
    Ok(lock)
}
