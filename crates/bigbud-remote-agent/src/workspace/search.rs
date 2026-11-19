use std::collections::VecDeque;
use std::fs::{self, DirEntry, ReadDir};

use super::{DirectoryEntry, WorkspaceError, WorkspaceRoot, map_io};
use super::{MAX_SEARCH_FILES, MAX_SEARCH_RESULTS};

use crate::search::{self, rank};
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

    /// Legacy `ContentSearchRequest`, now served by the ripgrep-library engine: literal
    /// smart-case matching, ignore files respected, links skipped (no longer an abort), binary
    /// and oversized files skipped. Results are sorted by path and line for stable answers.
    pub fn search_content(
        &self,
        relative_path: &str,
        query: &str,
        max_results: usize,
    ) -> Result<Vec<ContentMatch>, WorkspaceError> {
        if query.is_empty() {
            return Err(WorkspaceError::EmptySearchQuery);
        }
        let start = self.resolve_directory(relative_path)?;
        let result_limit = max_results.min(MAX_SEARCH_RESULTS);
        if result_limit == 0 {
            return Ok(Vec::new());
        }
        let request = search::SearchRequest {
            roots: vec![search::SearchRoot {
                root_id: String::new(),
                workspace: self.clone(),
                start,
            }],
            query: query.to_owned(),
            mode: search::SearchMode::Content,
            max_results: result_limit,
            max_results_per_root: result_limit,
            deadline: search::MAX_SEARCH_DEADLINE,
            threads: search::default_thread_count(false),
            background: false,
        };
        let mut results = Vec::new();
        let never_cancelled = std::sync::atomic::AtomicBool::new(false);
        let _outcome = search::run_search(&request, &never_cancelled, &mut |batch| {
            results.extend(batch.contents.into_iter().map(|hit| ContentMatch {
                path: hit.path,
                line: hit.matched.line as usize,
                column: hit.matched.column as usize,
                excerpt: hit.matched.excerpt,
            }));
            true
        });
        results.sort_by(|left, right| (&left.path, left.line).cmp(&(&right.path, right.line)));
        Ok(results)
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
