use std::path::PathBuf;
use std::time::Duration;

use bigbud_protocol::v1;

use crate::workspace::{MAX_SEARCH_RESULTS, WorkspaceError, WorkspaceRoot};

/// Roots one request may carry; roots are opened for the operation only.
pub const MAX_SEARCH_ROOTS: usize = 128;
/// Hard ceiling for any server-provided deadline.
pub const MAX_SEARCH_DEADLINE: Duration = Duration::from_secs(10);
/// Used when the request leaves the deadline at 0.
pub const DEFAULT_SEARCH_DEADLINE: Duration = Duration::from_secs(2);
/// Longest accepted query, in characters (matches the saved-message limit's order).
pub const MAX_SEARCH_QUERY_CHARS: usize = 512;
/// Upper bound for walker threads, whatever the request asks for.
pub const MAX_SEARCH_THREADS: usize = 6;
/// Thread count for background (remote) searches.
pub const BACKGROUND_SEARCH_THREADS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchMode {
    Names,
    Content,
    Both,
}

impl SearchMode {
    pub fn names(self) -> bool {
        matches!(self, Self::Names | Self::Both)
    }

    pub fn content(self) -> bool {
        matches!(self, Self::Content | Self::Both)
    }
}

#[derive(Debug, Clone)]
pub struct SearchRoot {
    pub root_id: String,
    pub workspace: WorkspaceRoot,
    /// Absolute folder the walk starts in (the root or a validated folder inside it).
    pub start: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SearchRequest {
    pub roots: Vec<SearchRoot>,
    pub query: String,
    pub mode: SearchMode,
    pub max_results: usize,
    pub max_results_per_root: usize,
    pub deadline: Duration,
    pub threads: usize,
    pub background: bool,
}

/// A root that could not be opened; the rest of the request still runs.
#[derive(Debug)]
pub struct RootFailure {
    pub root_id: String,
    pub error: WorkspaceError,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SearchRequestError {
    #[error("workspace search query cannot be empty")]
    EmptyQuery,
    #[error("workspace search query is too long")]
    QueryTooLong,
    #[error("workspace search query contains a control character")]
    ControlCharacter,
    #[error("workspace search requires at least one root")]
    NoRoots,
    #[error("workspace search carries more than {MAX_SEARCH_ROOTS} roots")]
    TooManyRoots,
    #[error("workspace search mode is not specified")]
    MissingMode,
}

impl SearchRequestError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::TooManyRoots => "TOO_MANY_ROOTS",
            Self::EmptyQuery => "EMPTY_SEARCH_QUERY",
            _ => "INVALID_ARGUMENT",
        }
    }
}

/// Interactive local searches use half the cores (2–6); background searches use 2.
pub fn default_thread_count(background: bool) -> usize {
    if background {
        return BACKGROUND_SEARCH_THREADS;
    }
    let cores = std::thread::available_parallelism().map_or(2, std::num::NonZeroUsize::get);
    (cores / 2).clamp(2, MAX_SEARCH_THREADS)
}

impl SearchRequest {
    /// Validates the wire request and opens each root like `WorkspaceOpenRequest`. Roots that
    /// fail to open are reported per root instead of failing the whole search.
    pub fn from_proto(
        request: &v1::WorkspaceSearchRequest,
    ) -> Result<(Self, Vec<RootFailure>), SearchRequestError> {
        let query = request.query.trim();
        if query.is_empty() {
            return Err(SearchRequestError::EmptyQuery);
        }
        if query.chars().count() > MAX_SEARCH_QUERY_CHARS {
            return Err(SearchRequestError::QueryTooLong);
        }
        if query.chars().any(char::is_control) {
            return Err(SearchRequestError::ControlCharacter);
        }
        if request.roots.is_empty() {
            return Err(SearchRequestError::NoRoots);
        }
        if request.roots.len() > MAX_SEARCH_ROOTS {
            return Err(SearchRequestError::TooManyRoots);
        }
        let mode = match v1::WorkspaceSearchMode::try_from(request.mode) {
            Ok(v1::WorkspaceSearchMode::Names) => SearchMode::Names,
            Ok(v1::WorkspaceSearchMode::Content) => SearchMode::Content,
            Ok(v1::WorkspaceSearchMode::Both) => SearchMode::Both,
            Ok(v1::WorkspaceSearchMode::Unspecified) | Err(_) => {
                return Err(SearchRequestError::MissingMode);
            }
        };
        let background = request.priority == v1::WorkspaceSearchPriority::Background as i32;
        let mut roots = Vec::with_capacity(request.roots.len());
        let mut failures = Vec::new();
        for root in &request.roots {
            match open_root(root) {
                Ok(opened) => roots.push(opened),
                Err(error) => failures.push(RootFailure {
                    root_id: root.root_id.clone(),
                    error,
                }),
            }
        }
        let max_results = clamp_limit(request.max_results, MAX_SEARCH_RESULTS);
        let deadline = match request.deadline_ms {
            0 => DEFAULT_SEARCH_DEADLINE,
            milliseconds => Duration::from_millis(u64::from(milliseconds)),
        }
        .min(MAX_SEARCH_DEADLINE);
        let threads = match request.max_threads {
            0 => default_thread_count(background),
            requested => (requested as usize).clamp(1, MAX_SEARCH_THREADS),
        };
        Ok((
            Self {
                roots,
                query: query.to_owned(),
                mode,
                max_results,
                max_results_per_root: clamp_limit(request.max_results_per_root, max_results),
                deadline,
                threads: if background {
                    threads.min(BACKGROUND_SEARCH_THREADS)
                } else {
                    threads
                },
                background,
            },
            failures,
        ))
    }
}

fn clamp_limit(requested: u32, ceiling: usize) -> usize {
    match requested {
        0 => ceiling,
        value => (value as usize).min(ceiling),
    }
}

fn open_root(root: &v1::WorkspaceSearchRoot) -> Result<SearchRoot, WorkspaceError> {
    if root.root.contains('\0') || !std::path::Path::new(&root.root).is_absolute() {
        return Err(WorkspaceError::InvalidPath(
            "search roots must be absolute".to_owned(),
        ));
    }
    let workspace = WorkspaceRoot::open(&root.root)?;
    let start = workspace.resolve_directory(&root.relative_path)?;
    Ok(SearchRoot {
        root_id: root.root_id.clone(),
        workspace,
        start,
    })
}
