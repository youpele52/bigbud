//! "This computer" search through the operating system's own file index: Spotlight (`MDQuery`)
//! on macOS; Windows Search and `plocate` adapters come later. File names only for now.
//!
//! Only the desktop-embedded local agent may use this module. Scopes are bounded by the File
//! Access level, and every row is checked against the scopes and the exclusion list here, before
//! it can leave the agent. Queries and results are never logged or stored.

mod error;
mod exclusions;
#[cfg(any(target_os = "macos", test))]
mod predicate;
mod request;
// Raw rows and the shared filter are only produced by the macOS adapter until the Windows and
// Linux adapters land.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod results;
mod run;
mod scope;
#[cfg(target_os = "macos")]
mod spotlight;

#[cfg(test)]
#[path = "exclusions.tests.rs"]
mod exclusions_tests;
#[cfg(test)]
#[path = "scope.tests.rs"]
mod scope_tests;
#[cfg(test)]
#[cfg(target_os = "macos")]
#[path = "spotlight.tests.rs"]
mod spotlight_tests;
#[cfg(test)]
mod tests;

pub use error::OsIndexError;
pub use request::{
    DEFAULT_OS_INDEX_RESULTS, MAX_OS_INDEX_QUERY_CHARS, MAX_OS_INDEX_RESULTS, MAX_OS_INDEX_SCOPES,
    OS_INDEX_FETCH_LIMIT, OsIndexRequest,
};
pub use results::{OsIndexHit, OsIndexOutcome};
pub use run::{OS_INDEX_SOURCE, search_names};
pub use scope::{CLOUD_FOLDERS, COMMON_FOLDERS, OsIndexScopeLevel, resolve_scopes};
