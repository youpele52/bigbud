#[cfg(not(unix))]
use std::fs;
use std::fs::File;
#[cfg(not(unix))]
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;

#[cfg(not(unix))]
use super::files::lock_target;
#[cfg(unix)]
use super::files::lock_target_at;
use super::path::validate_relative_path;
use super::{MAX_WRITE_BYTES, WorkspaceError, WorkspaceRoot, map_io};

fn map_create_error(error: std::io::Error) -> WorkspaceError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        WorkspaceError::AlreadyExists
    } else {
        map_io(error)
    }
}

impl WorkspaceRoot {
    /// Exclusive create (`O_CREAT | O_EXCL`), parents included. An existing entry, a symlink
    /// included, is never followed or replaced and fails with [`WorkspaceError::AlreadyExists`].
    pub fn create_file(&self, relative_path: &str, bytes: &[u8]) -> Result<u64, WorkspaceError> {
        if bytes.len() > MAX_WRITE_BYTES {
            return Err(WorkspaceError::WriteLimitExceeded);
        }
        let relative = validate_relative_path(relative_path)?;
        let Some(file_name) = relative.file_name() else {
            return Err(WorkspaceError::InvalidPath(relative_path.to_owned()));
        };
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        #[cfg(unix)]
        {
            self.create_file_unix(relative_path, parent, file_name, bytes)
        }
        #[cfg(not(unix))]
        {
            self.create_file_fallback(parent, file_name, bytes)
        }
    }

    #[cfg(unix)]
    fn create_file_unix(
        &self,
        relative_path: &str,
        parent: &Path,
        file_name: &std::ffi::OsStr,
        bytes: &[u8],
    ) -> Result<u64, WorkspaceError> {
        let parent_directory = self.open_or_create_directory(parent)?;
        let target_name = CString::new(file_name.as_bytes())
            .map_err(|_| WorkspaceError::InvalidPath(relative_path.to_owned()))?;
        let _target_lock = lock_target_at(parent_directory.as_raw_fd(), relative_path)?;
        // SAFETY: The directory descriptor and C string remain valid; O_EXCL never follows or
        // replaces an existing entry, including a dangling symlink.
        let descriptor = unsafe {
            libc::openat(
                parent_directory.as_raw_fd(),
                target_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if descriptor < 0 {
            return Err(map_create_error(std::io::Error::last_os_error()));
        }
        // SAFETY: openat returned a valid descriptor whose ownership is transferred exactly once.
        let mut file = unsafe { File::from_raw_fd(descriptor) };
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            // The file is ours: remove the partial create so a retry can succeed.
            // SAFETY: The directory descriptor and target filename remain valid.
            if unsafe { libc::unlinkat(parent_directory.as_raw_fd(), target_name.as_ptr(), 0) } < 0
            {
                return Err(map_io(std::io::Error::last_os_error()));
            }
            return Err(WorkspaceError::Io(error));
        }
        drop(file);
        parent_directory.sync_all().map_err(map_io)?;
        Ok(bytes.len() as u64)
    }

    #[cfg(not(unix))]
    fn create_file_fallback(
        &self,
        parent: &Path,
        file_name: &std::ffi::OsStr,
        bytes: &[u8],
    ) -> Result<u64, WorkspaceError> {
        let parent_path = self.resolve_or_create_directory(parent)?;
        let target = parent_path.join(file_name);
        let _target_lock = lock_target(&parent_path, &target)?;
        let mut file: File = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(map_create_error)?;
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&target);
            return Err(WorkspaceError::Io(error));
        }
        Ok(bytes.len() as u64)
    }
}
