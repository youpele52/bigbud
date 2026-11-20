//! Linux adapter: `plocate`, or a compatible `locate` (`mlocate`, GNU findutils) when `plocate`
//! is not installed. Runs as the agent's user (never `sudo`); `plocate` itself only prints paths
//! that user can reach. The database is refreshed by a daily `updatedb`, so new files can be
//! missing for up to a day; rows deleted since are dropped when their metadata is read.
//!
//! Nothing here logs the query, the output or stderr.

use std::ffi::OsStr;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use super::error::OsIndexError;
use super::exclusions::Exclusions;
use super::locate_args::{LOCATE_RECORD_LIMIT, classify_exit, is_compatible_locate, locate_args};
use super::locate_process::{RunEnd, SpawnError, run_streaming};
use super::locate_rows::LocateRows;
use super::request::OsIndexRequest;
use super::results::RawOsIndexHit;
use crate::search::StopReason;

/// Most `--version` output read from the fallback `locate`.
const MAX_VERSION_BYTES: usize = 4 * 1024;

/// The programs to try, looked up on `PATH`. Tests substitute fakes.
#[derive(Debug, Clone, Copy)]
pub struct LocatePrograms<'a> {
    pub plocate: &'a OsStr,
    pub locate: &'a OsStr,
}

impl LocatePrograms<'static> {
    pub fn system() -> Self {
        Self {
            plocate: OsStr::new("plocate"),
            locate: OsStr::new("locate"),
        }
    }
}

/// Runs the name query with the system's `plocate` (or compatible `locate`).
pub fn gather(
    request: &OsIndexRequest,
    cancel: &AtomicBool,
) -> Result<(Vec<RawOsIndexHit>, StopReason), OsIndexError> {
    gather_with(LocatePrograms::system(), request, cancel)
}

pub fn gather_with(
    programs: LocatePrograms<'_>,
    request: &OsIndexRequest,
    cancel: &AtomicBool,
) -> Result<(Vec<RawOsIndexHit>, StopReason), OsIndexError> {
    let deadline_at = Instant::now() + request.deadline();
    let exclusions = Exclusions::embedded()?;
    let args = locate_args(request.query())?;
    let mut rows = LocateRows::new(request, exclusions);
    let end = match run_streaming(programs.plocate, &args, cancel, deadline_at, |chunk| {
        rows.feed(chunk)
    }) {
        Ok(end) => end,
        Err(SpawnError::Failed) => return Err(OsIndexError::Unavailable),
        Err(SpawnError::Missing) => match probe_locate(programs.locate, cancel, deadline_at)? {
            Probe::Compatible => {
                run_streaming(programs.locate, &args, cancel, deadline_at, |chunk| {
                    rows.feed(chunk)
                })
                .map_err(|_| OsIndexError::Unavailable)?
            }
            Probe::Stopped(reason) => RunEnd::Stopped(reason),
        },
    };
    let stop = match end {
        RunEnd::Stopped(reason) => reason,
        RunEnd::Exited {
            code,
            stderr_written,
        } => {
            classify_exit(code, stderr_written, rows.records())?;
            if rows.records() >= LOCATE_RECORD_LIMIT {
                StopReason::Limit
            } else {
                StopReason::Complete
            }
        }
    };
    Ok((rows.into_rows(), stop))
}

enum Probe {
    Compatible,
    Stopped(StopReason),
}

/// Accepts the fallback `locate` only when `--version` names an implementation whose options
/// and output match `plocate`'s. A missing or unknown `locate` makes the index unavailable.
fn probe_locate(
    program: &OsStr,
    cancel: &AtomicBool,
    deadline_at: Instant,
) -> Result<Probe, OsIndexError> {
    let mut version = Vec::new();
    let end = run_streaming(
        program,
        &["--version".to_owned()],
        cancel,
        deadline_at,
        |chunk| {
            let room = MAX_VERSION_BYTES.saturating_sub(version.len());
            version.extend(chunk.iter().take(room));
            version.len() < MAX_VERSION_BYTES
        },
    )
    .map_err(|_| OsIndexError::Unavailable)?;
    match end {
        RunEnd::Stopped(reason @ (StopReason::Cancelled | StopReason::Deadline)) => {
            Ok(Probe::Stopped(reason))
        }
        RunEnd::Exited { code: Some(0), .. }
            if is_compatible_locate(&String::from_utf8_lossy(&version)) =>
        {
            Ok(Probe::Compatible)
        }
        RunEnd::Exited { .. } | RunEnd::Stopped(_) => Err(OsIndexError::Unavailable),
    }
}
