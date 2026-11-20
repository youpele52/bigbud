//! "This computer" search through the operating system's own file index: Spotlight (`MDQuery`)
//! on macOS, Windows Search (`SystemIndex` over OLE DB) on Windows and `plocate` on Linux. File
//! names only for now.
//!
//! Only the desktop-embedded local agent may use this module. Scopes are bounded by the File
//! Access level, and every row is checked against the scopes and the exclusion list here, before
//! it can leave the agent. Queries and results are never logged or stored.

mod error;
mod exclusions;
// The `locate` adapter is Linux's; its process and parsing code is also tested on other Unix
// systems with fake programs.
#[cfg(any(target_os = "linux", all(test, unix)))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod locate;
#[cfg(any(target_os = "linux", test))]
mod locate_args;
#[cfg(any(target_os = "linux", all(test, unix)))]
mod locate_process;
#[cfg(any(target_os = "linux", all(test, unix)))]
mod locate_rows;
#[cfg(any(target_os = "macos", test))]
mod predicate;
mod request;
// Raw rows and the shared filter are only produced where an adapter exists.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "linux", windows)),
    allow(dead_code)
)]
mod results;
mod run;
mod scope;
mod scope_layout;
#[cfg(target_os = "macos")]
mod spotlight;
#[cfg(any(windows, target_os = "linux", all(test, unix)))]
mod stop;
#[cfg(windows)]
mod windows_search;
#[cfg(any(windows, test))]
mod windows_sql;
#[cfg(any(windows, test))]
mod winpath;

#[cfg(test)]
#[path = "exclusions.tests.rs"]
mod exclusions_tests;
#[cfg(test)]
#[path = "locate_args.tests.rs"]
mod locate_args_tests;
#[cfg(test)]
#[cfg(target_os = "linux")]
#[path = "locate.live.tests.rs"]
mod locate_live_tests;
#[cfg(test)]
#[cfg(unix)]
#[path = "locate.tests.rs"]
mod locate_tests;
#[cfg(test)]
#[path = "scope_layout.tests.rs"]
mod scope_layout_tests;
#[cfg(test)]
#[path = "scope.tests.rs"]
mod scope_tests;
#[cfg(test)]
#[cfg(target_os = "macos")]
#[path = "spotlight.tests.rs"]
mod spotlight_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
#[cfg(windows)]
#[path = "windows_search.tests.rs"]
mod windows_search_tests;
#[cfg(test)]
#[path = "windows_sql.tests.rs"]
mod windows_sql_tests;

pub use error::OsIndexError;
pub use request::{
    DEFAULT_OS_INDEX_RESULTS, MAX_OS_INDEX_RESULTS, MAX_OS_INDEX_SCOPES, OS_INDEX_FETCH_LIMIT,
    OsIndexRequest,
};
pub use results::{OsIndexHit, OsIndexOutcome};
pub use run::{OS_INDEX_SOURCE, search_names};
pub use scope::{CLOUD_FOLDERS, COMMON_FOLDERS, OsIndexScopeLevel, home_folder, resolve_scopes};
