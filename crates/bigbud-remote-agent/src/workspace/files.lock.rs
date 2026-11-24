//! Unix parent-directory access and write serialization for workspace writes.
//!
//! Locking rule (shared by `write_file` and `create_file`, always taken in this order):
//!
//! 1. An exclusive `flock` on the parent directory itself. It excludes every writer of the
//!    directory, whatever relative path or nested workspace root named the file. Filesystems
//!    that cannot `flock` a read-only directory descriptor (Linux NFS emulates `flock` with
//!    POSIX locks and reports `EBADF`; CIFS and FUSE report `ENOLCK` or `EOPNOTSUPP`) skip it.
//! 2. Always: an exclusive `flock` on the sibling `.bigbud-lock-<sha256(relative path)>` file,
//!    the scheme earlier agents use. Taking it even when step 1 succeeded means a writer on a
//!    mount where step 1 is unsupported, or an older agent, still excludes this one.
//!
//! The lock file is never removed: an older agent or a step-2-only writer may be waiting on
//! its inode, and unlinking it would let a third writer lock a fresh file concurrently.
//! Both waits are non-blocking polls bounded by one shared deadline.

use std::ffi::{CStr, CString};
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path};
use std::time::{Duration, Instant};

use super::files::content_sha256;
use super::files_seams::{Fault, injected, lock_timeout};
use super::{WorkspaceError, WorkspaceRoot, map_io};

/// How long a write waits for its locks before failing with nothing written.
pub(super) const WRITE_LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_POLL_INTERVAL: Duration = Duration::from_millis(1);
const MAX_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Holds the write locks of one parent directory until dropped.
#[derive(Debug)]
pub(super) struct WriteLock {
    _directory: Option<File>,
    _path: File,
}

impl WorkspaceRoot {
    /// Opens an existing directory descriptor-relative from the workspace root without creating
    /// anything or following symlinks. Returns `Ok(None)` when any component is missing.
    pub(super) fn open_existing_directory(
        &self,
        relative_path: &Path,
    ) -> Result<Option<File>, WorkspaceError> {
        // `open_file("")` opens the root afresh rather than duplicating the shared descriptor.
        let mut directory = self.open_file("")?;
        for component in relative_path.components() {
            let Component::Normal(name) = component else {
                return Err(WorkspaceError::InvalidPath(
                    relative_path.display().to_string(),
                ));
            };
            let name = CString::new(name.as_bytes())
                .map_err(|_| WorkspaceError::InvalidPath(relative_path.display().to_string()))?;
            // SAFETY: The directory descriptor and C string remain valid for the call.
            let descriptor = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                )
            };
            if descriptor < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::NotFound {
                    return Ok(None);
                }
                if error.raw_os_error() == Some(libc::ELOOP)
                    || error.kind() == std::io::ErrorKind::NotADirectory
                {
                    return Err(WorkspaceError::SymlinkComponent);
                }
                return Err(map_io(error));
            }
            // SAFETY: openat returned a valid descriptor whose ownership is transferred once.
            directory = unsafe { File::from_raw_fd(descriptor) };
        }
        Ok(Some(directory))
    }
}

/// Takes the write locks for `relative_path` (already validated and normalized) whose parent
/// directory is `directory`. Fails with [`WorkspaceError::WriteLockTimeout`] after the deadline.
pub(super) fn lock_for_write(
    directory: &File,
    relative_path: &Path,
) -> Result<WriteLock, WorkspaceError> {
    // A deadline past the representable range is treated as already expired.
    let deadline = Instant::now()
        .checked_add(lock_timeout(WRITE_LOCK_TIMEOUT))
        .ok_or(WorkspaceError::WriteLockTimeout)?;
    // Reopen through "." so the lock lives on a fresh open file description: `flock` locks belong
    // to open file descriptions, so a duplicate (such as the shared workspace root descriptor)
    // would not exclude other writers in this process.
    let current: &CStr = c".";
    let reopened = open_lock_at(directory, current, libc::O_RDONLY | libc::O_DIRECTORY)?;
    let directory_lock = match flock_until(&reopened, deadline, Some(Fault::DirectoryLock)) {
        Ok(()) => Some(reopened),
        Err(LockFailure::Unsupported) => None,
        Err(LockFailure::TimedOut) => return Err(WorkspaceError::WriteLockTimeout),
        Err(LockFailure::Io(error)) => return Err(map_io(error)),
    };
    let name = CString::new(format!(
        ".bigbud-lock-{}",
        content_sha256(relative_path.as_os_str().as_bytes())
    ))
    .map_err(|_| WorkspaceError::InvalidPath(relative_path.display().to_string()))?;
    let path_lock = open_lock_at(
        directory,
        &name,
        libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_NONBLOCK,
    )?;
    match flock_until(&path_lock, deadline, None) {
        Ok(()) => Ok(WriteLock {
            _directory: directory_lock,
            _path: path_lock,
        }),
        Err(LockFailure::TimedOut) => Err(WorkspaceError::WriteLockTimeout),
        Err(LockFailure::Unsupported) => {
            Err(map_io(std::io::Error::from_raw_os_error(libc::EOPNOTSUPP)))
        }
        Err(LockFailure::Io(error)) => Err(map_io(error)),
    }
}

fn open_lock_at(directory: &File, name: &CStr, flags: libc::c_int) -> Result<File, WorkspaceError> {
    // SAFETY: The directory descriptor and C string remain valid for the call.
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC,
            0o600,
        )
    };
    if descriptor < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ELOOP) {
            return Err(WorkspaceError::SymlinkComponent);
        }
        return Err(map_io(error));
    }
    // SAFETY: openat returned a valid descriptor whose ownership is transferred exactly once.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

enum LockFailure {
    /// The filesystem cannot `flock` this descriptor.
    Unsupported,
    TimedOut,
    Io(std::io::Error),
}

fn is_unsupported(error: &std::io::Error) -> bool {
    error.raw_os_error().is_some_and(|code| {
        [libc::EBADF, libc::ENOLCK, libc::EOPNOTSUPP, libc::ENOTSUP].contains(&code)
    })
}

/// Polls `flock(LOCK_EX | LOCK_NB)` with growing sleeps until `deadline`, so a session handler
/// never blocks indefinitely behind another writer.
fn flock_until(lock: &File, deadline: Instant, fault: Option<Fault>) -> Result<(), LockFailure> {
    let mut interval = FIRST_POLL_INTERVAL;
    loop {
        let error = match fault.and_then(injected) {
            Some(error) => error,
            // SAFETY: The lock file owns a valid descriptor for the duration of flock.
            None if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }
                == 0 =>
            {
                return Ok(());
            }
            None => std::io::Error::last_os_error(),
        };
        if error.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if error.kind() != std::io::ErrorKind::WouldBlock {
            return Err(if is_unsupported(&error) {
                LockFailure::Unsupported
            } else {
                LockFailure::Io(error)
            });
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(LockFailure::TimedOut);
        }
        std::thread::sleep(interval.min(deadline.saturating_duration_since(now)));
        interval = interval.saturating_mul(2).min(MAX_POLL_INTERVAL);
    }
}
