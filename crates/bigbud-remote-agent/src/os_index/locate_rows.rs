//! Turns streamed `locate` records into raw rows. The `locate` database covers the whole disk, so
//! rows outside the scopes are dropped here, while streaming, and only rows that can be returned
//! count towards [`OS_INDEX_FETCH_LIMIT`]. The shared filter in `results.rs` checks every row again.

use std::path::Path;
use std::time::UNIX_EPOCH;

use super::exclusions::Exclusions;
use super::locate_args::NulRecords;
use super::request::{OS_INDEX_FETCH_LIMIT, OsIndexRequest};
use super::results::RawOsIndexHit;
use super::scope::split_by_scope;

pub struct LocateRows<'a> {
    request: &'a OsIndexRequest,
    exclusions: &'a Exclusions,
    records: NulRecords,
    rows: Vec<RawOsIndexHit>,
    usable: usize,
    excluded: usize,
}

impl<'a> LocateRows<'a> {
    pub fn new(request: &'a OsIndexRequest, exclusions: &'a Exclusions) -> Self {
        Self {
            request,
            exclusions,
            records: NulRecords::default(),
            rows: Vec::new(),
            usable: 0,
            excluded: 0,
        }
    }

    /// Consumes one output chunk. Returns `false` once [`OS_INDEX_FETCH_LIMIT`] returnable rows
    /// were gathered, so the caller can stop the process.
    pub fn feed(&mut self, chunk: &[u8]) -> bool {
        for path in self.records.feed(chunk) {
            self.accept(path);
            if self.usable >= OS_INDEX_FETCH_LIMIT {
                return false;
            }
        }
        true
    }

    /// Records the process printed, including skipped ones.
    pub fn records(&self) -> usize {
        self.records.records()
    }

    pub fn into_rows(self) -> Vec<RawOsIndexHit> {
        self.rows
    }

    fn accept(&mut self, path: String) {
        let candidate = Path::new(&path);
        let Some((_, below)) = split_by_scope(candidate, self.request.scopes()) else {
            return;
        };
        if self.exclusions.excludes(candidate, below) {
            // Passed on unread (no metadata) only so the shared filter counts it; bounded.
            if self.excluded < OS_INDEX_FETCH_LIMIT {
                self.excluded += 1;
                self.rows.push(RawOsIndexHit {
                    path,
                    ..RawOsIndexHit::default()
                });
            }
            return;
        }
        // The database can be up to a day old: a row that no longer exists, or that this user
        // can no longer reach, is dropped. Symlinks are described, never followed.
        let Ok(metadata) = std::fs::symlink_metadata(candidate) else {
            return;
        };
        let modified_unix_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .and_then(|since| u64::try_from(since.as_millis()).ok())
            // Unknown or pre-1970 times are reported as 0 ("unknown").
            .unwrap_or(0);
        self.rows.push(RawOsIndexHit {
            path,
            is_directory: metadata.is_dir(),
            content_type: String::new(),
            size_bytes: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
            modified_unix_ms,
            // Access times are unreliable (`noatime`, `relatime`), so "last used" stays unknown.
            last_used_unix_ms: 0,
        });
        self.usable += 1;
    }
}
