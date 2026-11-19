//! Entry point for "this computer" name searches. macOS uses Spotlight; other platforms compile
//! to a stub that reports [`OsIndexError::Unsupported`] and pulls in no Objective-C bindings.

use std::sync::atomic::AtomicBool;

use super::error::OsIndexError;
use super::request::OsIndexRequest;
use super::results::OsIndexOutcome;

/// The OS index this build queries (`spotlight`), or `None` where none is supported yet.
pub const OS_INDEX_SOURCE: Option<&str> = imp::SOURCE;

/// Runs a name search, blocking the calling thread until it completes, reaches the request's
/// deadline, or `cancel` is set. Run it on a dedicated worker thread. Every returned row is inside
/// a request scope and has passed the exclusion list.
pub fn search_names(
    request: &OsIndexRequest,
    cancel: &AtomicBool,
) -> Result<OsIndexOutcome, OsIndexError> {
    imp::search_names(request, cancel)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::atomic::AtomicBool;

    use super::super::exclusions::Exclusions;
    use super::super::results::finish_hits;
    use super::super::spotlight;
    use super::{OsIndexError, OsIndexOutcome, OsIndexRequest};

    pub const SOURCE: Option<&str> = Some("spotlight");

    pub fn search_names(
        request: &OsIndexRequest,
        cancel: &AtomicBool,
    ) -> Result<OsIndexOutcome, OsIndexError> {
        // Resolve the list first, so a damaged list fails closed before any query runs.
        let exclusions = Exclusions::embedded()?;
        let (raw, stop) = spotlight::gather(request, cancel)?;
        Ok(finish_hits(request, exclusions, raw, stop))
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use std::sync::atomic::AtomicBool;

    use super::{OsIndexError, OsIndexOutcome, OsIndexRequest};

    pub const SOURCE: Option<&str> = None;

    pub fn search_names(
        _request: &OsIndexRequest,
        _cancel: &AtomicBool,
    ) -> Result<OsIndexOutcome, OsIndexError> {
        Err(OsIndexError::Unsupported)
    }
}
