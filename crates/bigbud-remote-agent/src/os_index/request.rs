use std::path::{Path, PathBuf};
use std::time::Duration;

use super::error::OsIndexError;
use super::exclusions::Exclusions;
use super::scope::plain_canonical;
use crate::search::{MAX_SEARCH_DEADLINE, MAX_SEARCH_QUERY_CHARS};

/// Scopes one request may carry (home has a few dozen children at most).
pub const MAX_OS_INDEX_SCOPES: usize = 64;
/// Hard ceiling for returned rows.
pub const MAX_OS_INDEX_RESULTS: usize = 200;
/// Returned rows when the request leaves the limit at 0 (the plan's T5 cap).
pub const DEFAULT_OS_INDEX_RESULTS: usize = 50;
/// Rows requested from the OS index. Always the ceiling, so exclusions and scope filtering do not
/// starve the returned rows.
pub const OS_INDEX_FETCH_LIMIT: usize = 200;

/// A validated "this computer" name search. Construct with [`OsIndexRequest::new`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsIndexRequest {
    query: String,
    scopes: Vec<PathBuf>,
    max_results: usize,
    deadline: Duration,
}

impl OsIndexRequest {
    /// Validates the query and scopes. Each scope must be an existing folder given as its
    /// canonical, absolute UTF-8 path and must not be excluded. `max_results` of 0 means
    /// [`DEFAULT_OS_INDEX_RESULTS`]; larger values are capped at [`MAX_OS_INDEX_RESULTS`]. The
    /// deadline is capped at the workspace search ceiling; a zero deadline stops immediately.
    pub fn new(
        query: &str,
        scopes: Vec<PathBuf>,
        max_results: usize,
        deadline: Duration,
    ) -> Result<Self, OsIndexError> {
        let query = validate_query(query, &scopes)?;
        let exclusions = Exclusions::embedded()?;
        let mut validated: Vec<PathBuf> = Vec::with_capacity(scopes.len());
        for scope in scopes {
            validate_scope(&scope)?;
            if exclusions.excludes_scope(&scope) {
                return Err(OsIndexError::ExcludedScope);
            }
            if !validated.contains(&scope) {
                validated.push(scope);
            }
        }
        Ok(Self::build(query, validated, max_results, deadline))
    }

    /// Like [`OsIndexRequest::new`] for scopes returned by [`super::resolve_scopes`], which are
    /// already canonical, deduplicated, readable and not excluded. Skips the per-scope file-system
    /// checks, so a cached scope list costs no file-system calls per keystroke.
    pub fn from_resolved_scopes(
        query: &str,
        scopes: &[PathBuf],
        max_results: usize,
        deadline: Duration,
    ) -> Result<Self, OsIndexError> {
        let query = validate_query(query, scopes)?;
        Ok(Self::build(query, scopes.to_vec(), max_results, deadline))
    }

    fn build(query: &str, scopes: Vec<PathBuf>, max_results: usize, deadline: Duration) -> Self {
        Self {
            query: query.to_owned(),
            scopes,
            max_results: match max_results {
                0 => DEFAULT_OS_INDEX_RESULTS,
                requested => requested.min(MAX_OS_INDEX_RESULTS),
            },
            deadline: deadline.min(MAX_SEARCH_DEADLINE),
        }
    }

    /// The trimmed query.
    pub fn query(&self) -> &str {
        &self.query
    }

    /// Canonical scope folders, deduplicated, in request order.
    pub fn scopes(&self) -> &[PathBuf] {
        &self.scopes
    }

    pub fn max_results(&self) -> usize {
        self.max_results
    }

    pub fn deadline(&self) -> Duration {
        self.deadline
    }
}

/// The trimmed query, after checking it and the scope count.
fn validate_query<'a>(query: &'a str, scopes: &[PathBuf]) -> Result<&'a str, OsIndexError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(OsIndexError::EmptyQuery);
    }
    if query.chars().count() > MAX_SEARCH_QUERY_CHARS {
        return Err(OsIndexError::QueryTooLong);
    }
    if query.chars().any(char::is_control) {
        return Err(OsIndexError::ControlCharacter);
    }
    if scopes.is_empty() {
        return Err(OsIndexError::NoScopes);
    }
    if scopes.len() > MAX_OS_INDEX_SCOPES {
        return Err(OsIndexError::TooManyScopes);
    }
    Ok(query)
}

fn validate_scope(scope: &Path) -> Result<(), OsIndexError> {
    let usable = scope.is_absolute() && scope.to_str().is_some_and(|text| !text.contains('\0'));
    if !usable {
        return Err(OsIndexError::InvalidScope);
    }
    // Canonical means no `.`/`..` and no symlinked component, so the component-wise containment
    // check on results cannot be fooled by an alias of the scope.
    match plain_canonical(scope) {
        Some(canonical) if canonical == scope && canonical.is_dir() => Ok(()),
        Some(_) | None => Err(OsIndexError::InvalidScope),
    }
}
