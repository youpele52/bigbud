//! Spotlight adapter (`MDQuery`, CoreServices). The query runs in asynchronous static mode on
//! the calling thread's run loop, which is pumped in short slices so the cancel flag and the
//! deadline are checked every [`POLL_INTERVAL`]. Stopping always goes through `MDQueryStop`,
//! which leaves the rows gathered so far readable and static.
//!
//! Call it from a dedicated worker thread that owns no other run-loop sources (never the main
//! thread of a GUI process). Nothing here logs the query or any result.

use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use objc2_core_foundation::{
    CFArray, CFDate, CFIndex, CFNumber, CFRetained, CFRunLoop, CFRunLoopRunResult, CFString,
    CFType, kCFRunLoopDefaultMode,
};
use objc2_core_services::{
    MDItem, MDQuery, kMDItemContentType, kMDItemFSContentChangeDate, kMDItemFSSize,
    kMDItemLastUsedDate, kMDItemPath,
};

use super::error::OsIndexError;
use super::predicate::name_predicate;
use super::request::{OS_INDEX_FETCH_LIMIT, OsIndexRequest};
use super::results::RawOsIndexHit;
use crate::search::StopReason;

/// Longest gap between cancel and deadline checks (the plan's cancel budget is 50 ms).
const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// `MDQuerySetMaxCount` argument. 200 always fits in `CFIndex` (`isize`).
const FETCH_LIMIT: CFIndex = OS_INDEX_FETCH_LIMIT as CFIndex;
/// Uniform type identifier Spotlight reports for folders.
const FOLDER_CONTENT_TYPE: &str = "public.folder";

/// Runs the name query and returns the raw rows plus how gathering ended.
pub(super) fn gather(
    request: &OsIndexRequest,
    cancel: &AtomicBool,
) -> Result<(Vec<RawOsIndexHit>, StopReason), OsIndexError> {
    let deadline_at = Instant::now() + request.deadline();
    let predicate = CFString::from_str(&name_predicate(request.query())?);
    // SAFETY: a NULL allocator selects the default allocator and NULL value-list and sorting
    // arrays are documented as "no value lists" and "no sorting"; the query string is a live
    // CFString. MDQueryCreate returns NULL for invalid syntax, which maps to `QueryRejected`.
    let query = unsafe { MDQuery::new(None, Some(&predicate), None, None) }
        .ok_or(OsIndexError::QueryRejected)?;
    let scopes: Vec<CFRetained<CFString>> = request
        .scopes()
        .iter()
        .filter_map(|scope| scope.to_str())
        .map(CFString::from_str)
        .collect();
    let scopes = CFArray::from_retained_objects(&scopes);
    // SAFETY: the scope array holds only CFStrings (folder paths), as MDQuerySetSearchScope
    // requires; options must be 0; the query has not been executed yet.
    unsafe { query.set_search_scope(Some(scopes.as_opaque()), 0) };
    // SAFETY: called before MDQueryExecute, as required; the count is positive.
    unsafe { query.set_max_count(FETCH_LIMIT) };
    // SAFETY: option flags 0 select an asynchronous static query (no live updates). Results are
    // delivered through this thread's run loop, which `run_until_settled` pumps.
    if !unsafe { query.execute(0) } {
        return Err(OsIndexError::Unavailable);
    }
    let stop = run_until_settled(&query, cancel, deadline_at);
    // SAFETY: MDQueryStop is valid after execution, also once gathering has finished; afterwards
    // the result list is static, so the reads below cannot race with result updates.
    unsafe { query.stop() };
    let rows = read_rows(&query);
    let stop = match stop {
        StopReason::Complete if rows.len() >= OS_INDEX_FETCH_LIMIT => StopReason::Limit,
        other => other,
    };
    Ok((rows, stop))
}

