use std::collections::VecDeque;
use std::ffi::OsStr;
use std::fs::{self, DirEntry, ReadDir};

use super::{DirectoryEntry, WorkspaceError, WorkspaceRoot, map_io};
use super::{MAX_SEARCH_FILES, MAX_SEARCH_RESULTS, MAX_TEXT_PREVIEW_BYTES};

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
        if query.is_empty() {
            return Err(WorkspaceError::EmptySearchQuery);
        }
        let start = self.resolve_existing(relative_path)?;
        let mut queue = VecDeque::from([start]);
        let mut results = Vec::new();
        let result_limit = max_results.min(MAX_SEARCH_RESULTS);
        if result_limit == 0 {
            return Ok(results);
        }
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
                }
                if name.to_string_lossy().contains(query) {
                    results.push(self.directory_entry(&entry, &metadata)?);
                    if results.len() >= result_limit {
                        results.sort_by(|left, right| left.path.cmp(&right.path));
                        return Ok(results);
                    }
                }
            }
        }
        results.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(results)
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
            modified_unix_ms: metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default(),
        })
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
