//! Files panel create-folder and delete (`workspace.mkdir` and `workspace.delete` 1.0).
//!
//! Both operate on one named entry inside an existing parent directory. The workspace root is
//! never created or deleted, symlinks are never followed (a symlink is removed as a link), and a
//! recursive delete is bounded by a count pass that runs before anything is removed.

use std::ffi::OsString;
use std::path::PathBuf;

use super::path::validate_relative_path;
use super::{WorkspaceError, WorkspaceRoot};

/// Most entries (files, links and folders) one recursive delete may remove.
pub const MAX_DELETE_ENTRIES: usize = 100_000;
/// Deepest folder nesting one recursive delete may enter.
pub const MAX_DELETE_DEPTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
            Self::Symlink => "symlink",
        }
    }

    /// The kind a client confirmed: only `file` and `directory` are accepted.
    pub fn parse_expected(value: &str) -> Result<Self, WorkspaceError> {
        match value {
            "file" => Ok(Self::File),
            "directory" => Ok(Self::Directory),
            other => Err(WorkspaceError::InvalidPath(format!(
                "unsupported expected kind {other:?}"
            ))),
        }
    }

    /// A real entry must match the confirmed kind; a symlink is always removable as a link.
    pub(super) fn check_expected(self, expected: Self) -> Result<(), WorkspaceError> {
        match (self, expected) {
            (Self::Symlink, _) => Ok(()),
            (actual, expected) if actual == expected => Ok(()),
            _ => Err(WorkspaceError::KindMismatch),
        }
    }
}

/// Splits a workspace-relative path into its parent folder and final name. The root (an empty
/// or `.`-only path) has no name and is refused.
pub(super) fn split_entry(relative_path: &str) -> Result<(PathBuf, OsString), WorkspaceError> {
    let relative = validate_relative_path(relative_path)?;
    let Some(name) = relative.file_name() else {
        return Err(WorkspaceError::RootEntry);
    };
    let name = name.to_owned();
    let parent = match relative.parent() {
        Some(parent) => parent.to_path_buf(),
        None => PathBuf::new(),
    };
    Ok((parent, name))
}

#[cfg(not(unix))]
fn parent_str(parent: &std::path::Path) -> Result<&str, WorkspaceError> {
    parent
        .to_str()
        .ok_or_else(|| WorkspaceError::InvalidPath("non-UTF-8 path".to_owned()))
}

impl WorkspaceRoot {
    /// Creates one folder; the parent must exist and an existing entry fails with
    /// [`WorkspaceError::AlreadyExists`].
    pub fn create_directory(&self, relative_path: &str) -> Result<(), WorkspaceError> {
        let (parent, name) = split_entry(relative_path)?;
        #[cfg(unix)]
        {
            self.create_directory_unix(&parent, &name)
        }
        #[cfg(not(unix))]
        {
            self.create_directory_fallback(&parent, &name)
        }
    }

    /// Permanently deletes one entry and reports what it was.
    pub fn delete_entry(
        &self,
        relative_path: &str,
        expected: EntryKind,
    ) -> Result<EntryKind, WorkspaceError> {
        let (parent, name) = split_entry(relative_path)?;
        #[cfg(unix)]
        {
            self.delete_entry_unix(&parent, &name, expected)
        }
        #[cfg(not(unix))]
        {
            self.delete_entry_fallback(&parent, &name, expected)
        }
    }

    #[cfg(not(unix))]
    fn create_directory_fallback(
        &self,
        parent: &std::path::Path,
        name: &std::ffi::OsStr,
    ) -> Result<(), WorkspaceError> {
        let parent_path = self.resolve_directory(parent_str(parent)?)?;
        std::fs::create_dir(parent_path.join(name)).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                WorkspaceError::AlreadyExists
            } else {
                WorkspaceError::Io(error)
            }
        })
    }

    #[cfg(not(unix))]
    fn delete_entry_fallback(
        &self,
        parent: &std::path::Path,
        name: &std::ffi::OsStr,
        expected: EntryKind,
    ) -> Result<EntryKind, WorkspaceError> {
        use std::fs;
        let parent_path = self.resolve_directory(parent_str(parent)?)?;
        let target = parent_path.join(name);
        let metadata = fs::symlink_metadata(&target).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                WorkspaceError::NotFound(target.display().to_string())
            } else {
                WorkspaceError::Io(error)
            }
        })?;
        let kind = if metadata.file_type().is_symlink() {
            EntryKind::Symlink
        } else if metadata.is_dir() {
            EntryKind::Directory
        } else {
            EntryKind::File
        };
        kind.check_expected(expected)?;
        match kind {
            // A directory symlink or junction is removed with remove_dir, never followed.
            EntryKind::Symlink => fs::remove_file(&target)
                .or_else(|_| fs::remove_dir(&target))
                .map_err(WorkspaceError::Io)?,
            EntryKind::File => fs::remove_file(&target).map_err(WorkspaceError::Io)?,
            EntryKind::Directory => {
                count_tree_fallback(&target, 1, &mut 0)?;
                // std's remove_dir_all does not follow symlinks or junctions.
                fs::remove_dir_all(&target).map_err(|error| {
                    WorkspaceError::UnknownOutcome(Box::new(WorkspaceError::Io(error)))
                })?;
            }
        }
        Ok(kind)
    }
}

#[cfg(not(unix))]
fn count_tree_fallback(
    directory: &std::path::Path,
    depth: usize,
    count: &mut usize,
) -> Result<(), WorkspaceError> {
    if depth > MAX_DELETE_DEPTH {
        return Err(WorkspaceError::DeleteLimitExceeded);
    }
    for entry in std::fs::read_dir(directory).map_err(WorkspaceError::Io)? {
        let entry = entry.map_err(WorkspaceError::Io)?;
        *count += 1;
        if *count > MAX_DELETE_ENTRIES {
            return Err(WorkspaceError::DeleteLimitExceeded);
        }
        let file_type = entry.file_type().map_err(WorkspaceError::Io)?;
        if file_type.is_dir() && !file_type.is_symlink() {
            count_tree_fallback(&entry.path(), depth + 1, count)?;
        }
    }
    Ok(())
}
