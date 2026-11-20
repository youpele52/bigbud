//! Windows Search adapter (`SystemIndex` through the `Search.CollatorDSO` OLE DB provider).
//!
//! The provider's `ICommand::Execute` blocks and cannot be relied on to cancel, so the query runs
//! on a bounded worker thread that owns its COM apartment and every COM object. The caller polls
//! the cancel flag and the deadline every [`super::stop::POLL_INTERVAL`] and returns as soon as either fires;
//! an abandoned worker sees its abandon flag between row batches, its command carries a timeout,
//! and at most [`MAX_LIVE_WORKERS`] can exist at once. Nothing here logs the query or any result.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Instant;

use super::error::OsIndexError;
use super::request::{OS_INDEX_FETCH_LIMIT, OsIndexRequest};
use super::results::RawOsIndexHit;
use super::stop::{check_stop, next_wait};
use super::windows_sql::name_query_sql;
use super::winpath::align_to_scopes;
use crate::search::StopReason;

#[path = "windows_search.oledb.rs"]
mod oledb;
#[path = "windows_search.rows.rs"]
mod rows;

/// Query workers alive at once, abandoned ones included (the OS-index registry has two slots).
const MAX_LIVE_WORKERS: usize = 2;

static LIVE_WORKERS: AtomicUsize = AtomicUsize::new(0);

/// Runs the name query and returns the raw rows plus how gathering ended.
pub(super) fn gather(
    request: &OsIndexRequest,
    cancel: &AtomicBool,
) -> Result<(Vec<RawOsIndexHit>, StopReason), OsIndexError> {
    let deadline_at = Instant::now() + request.deadline();
    let scopes: Vec<&str> = request
        .scopes()
        .iter()
        .map(|scope| scope.to_str().ok_or(OsIndexError::InvalidScope))
        .collect::<Result<_, _>>()?;
    let sql = name_query_sql(request.query(), &scopes, OS_INDEX_FETCH_LIMIT)?;
    // A request that is already over never starts a worker.
    if let Some(stop) = check_stop(cancel, deadline_at) {
        return Ok((Vec::new(), stop));
    }
    let slot = WorkerSlot::acquire().ok_or(OsIndexError::Unavailable)?;
    let abandon = Arc::new(AtomicBool::new(false));
    let worker_abandon = Arc::clone(&abandon);
    let timeout = request.deadline();
    let (sender, receiver) = mpsc::sync_channel(1);
    let worker = std::thread::Builder::new()
        .name("bigbud-os-index-windows-search".to_owned())
        .spawn(move || {
            let _slot = slot;
            let result = oledb::query_rows(&sql, timeout, &worker_abandon);
            // The caller may have stopped waiting; then the rows are simply dropped.
            let _delivered = sender.send(result);
        })
        .map_err(|_| OsIndexError::Unavailable)?;
    let result = loop {
        if let Some(stop) = check_stop(cancel, deadline_at) {
            // The worker finishes on its own (bounded by the command timeout and the abandon
            // flag) and releases its slot; its handle is dropped, which detaches it.
            abandon.store(true, Ordering::Relaxed);
            return Ok((Vec::new(), stop));
        }
        match receiver.recv_timeout(next_wait(deadline_at)) {
            Ok(result) => break result,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // The worker ended without sending: it panicked.
            Err(mpsc::RecvTimeoutError::Disconnected) => break Err(OsIndexError::Unavailable),
        }
    };
    // The worker has sent (or died); joining returns at once.
    if worker.join().is_err() {
        return Err(OsIndexError::Unavailable);
    }
    let rows = result?
        .into_iter()
        .map(|mut row| {
            if let Some(aligned) = align_to_scopes(&row.path, &scopes) {
                row.path = aligned;
            }
            row
        })
        .collect::<Vec<_>>();
    let stop = if rows.len() >= OS_INDEX_FETCH_LIMIT {
        StopReason::Limit
    } else {
        StopReason::Complete
    };
    Ok((rows, stop))
}

/// One of the [`MAX_LIVE_WORKERS`] worker slots, released on drop.
struct WorkerSlot;

impl WorkerSlot {
    fn acquire() -> Option<Self> {
        LIVE_WORKERS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |live| {
                (live < MAX_LIVE_WORKERS).then_some(live + 1)
            })
            .ok()
            .map(|_previous| Self)
    }
}

impl Drop for WorkerSlot {
    fn drop(&mut self) {
        // The previous count is not needed; `acquire` is the only reader of the counter.
        let _previous = LIVE_WORKERS.fetch_sub(1, Ordering::AcqRel);
    }
}