fn run_until_settled(query: &MDQuery, cancel: &AtomicBool, deadline_at: Instant) -> StopReason {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return StopReason::Cancelled;
        }
        // SAFETY: the query was executed on this thread and is alive for the whole call.
        if unsafe { query.is_gathering_complete() } {
            return StopReason::Complete;
        }
        let remaining = deadline_at.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return StopReason::Deadline;
        }
        let slice = remaining.min(POLL_INTERVAL);
        // SAFETY: `kCFRunLoopDefaultMode` is an immutable CoreFoundation constant.
        let mode = unsafe { kCFRunLoopDefaultMode };
        // `Finished` means the run loop had no sources at all; sleep instead of spinning.
        if CFRunLoop::run_in_mode(mode, slice.as_secs_f64(), false) == CFRunLoopRunResult::Finished
        {
            std::thread::sleep(slice);
        }
    }
}

fn read_rows(query: &MDQuery) -> Vec<RawOsIndexHit> {
    // SAFETY: the query is stopped, so the count is stable.
    let count = unsafe { query.result_count() };
    // A negative count is impossible; treating it as "no rows" can only return fewer rows.
    let count = usize::try_from(count).map_or(0, |count| count.min(OS_INDEX_FETCH_LIMIT));
    let names = attribute_names();
    let mut rows = Vec::with_capacity(count);
    for index in 0..count {
        let Ok(index) = CFIndex::try_from(index) else {
            break;
        };
        // SAFETY: `0 <= index < result_count` on a stopped (static) query. With no custom
        // create-result function the result is an MDItemRef owned by the query.
        let item = unsafe { query.result_at_index(index) };
        let Some(item) = NonNull::new(item.cast_mut()) else {
            continue;
        };
        // SAFETY: the pointer is a non-null MDItemRef owned by `query`, which outlives this
        // borrow; the item is only read.
        let item = unsafe { item.cast::<MDItem>().as_ref() };
        if let Some(row) = read_row(item, &names) {
            rows.push(row);
        }
    }
    rows
}

/// The MDItem attribute names read for every row.
struct AttributeNames {
    path: Option<&'static CFString>,
    content_type: Option<&'static CFString>,
    size: Option<&'static CFString>,
    modified: Option<&'static CFString>,
    last_used: Option<&'static CFString>,
}

fn attribute_names() -> AttributeNames {
    // SAFETY: the `kMDItem*` names are immutable CoreServices constants, initialised when the
    // framework loads and never written afterwards.
    unsafe {
        AttributeNames {
            path: kMDItemPath,
            content_type: kMDItemContentType,
            size: kMDItemFSSize,
            modified: kMDItemFSContentChangeDate,
            last_used: kMDItemLastUsedDate,
        }
    }
}

fn read_row(item: &MDItem, names: &AttributeNames) -> Option<RawOsIndexHit> {
    let path = string_attribute(item, names.path)?;
    // A missing type only means "unknown", which the palette shows as a plain file.
    let content_type = string_attribute(item, names.content_type).unwrap_or_default();
    Some(RawOsIndexHit {
        path,
        is_directory: content_type == FOLDER_CONTENT_TYPE,
        content_type,
        // Missing or negative sizes and dates are reported as 0 ("unknown").
        size_bytes: number_attribute(item, names.size).unwrap_or(0),
        modified_unix_ms: date_attribute(item, names.modified).unwrap_or(0),
        last_used_unix_ms: date_attribute(item, names.last_used).unwrap_or(0),
    })
}

fn attribute(item: &MDItem, name: Option<&'static CFString>) -> Option<CFRetained<CFType>> {
    let name = name?;
    // SAFETY: `name` is a valid attribute-name CFString and `item` a live MDItem; the binding
    // takes ownership of the copied (+1) value.
    unsafe { item.attribute(Some(name)) }
}

fn string_attribute(item: &MDItem, name: Option<&'static CFString>) -> Option<String> {
    let value = attribute(item, name)?.downcast::<CFString>().ok()?;
    Some(value.to_string())
}

fn number_attribute(item: &MDItem, name: Option<&'static CFString>) -> Option<u64> {
    let value = attribute(item, name)?.downcast::<CFNumber>().ok()?;
    u64::try_from(value.as_i64()?).ok()
}

fn date_attribute(item: &MDItem, name: Option<&'static CFString>) -> Option<u64> {
    let value = attribute(item, name)?.downcast::<CFDate>().ok()?;
    let since_epoch = value.to_system_time()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since_epoch.as_millis()).ok()
}
