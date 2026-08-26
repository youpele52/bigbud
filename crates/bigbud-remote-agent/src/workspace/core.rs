#[path = "directory.rs"]
mod directory;
#[path = "files.rs"]
mod files;
#[path = "path.rs"]
mod path;
#[path = "search.rs"]
mod search;

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

use std::io;

pub use directory::DirectoryEntry;
pub use files::ReadFileResult;
pub use path::WorkspaceRoot;
pub use search::ContentMatch;

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

pub(super) fn metadata_modified_unix_ms(
    metadata: &std::fs::Metadata,
) -> Result<u64, WorkspaceError> {
    let modified = metadata.modified().map_err(map_io)?;
    let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) else {
        return Ok(0);
    };
    Ok(duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

impl bigbud_workspace_watch::WorkspaceWatchHost for WorkspaceRoot {
    fn canonical_root(&self) -> &std::path::Path {
        self.root()
    }

    fn resolve_directory(
        &self,
        relative_path: &str,
    ) -> Result<std::path::PathBuf, bigbud_workspace_watch::WorkspaceWatchHostError> {
        WorkspaceRoot::resolve_directory(self, relative_path).map_err(|error| {
            bigbud_workspace_watch::WorkspaceWatchHostError::new(error.to_string())
        })
    }

    fn relative_path(
        &self,
        path: &std::path::Path,
    ) -> Result<String, bigbud_workspace_watch::WorkspaceWatchHostError> {
        WorkspaceRoot::relative_path(self, path).map_err(|error| {
            bigbud_workspace_watch::WorkspaceWatchHostError::new(error.to_string())
        })
    }

    fn list_directory(
        &self,
        relative_path: &str,
    ) -> Result<
        Vec<bigbud_workspace_watch::WorkspaceWatchEntry>,
        bigbud_workspace_watch::WorkspaceWatchHostError,
    > {
        self.list_directory_for_watch(relative_path)
            .map(|entries| {
                entries
                    .into_iter()
                    .map(|entry| bigbud_workspace_watch::WorkspaceWatchEntry {
                        path: entry.path,
                        is_directory: entry.is_directory,
                        is_file: entry.is_file,
                        size_bytes: entry.size_bytes,
                        modified_unix_ms: entry.modified_unix_ms,
                    })
                    .collect()
            })
            .map_err(|error| {
                bigbud_workspace_watch::WorkspaceWatchHostError::new(error.to_string())
            })
    }
}
