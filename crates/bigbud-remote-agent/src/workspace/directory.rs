use std::ffi::OsStr;
#[cfg(not(unix))]
use std::fs;
use std::path::Path;

use super::path::validate_relative_path;
use super::{WorkspaceError, WorkspaceRoot, map_io};

pub const MAX_DIRECTORY_ENTRIES: usize = 10_000;

#[derive(Clone, Copy)]
enum SymlinkPolicy {
    Reject,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryEntry {
    pub path: String,
    pub is_directory: bool,
    pub is_file: bool,
    pub size_bytes: u64,
    pub modified_unix_ms: u64,
}

impl WorkspaceRoot {
    pub fn list_directory(
        &self,
        relative_path: &str,
    ) -> Result<Vec<DirectoryEntry>, WorkspaceError> {
        self.list_directory_with_symlink_policy(relative_path, SymlinkPolicy::Reject)
    }

    pub(super) fn list_directory_for_watch(
        &self,
        relative_path: &str,
    ) -> Result<Vec<DirectoryEntry>, WorkspaceError> {
        self.list_directory_with_symlink_policy(relative_path, SymlinkPolicy::Skip)
    }

    fn list_directory_with_symlink_policy(
        &self,
        relative_path: &str,
        symlink_policy: SymlinkPolicy,
    ) -> Result<Vec<DirectoryEntry>, WorkspaceError> {
        #[cfg(unix)]
        {
            list_directory_unix(self, relative_path, symlink_policy)
        }
        #[cfg(not(unix))]
        {
            list_directory_fallback(self, relative_path, symlink_policy)
        }
    }
}

#[cfg(unix)]
fn list_directory_unix(
    workspace: &WorkspaceRoot,
    relative_path: &str,
    symlink_policy: SymlinkPolicy,
) -> Result<Vec<DirectoryEntry>, WorkspaceError> {
    use std::ffi::{CStr, CString};
    use std::os::fd::IntoRawFd;
    use std::os::unix::ffi::OsStrExt;

    let parent = validate_relative_path(relative_path)?;
    let directory = workspace.open_file(relative_path)?;
    if !directory.metadata().map_err(map_io)?.is_dir() {
        return Err(WorkspaceError::NotDirectory);
    }
    let raw_directory = directory.into_raw_fd();
    let directory_stream = unsafe { libc::fdopendir(raw_directory) };
    if directory_stream.is_null() {
        unsafe { libc::close(raw_directory) };
        return Err(map_io(std::io::Error::last_os_error()));
    }
    let directory_fd = unsafe { libc::dirfd(directory_stream) };
    let mut entries = Vec::new();
    let mut visited_entries = 0;
    loop {
        let entry = unsafe { libc::readdir(directory_stream) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name == b"." || name == b".." {
            continue;
        }
        if visited_entries >= MAX_DIRECTORY_ENTRIES {
            unsafe { libc::closedir(directory_stream) };
            return Err(WorkspaceError::DirectoryLimitExceeded);
        }
        visited_entries += 1;
        let name_c = CString::new(name)
            .map_err(|_| WorkspaceError::InvalidPath("non-UTF-8 path".to_owned()))?;
        let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
        let result = unsafe {
            libc::fstatat(
                directory_fd,
                name_c.as_ptr(),
                &mut metadata,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result < 0 {
            unsafe { libc::closedir(directory_stream) };
            return Err(map_io(std::io::Error::last_os_error()));
        }
        let file_type = metadata.st_mode & libc::S_IFMT;
        if file_type == libc::S_IFLNK {
            match symlink_policy {
                SymlinkPolicy::Reject => {
                    unsafe { libc::closedir(directory_stream) };
                    return Err(WorkspaceError::SymlinkComponent);
                }
                SymlinkPolicy::Skip => continue,
            }
        }
        let path = relative_entry_path(&parent, OsStr::from_bytes(name))?;
        entries.push(DirectoryEntry {
            path,
            is_directory: file_type == libc::S_IFDIR,
            is_file: file_type == libc::S_IFREG,
            size_bytes: metadata.st_size as u64,
            modified_unix_ms: modified_unix_ms(&metadata),
        });
    }
    unsafe { libc::closedir(directory_stream) };
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

#[cfg(unix)]
fn modified_unix_ms(metadata: &libc::stat) -> u64 {
    let (seconds, nanos) = (metadata.st_mtime, metadata.st_mtime_nsec);
    if seconds < 0 {
        return 0;
    }
    (seconds as u64)
        .saturating_mul(1_000)
        .saturating_add((nanos as u64) / 1_000_000)
}

fn relative_entry_path(parent: &Path, name: &OsStr) -> Result<String, WorkspaceError> {
    let mut path = parent.to_path_buf();
    path.push(name);
    path.to_str()
        .map(|value| value.replace('\\', "/"))
        .ok_or_else(|| WorkspaceError::InvalidPath("non-UTF-8 path".to_owned()))
}

#[cfg(not(unix))]
fn list_directory_fallback(
    workspace: &WorkspaceRoot,
    relative_path: &str,
    symlink_policy: SymlinkPolicy,
) -> Result<Vec<DirectoryEntry>, WorkspaceError> {
    let path = workspace.resolve_existing(relative_path)?;
    if !fs::metadata(&path).map_err(map_io)?.is_dir() {
        return Err(WorkspaceError::NotDirectory);
    }
    let mut entries = Vec::new();
    let mut visited_entries = 0;
    for entry in fs::read_dir(path).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        if visited_entries >= MAX_DIRECTORY_ENTRIES {
            return Err(WorkspaceError::DirectoryLimitExceeded);
        }
        visited_entries += 1;
        if entry.file_type().map_err(map_io)?.is_symlink() {
            match symlink_policy {
                SymlinkPolicy::Reject => return Err(WorkspaceError::SymlinkComponent),
                SymlinkPolicy::Skip => continue,
            }
        }
        let metadata = entry.metadata().map_err(map_io)?;
        entries.push(DirectoryEntry {
            path: workspace.relative_path(&entry.path())?,
            is_directory: metadata.is_dir(),
            is_file: metadata.is_file(),
            size_bytes: metadata.len(),
            modified_unix_ms: super::metadata_modified_unix_ms(&metadata)?,
        });
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}
