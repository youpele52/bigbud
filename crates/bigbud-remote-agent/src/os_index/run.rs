//! Entry point for "this computer" name searches. macOS uses Spotlight, Windows uses Windows
//! Search and Linux uses `plocate` (or a compatible `locate`); other platforms compile to a stub
//! that reports [`OsIndexError::Unsupported`]. Each build links only its own platform's bindings.

use std::sync::atomic::AtomicBool;

use super::error::OsIndexError;
use super::exclusions::Exclusions;
use super::request::OsIndexRequest;
use super::results::{OsIndexOutcome, finish_hits};

/// The OS index this build queries (`spotlight`, `windows-search` or `locate`), or `None` where
/// none is supported.
pub const OS_INDEX_SOURCE: Option<&str> = imp::SOURCE;

/// Runs a name search, blocking the calling thread until it completes, reaches the request's
/// deadline, or `cancel` is set. Run it on a dedicated worker thread. Every returned row is inside
/// a request scope and has passed the exclusion list.
pub fn search_names(
    request: &OsIndexRequest,
    cancel: &AtomicBool,
) -> Result<OsIndexOutcome, OsIndexError> {
    // Resolve the list first, so a damaged list fails closed before any query runs.
    let exclusions = Exclusions::embedded()?;
    let (raw, stop) = imp::gather(request, cancel)?;
    Ok(finish_hits(request, exclusions, raw, stop))
}

#[cfg(target_os = "macos")]
mod imp {
    pub(super) use super::super::spotlight::gather;

    pub const SOURCE: Option<&str> = Some("spotlight");
}

#[cfg(windows)]
mod imp {
    pub(super) use super::super::windows_search::gather;

    pub const SOURCE: Option<&str> = Some("windows-search");
}

#[cfg(target_os = "linux")]
mod imp {
    pub(super) use super::super::locate::gather;

    /// `plocate` first; `mlocate` or GNU `locate` when `plocate` is not installed.
    pub const SOURCE: Option<&str> = Some("locate");
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod imp {
    use std::sync::atomic::AtomicBool;

    use super::super::request::OsIndexRequest;
    use super::super::results::RawOsIndexHit;
    use super::OsIndexError;
    use crate::search::StopReason;

    pub const SOURCE: Option<&str> = None;

    pub fn gather(
        _request: &OsIndexRequest,
        _cancel: &AtomicBool,
    ) -> Result<(Vec<RawOsIndexHit>, StopReason), OsIndexError> {
        Err(OsIndexError::Unsupported)
    }
}
