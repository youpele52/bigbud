use std::collections::VecDeque;
use std::ffi::OsStr;
use std::fs::{self, DirEntry, ReadDir};

use super::{DirectoryEntry, WorkspaceError, WorkspaceRoot, map_io};
use super::{MAX_SEARCH_FILES, MAX_SEARCH_RESULTS, MAX_TEXT_PREVIEW_BYTES};

#[path = "search.rank.rs"]
mod rank;
#[cfg(test)]
#[path = "search.tests.rs"]
mod tests;

const IGNORED_DIRECTORIES: [&str; 4] = [".git", "node_modules", "target", ".bigbud"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub excerpt: String,
}

impl WorkspaceRoot {
    pub fn search_names(
        &self,
        relative_path: &str,
        query: &str,
        max_results: usize,
    ) -> Result<Vec<String>, WorkspaceError> {
        if query.is_empty() {
            return Err(WorkspaceError::EmptySearchQuery);
        }
        Ok(self
            .search_entries(relative_path, query, max_results)?
            .into_iter()
            .map(|entry| entry.path)
            .collect())
    }

    pub fn search_entries(
        &self,
        relative_path: &str,
        query: &str,
        max_results: usize,
    ) -> Result<Vec<DirectoryEntry>, WorkspaceError> {
        self.search_entries_bounded(relative_path, query, max_results, MAX_SEARCH_FILES)
    }

    fn search_entries_bounded(
        &self,
        relative_path: &str,
        query: &str,
        max_results: usize,
        entry_limit: usize,
    ) -> Result<Vec<DirectoryEntry>, WorkspaceError> {
        if query.is_empty() {
            return Err(WorkspaceError::EmptySearchQuery);
        }
        // Validate explicitly requested roots even when no results were requested.
        self.resolve_name_search_directory(relative_path)?;
        let result_limit = max_results.min(MAX_SEARCH_RESULTS);
        if result_limit == 0 {
            return Ok(Vec::new());
        }
        let query = rank::normalize_query(query);
        let mut queue = VecDeque::from([relative_path.to_owned()]);
        let mut results = rank::RankedEntries::new(result_limit);
        let mut visited_entries = 0;
        while let Some(relative_directory) = queue.pop_front() {
            // Revalidate queued directories in case a component became a link.
            let directory = self.resolve_name_search_directory(&relative_directory)?;
            for entry in read_directory(&directory)? {
                let entry = entry.map_err(map_io)?;
                // Count all encountered entries, including links and ignored dirs.
                // This also bounds queued directories and searches with no matches.
                if visited_entries >= entry_limit {
                    return Err(WorkspaceError::SearchLimitExceeded);
                }
                visited_entries += 1;
                let metadata = fs::symlink_metadata(entry.path()).map_err(map_io)?;
                if is_search_link(&metadata) {
                    continue;
                }
                let name = entry.file_name();
                // The wire path is UTF-8. An unrepresentable discovered candidate
                // must not prevent searching its representable siblings.
                if name.to_str().is_none() {
                    continue;
                }
                if metadata.is_dir() && IGNORED_DIRECTORIES.iter().any(|ignored| name == *ignored) {
                    continue;
                }
                let candidate = self.directory_entry(&entry, &metadata)?;
                if metadata.is_dir() {
                    queue.push_back(candidate.path.clone());
                }
                if let Some(score) = rank::score_entry(&candidate, &query) {
                    results.insert(candidate, score);
                }
            }
        }
        Ok(results.into_entries())
    }

    fn resolve_name_search_directory(
        &self,
        relative_path: &str,
    ) -> Result<std::path::PathBuf, WorkspaceError> {
        #[cfg(windows)]
        {
            // Windows junctions are reparse points but not necessarily symlinks.
            // Inspect the lexical components before canonicalization hides them.
            let relative = super::path::validate_relative_path(relative_path)?;
            let mut current = self.root().to_path_buf();
            for component in relative.components() {
                current.push(component);
                if is_search_link(&fs::symlink_metadata(&current).map_err(map_io)?) {
                    return Err(WorkspaceError::SymlinkComponent);
                }
            }
        }
        self.resolve_directory(relative_path)
    }

    pub fn search_content(
        &self,
        relative_path: &str,
        query: &str,
        max_results: usize,
    ) -> Result<Vec<ContentMatch>, WorkspaceError> {
        if query.is_empty() {
            return Err(WorkspaceError::EmptySearchQuery);
        }
        let paths = self.search_all_files(relative_path)?;
        let result_limit = max_results.min(MAX_SEARCH_RESULTS);
        if result_limit == 0 {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        for path in paths {
            if results.len() >= result_limit {
                break;
            }
            let mut file = self.open_file(&path)?;
            if file.metadata().map_err(map_io)?.len() > MAX_TEXT_PREVIEW_BYTES as u64 {
                continue;
            }
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(
                &mut std::io::Read::take(&mut file, MAX_TEXT_PREVIEW_BYTES as u64 + 1),
                &mut bytes,
            )
            .map_err(map_io)?;
            if bytes.len() > MAX_TEXT_PREVIEW_BYTES {
                continue;
            }
            let Ok(contents) = String::from_utf8(bytes) else {
                continue;
            };
            for (line_index, line) in contents.lines().enumerate() {
                let Some(column) = line.find(query) else {
                    continue;
                };
                results.push(ContentMatch {
                    path: path.clone(),
                    line: line_index + 1,
                    column: column + 1,
                    excerpt: line.chars().take(512).collect(),
                });
                if results.len() >= result_limit {
                    break;
                }
            }
        }
        Ok(results)
    }

    fn search_all_files(&self, relative_path: &str) -> Result<Vec<String>, WorkspaceError> {
        let start = self.resolve_existing(relative_path)?;
        let mut queue = VecDeque::from([start]);
        let mut files = Vec::new();
        while let Some(directory) = queue.pop_front() {
            for entry in read_directory(&directory)? {
                let entry = entry.map_err(map_io)?;
                if entry.file_type().map_err(map_io)?.is_symlink() {
                    return Err(WorkspaceError::SymlinkComponent);
                }
                let name = entry.file_name();
                if is_ignored_directory(&entry, &name) {
                    continue;
                }
                let metadata = entry.metadata().map_err(map_io)?;
                if metadata.is_dir() {
                    queue.push_back(entry.path());
                } else if metadata.is_file() {
                    if files.len() >= MAX_SEARCH_FILES {
                        return Err(WorkspaceError::SearchLimitExceeded);
                    }
                    files.push(self.relative_path(&entry.path())?);
                }
            }
        }
        files.sort();
        Ok(files)
    }

    fn directory_entry(
        &self,
        entry: &DirEntry,
        metadata: &fs::Metadata,
    ) -> Result<DirectoryEntry, WorkspaceError> {
        Ok(DirectoryEntry {
            path: self.relative_path(&entry.path())?,
            is_directory: metadata.is_dir(),
            is_file: metadata.is_file(),
            size_bytes: metadata.len(),
            modified_unix_ms: super::metadata_modified_unix_ms(metadata)?,
        })
    }
}

fn is_search_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes symlinks, junctions, and other redirecting reparse points.
        metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn read_directory(path: &std::path::Path) -> Result<ReadDir, WorkspaceError> {
    fs::read_dir(path).map_err(map_io)
}

fn is_ignored_directory(entry: &DirEntry, name: &OsStr) -> bool {
    entry.file_type().is_ok_and(|kind| {
        kind.is_dir() && IGNORED_DIRECTORIES.iter().any(|ignored| name == *ignored)
    })
}
