//! Turns raw OS-index rows into the rows that may leave the agent: inside a scope, not excluded,
//! unique, ranked and capped. Platform-neutral, so later Windows Search and `plocate` adapters
//! share it, and testable with a fake index.

use std::cmp::Reverse;
use std::collections::HashSet;
use std::path::{Component, Path};

use super::exclusions::Exclusions;
use super::request::OsIndexRequest;
use super::scope::split_by_scope;
use crate::search::{StopReason, rank};
use crate::workspace::DirectoryEntry;

/// One row as an OS-index adapter reports it, before any filtering. Timestamps are Unix
/// milliseconds and sizes bytes; 0 means unknown.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawOsIndexHit {
    pub path: String,
    pub is_directory: bool,
    /// Uniform type identifier on macOS (for example `public.plain-text`); empty when unknown.
    pub content_type: String,
    pub size_bytes: u64,
    pub modified_unix_ms: u64,
    pub last_used_unix_ms: u64,
}

/// A row that passed scope and exclusion checks. `path` is absolute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsIndexHit {
    pub path: String,
    pub is_directory: bool,
    pub content_type: String,
    pub size_bytes: u64,
    pub modified_unix_ms: u64,
    pub last_used_unix_ms: u64,
    /// Workspace name-ranking score (lower is better; `u32::MAX` when only the OS index matched,
    /// for example through diacritic folding).
    pub score: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsIndexOutcome {
    /// Best first: score, then most recently used, then most recently modified, then path.
    pub hits: Vec<OsIndexHit>,
    pub stop: StopReason,
    /// More rows matched than were returned.
    pub truncated: bool,
    /// Rows dropped by the exclusion list (count only; never the paths).
    pub excluded: u64,
    /// Rows dropped for being outside every scope or not a plain absolute path.
    pub out_of_scope: u64,
}

/// Filters, ranks and caps `raw`. `stop` is how gathering ended; a complete gather that still had
/// to drop rows to fit `max_results` is reported as [`StopReason::Limit`].
pub fn finish_hits(
    request: &OsIndexRequest,
    exclusions: &Exclusions,
    raw: Vec<RawOsIndexHit>,
    stop: StopReason,
) -> OsIndexOutcome {
    let query = rank::normalize_query(request.query());
    let mut seen = HashSet::with_capacity(raw.len());
    let mut excluded = 0_u64;
    let mut out_of_scope = 0_u64;
    let mut hits = Vec::with_capacity(raw.len().min(request.max_results() * 2));
    for row in raw {
        let path = Path::new(&row.path);
        let Some((scope, below)) = split_by_scope(path, request.scopes()) else {
            out_of_scope += 1;
            continue;
        };
        if exclusions.excludes(path, below) {
            excluded += 1;
            continue;
        }
        if !seen.insert(row.path.clone()) {
            continue;
        }
        let ranked_path = ranking_path(scope, below);
        let entry = DirectoryEntry {
            path: ranked_path,
            is_directory: row.is_directory,
            is_file: !row.is_directory,
            size_bytes: row.size_bytes,
            modified_unix_ms: row.modified_unix_ms,
        };
        let score = rank::score_entry(&entry, &query)
            .map_or(u32::MAX, |score| u32::try_from(score).unwrap_or(u32::MAX));
        hits.push(OsIndexHit {
            path: row.path,
            is_directory: row.is_directory,
            content_type: row.content_type,
            size_bytes: row.size_bytes,
            modified_unix_ms: row.modified_unix_ms,
            last_used_unix_ms: row.last_used_unix_ms,
            score,
        });
    }
    hits.sort_by(|left, right| {
        (
            left.score,
            Reverse(left.last_used_unix_ms),
            Reverse(left.modified_unix_ms),
            &left.path,
        )
            .cmp(&(
                right.score,
                Reverse(right.last_used_unix_ms),
                Reverse(right.modified_unix_ms),
                &right.path,
            ))
    });
    let truncated = hits.len() > request.max_results() || stop == StopReason::Limit;
    hits.truncate(request.max_results());
    let stop = match stop {
        StopReason::Complete if truncated => StopReason::Limit,
        other => other,
    };
    OsIndexOutcome {
        hits,
        stop,
        truncated,
        excluded,
        out_of_scope,
    }
}

/// The path the name ranking sees: the scope folder's name plus the part below it, with `/`
/// separators on every platform (for example `Documents/taxes/2026.pdf`), as the row reads in the
/// palette under `~/`.
fn ranking_path(scope: &Path, below: &Path) -> String {
    let scope_name = scope.file_name().and_then(|name| name.to_str());
    let below_names = below.components().filter_map(|component| match component {
        Component::Normal(name) => name.to_str(),
        _ => None,
    });
    scope_name
        .into_iter()
        .chain(below_names)
        .collect::<Vec<_>>()
        .join("/")
}
