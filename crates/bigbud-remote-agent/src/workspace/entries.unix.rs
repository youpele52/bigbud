//! Unix descriptor-relative create-folder and delete. Every component is opened with
//! `O_NOFOLLOW`, entries are inspected with `fstatat(AT_SYMLINK_NOFOLLOW)`, and removal uses
//! `unlinkat` relative to a held parent descriptor, so a symlink is never traversed.

use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use super::entries::{EntryKind, MAX_DELETE_DEPTH, MAX_DELETE_ENTRIES};
use super::{WorkspaceError, WorkspaceRoot, map_io};

fn last_error() -> std::io::Error {
    std::io::Error::last_os_error()
}

fn entry_name(name: &OsStr) -> Result<CString, WorkspaceError> {
    CString::new(name.as_bytes()).map_err(|_| WorkspaceError::InvalidPath("NUL in name".to_owned()))
}

/// `fstatat` without following symlinks; `Ok(None)` when the entry does not exist.
fn stat_at(directory: RawFd, name: &CStr) -> Result<Option<libc::stat>, WorkspaceError> {
    // SAFETY: libc::stat is a C data structure for which all-zero bytes are valid.
    let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
    // SAFETY: The descriptor is live, the name is NUL-terminated and the buffer is writable.
    let result = unsafe {
        libc::fstatat(
            directory,
            name.as_ptr(),
            &mut metadata,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result < 0 {
        let error = last_error();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(map_io(error));
    }
    Ok(Some(metadata))
}

fn kind_of(metadata: &libc::stat) -> EntryKind {
    match metadata.st_mode & libc::S_IFMT {
        libc::S_IFLNK => EntryKind::Symlink,
        libc::S_IFDIR => EntryKind::Directory,
        _ => EntryKind::File,
    }
}

/// Opens a real child directory; a symlink swapped in after `stat_at` fails instead of opening.
fn open_directory_at(directory: RawFd, name: &CStr) -> Result<OwnedFd, WorkspaceError> {
    // SAFETY: The descriptor is live and O_NOFOLLOW refuses a symlink in the final component.
    let descriptor = unsafe {
        libc::openat(
            directory,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        let error = last_error();
        return Err(if error.raw_os_error() == Some(libc::ELOOP) {
            WorkspaceError::SymlinkComponent
        } else {
            map_io(error)
        });
    }
    // SAFETY: openat returned a new descriptor whose ownership is transferred exactly once.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

/// The names in a directory, excluding `.` and `..`, refusing more than `remaining`.
fn read_names(directory: RawFd, remaining: usize) -> Result<Vec<CString>, WorkspaceError> {
    // SAFETY: dup creates a descriptor that fdopendir consumes, leaving the caller's intact.
    let duplicate = unsafe { libc::dup(directory) };
    if duplicate < 0 {
        return Err(map_io(last_error()));
    }
    // SAFETY: duplicate is a live directory descriptor; ownership transfers to the DIR stream.
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        let error = last_error();
        // SAFETY: fdopendir failed, so the duplicate is still ours to close exactly once.
        unsafe { libc::close(duplicate) };
        return Err(map_io(error));
    }
    // A dup shares the read offset with `directory`, which an earlier pass may have consumed.
    // SAFETY: stream is a valid DIR stream returned by fdopendir above.
    unsafe { libc::rewinddir(stream) };
    let mut names = Vec::new();
    let mut result = Ok(());
    loop {
        // SAFETY: stream remains valid until closedir below.
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        // SAFETY: d_name is NUL-terminated for the lifetime of this directory entry.
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        if names.len() >= remaining {
            result = Err(WorkspaceError::DeleteLimitExceeded);
            break;
        }
        names.push(name.to_owned());
    }
    // SAFETY: fdopendir returned this stream and closedir consumes it exactly once.
    if unsafe { libc::closedir(stream) } != 0 && result.is_ok() {
        return Err(map_io(last_error()));
    }
    result.map(|()| names)
}

struct DeleteBudget {
    device: libc::dev_t,
    entries: usize,
}

impl DeleteBudget {
    fn visit(&mut self, depth: usize) -> Result<(), WorkspaceError> {
        self.entries += 1;
        if depth > MAX_DELETE_DEPTH || self.entries > MAX_DELETE_ENTRIES {
            return Err(WorkspaceError::DeleteLimitExceeded);
        }
        Ok(())
    }

    fn remaining(&self) -> usize {
        MAX_DELETE_ENTRIES.saturating_sub(self.entries)
    }
}

/// Walks a real directory tree without removing anything, enforcing every bound first.
fn count_tree(
    directory: RawFd,
    depth: usize,
    budget: &mut DeleteBudget,
) -> Result<(), WorkspaceError> {
    for name in read_names(directory, budget.remaining())? {
        budget.visit(depth)?;
        let Some(metadata) = stat_at(directory, &name)? else {
            continue;
        };
        if kind_of(&metadata) == EntryKind::Directory {
            if metadata.st_dev != budget.device {
                return Err(WorkspaceError::DeleteCrossesMount);
            }
            let child = open_directory_at(directory, &name)?;
            count_tree(child.as_raw_fd(), depth + 1, budget)?;
        }
    }
    Ok(())
}

fn unlink_at(directory: RawFd, name: &CStr, flags: libc::c_int) -> Result<(), WorkspaceError> {
    // SAFETY: The descriptor is live and the name is relative to it; unlinkat never follows links.
    if unsafe { libc::unlinkat(directory, name.as_ptr(), flags) } < 0 {
        let error = last_error();
        // Already gone (removed concurrently): the goal is reached.
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(map_io(error));
        }
    }
    Ok(())
}

/// Removes the contents of a real directory; symlinks inside are unlinked, never entered.
fn remove_tree(
    directory: RawFd,
    depth: usize,
    budget: &mut DeleteBudget,
) -> Result<(), WorkspaceError> {
    for name in read_names(directory, budget.remaining())? {
        budget.visit(depth)?;
        let Some(metadata) = stat_at(directory, &name)? else {
            continue;
        };
        if kind_of(&metadata) == EntryKind::Directory {
            if metadata.st_dev != budget.device {
                return Err(WorkspaceError::DeleteCrossesMount);
            }
            let child = open_directory_at(directory, &name)?;
            remove_tree(child.as_raw_fd(), depth + 1, budget)?;
            drop(child);
            unlink_at(directory, &name, libc::AT_REMOVEDIR)?;
        } else {
            unlink_at(directory, &name, 0)?;
        }
    }
    Ok(())
}

impl WorkspaceRoot {
    /// The existing parent folder (shared walk: `O_DIRECTORY | O_NOFOLLOW` at every component).
    fn open_parent_directory(&self, parent: &Path) -> Result<File, WorkspaceError> {
        self.open_existing_directory(parent)?
            .ok_or_else(|| WorkspaceError::NotFound(parent.display().to_string()))
    }

    pub(super) fn create_directory_unix(
        &self,
        parent: &Path,
        name: &OsStr,
    ) -> Result<(), WorkspaceError> {
        let parent_directory = self.open_parent_directory(parent)?;
        let name = entry_name(name)?;
        // SAFETY: The parent descriptor is live and the name is a single relative component;
        // mkdirat never follows or replaces an existing entry (EEXIST), a symlink included.
        if unsafe { libc::mkdirat(parent_directory.as_raw_fd(), name.as_ptr(), 0o777) } < 0 {
            let error = last_error();
            return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
                WorkspaceError::AlreadyExists
            } else {
                map_io(error)
            });
        }
        parent_directory.sync_all().map_err(map_io)
    }

    pub(super) fn delete_entry_unix(
        &self,
        parent: &Path,
        name: &OsStr,
        expected: EntryKind,
    ) -> Result<EntryKind, WorkspaceError> {
        let parent_directory = self.open_parent_directory(parent)?;
        let parent_fd = parent_directory.as_raw_fd();
        let name = entry_name(name)?;
        let Some(metadata) = stat_at(parent_fd, &name)? else {
            return Err(WorkspaceError::NotFound(
                name.to_string_lossy().into_owned(),
            ));
        };
        let kind = kind_of(&metadata);
        kind.check_expected(expected)?;
        if kind != EntryKind::Directory {
            unlink_at(parent_fd, &name, 0)?;
            parent_directory.sync_all().map_err(map_io)?;
            return Ok(kind);
        }
        let directory = open_directory_at(parent_fd, &name)?;
        let mut count = DeleteBudget {
            device: metadata.st_dev,
            entries: 0,
        };
        // Nothing is removed until the whole tree is known to be within the bounds.
        count_tree(directory.as_raw_fd(), 1, &mut count)?;
        let mut removal = DeleteBudget {
            device: metadata.st_dev,
            entries: 0,
        };
        remove_tree(directory.as_raw_fd(), 1, &mut removal)
            .and_then(|()| {
                drop(directory);
                unlink_at(parent_fd, &name, libc::AT_REMOVEDIR)
            })
            .map_err(|error| WorkspaceError::UnknownOutcome(Box::new(error)))?;
        parent_directory.sync_all().map_err(map_io)?;
        Ok(kind)
    }
}
