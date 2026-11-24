//! Unix guarded and unguarded overwrites: atomic same-directory replacement by default, and
//! in-place rewrite for files a rename would change (see `files.inplace.rs`).

use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::files_inplace::write_in_place;
use super::files_lock::lock_for_write;
use super::files_seams::{Fault, after_sync, before_commit, injected};
use super::files_target::{
    TargetStat, fstat_file, hash_target_at, stat_target_at, verify_read_back, write_conflict,
};
use super::path::validate_relative_path;
use super::{WorkspaceError, WorkspaceRoot, map_io};

/// How [`replace_atomically`] ended without an error.
enum Replacement {
    Committed,
    /// The temporary file could not be given the target's group; nothing was replaced.
    GroupNotPreserved,
}

impl WorkspaceRoot {
    /// A guarded write (`expected_sha256` present) only edits an existing file: it never creates
    /// parent directories, and a missing parent or file is a conflict with no actual hash.
    pub(super) fn write_file_unix(
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
        let target_name = CString::new(file_name.as_bytes())
            .map_err(|_| WorkspaceError::InvalidPath(relative_path.to_owned()))?;
        let expected_sha256 = expected_sha256.filter(|value| !value.is_empty());
        let parent_directory = match expected_sha256 {
            Some(expected) => match self.open_existing_directory(parent)? {
                Some(directory) => directory,
                None => return Err(write_conflict(expected, None)),
            },
            None => self.open_or_create_directory(parent)?,
        };
        let _write_lock = lock_for_write(&parent_directory, &relative)?;

        let mut target = stat_target_at(&parent_directory, &target_name)?;
        if let Some(expected) = expected_sha256 {
            let Some((actual, verified)) = hash_target_at(&parent_directory, &target_name)? else {
                return Err(write_conflict(expected, None));
            };
            if actual != expected {
                return Err(write_conflict(expected, Some(actual)));
            }
            // Later identity checks refer to the file whose contents were verified.
            target = Some(verified);
        }
        let in_place = match target {
            Some(stat) if stat.requires_in_place() => Some(stat),
            Some(stat) => {
                let replaced = replace_atomically(
                    &parent_directory,
                    &target_name,
                    Some(&stat),
                    bytes,
                    expected_sha256,
                )?;
                match replaced {
                    Replacement::Committed => None,
                    Replacement::GroupNotPreserved => Some(stat),
                }
            }
            None => {
                replace_atomically(
                    &parent_directory,
                    &target_name,
                    None,
                    bytes,
                    expected_sha256,
                )?;
                None
            }
        };
        if let Some(stat) = in_place {
            write_in_place(
                &parent_directory,
                &target_name,
                &stat,
                bytes,
                expected_sha256,
            )?;
        }
        Ok(bytes.len() as u64)
    }
}

/// Exclusive `0600` temporary sibling, the target's group and permission bits, fsync, read-back,
/// guarded re-check, `renameat`, then a parent fsync. The temporary file is removed on every
/// failure and when the target's group cannot be preserved.
fn replace_atomically(
    parent: &File,
    target_name: &CStr,
    target: Option<&TargetStat>,
    bytes: &[u8],
    expected_sha256: Option<&str>,
) -> Result<Replacement, WorkspaceError> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| WorkspaceError::Io(std::io::Error::other(error)))?
        .as_nanos();
    let temporary_name = CString::new(format!(".bigbud-write-{}-{suffix}", std::process::id()))
        .map_err(|_| WorkspaceError::InvalidPath(target_name.to_string_lossy().into_owned()))?;
    // SAFETY: The directory descriptor and C string remain valid; O_EXCL creates a new file.
    let temporary_descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            temporary_name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
            0o600,
        )
    };
    if temporary_descriptor < 0 {
        return Err(map_io(std::io::Error::last_os_error()));
    }
    // SAFETY: openat returned a valid descriptor whose ownership is transferred exactly once.
    let mut temporary_file = unsafe { File::from_raw_fd(temporary_descriptor) };
    let staged = stage_temporary(&mut temporary_file, target, bytes);
    drop(temporary_file);
    let committed = staged.and_then(|preserved| {
        if !preserved {
            return Ok(Replacement::GroupNotPreserved);
        }
        recheck_before_commit(parent, target_name, expected_sha256)?;
        // SAFETY: Both names are valid C strings relative to the live parent descriptor.
        let renamed = unsafe {
            libc::renameat(
                parent.as_raw_fd(),
                temporary_name.as_ptr(),
                parent.as_raw_fd(),
                target_name.as_ptr(),
            )
        };
        if renamed < 0 {
            return Err(map_io(std::io::Error::last_os_error()));
        }
        Ok(Replacement::Committed)
    });
    if !matches!(committed, Ok(Replacement::Committed)) {
        // SAFETY: The directory descriptor and temporary filename remain valid.
        if unsafe { libc::unlinkat(parent.as_raw_fd(), temporary_name.as_ptr(), 0) } < 0 {
            return Err(map_io(std::io::Error::last_os_error()));
        }
        return committed;
    }
    parent.sync_all().map_err(map_io)?;
    committed
}

/// Writes and verifies the temporary file. Returns `Ok(false)` when it cannot be given the
/// target's group (`EPERM`), so the caller falls back to an in-place write.
fn stage_temporary(
    file: &mut File,
    target: Option<&TargetStat>,
    bytes: &[u8],
) -> Result<bool, WorkspaceError> {
    if let Some(target) = target
        && fstat_file(file)?.st_gid != target.group()
    {
        let refused = match injected(Fault::TemporaryChown) {
            Some(error) => Some(error),
            // SAFETY: The file owns a valid descriptor; uid -1 leaves the owner unchanged.
            None if unsafe { libc::fchown(file.as_raw_fd(), libc::uid_t::MAX, target.group()) }
                < 0 =>
            {
                Some(std::io::Error::last_os_error())
            }
            None => None,
        };
        if let Some(error) = refused {
            if error.raw_os_error() == Some(libc::EPERM) {
                return Ok(false);
            }
            return Err(map_io(error));
        }
    }
    file.write_all(bytes).map_err(map_io)?;
    if let Some(target) = target {
        // Apply permissions after writing and chown, which can clear set-user/group-ID bits.
        // SAFETY: The file owns a valid descriptor; mode has permission bits only.
        if unsafe { libc::fchmod(file.as_raw_fd(), target.mode) } < 0 {
            return Err(map_io(std::io::Error::last_os_error()));
        }
    }
    file.sync_all().map_err(map_io)?;
    after_sync(file);
    verify_read_back(file, bytes)?;
    Ok(true)
}

/// Narrows the check-to-rename window for guarded writes by hashing the target again
/// immediately before the rename (remote file editing plan, "What guarded replacement
/// guarantees").
fn recheck_before_commit(
    parent: &File,
    target_name: &CStr,
    expected_sha256: Option<&str>,
) -> Result<(), WorkspaceError> {
    before_commit();
    let Some(expected) = expected_sha256 else {
        return Ok(());
    };
    match hash_target_at(parent, target_name)? {
        Some((actual, _)) if actual == expected => Ok(()),
        Some((actual, _)) => Err(write_conflict(expected, Some(actual))),
        None => Err(write_conflict(expected, None)),
    }
}
