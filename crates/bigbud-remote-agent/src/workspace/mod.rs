mod directory;
mod files;
mod path;
mod search;
mod watch;

#[cfg(test)]
mod tests;

use std::io;

pub use directory::DirectoryEntry;
pub use files::ReadFileResult;
pub use path::WorkspaceRoot;
pub use search::ContentMatch;
pub use watch::{WorkspaceWatchError, WorkspaceWatchRegistry, WorkspaceWatchStart};

pub const MAX_TEXT_PREVIEW_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_DIRECTORY_ENTRIES: usize = 10_000;
pub const MAX_SEARCH_RESULTS: usize = 1_000;
pub const MAX_SEARCH_FILES: usize = 50_000;
pub const MAX_WRITE_BYTES: usize = 512 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("workspace root is not a directory")]
    RootNotDirectory,
    #[error("workspace path is invalid: {0}")]
    InvalidPath(String),
    #[error("workspace path escapes the configured root")]
    OutsideRoot,
    #[error("workspace path contains a symlink component")]
    SymlinkComponent,
    #[error("workspace path was not found: {0}")]
    NotFound(String),
    #[error("workspace path is not a directory")]
    NotDirectory,
    #[error("workspace path is not a regular file")]
    NotRegularFile,
    #[error("workspace directory has more than {MAX_DIRECTORY_ENTRIES} entries")]
    DirectoryLimitExceeded,
    #[error("workspace write exceeds the configured {MAX_WRITE_BYTES} byte limit")]
    WriteLimitExceeded,
    #[error("workspace file changed since it was read")]
    WriteConflict {
        expected: String,
        actual: Option<String>,
    },
    #[error("workspace search query cannot be empty")]
    EmptySearchQuery,
    #[error("workspace search exceeded the configured file limit")]
    SearchLimitExceeded,
    #[error("workspace I/O failed: {0}")]
    Io(#[source] io::Error),
}

pub(super) fn map_io(error: io::Error) -> WorkspaceError {
    WorkspaceError::Io(error)
}
