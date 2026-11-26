//! Spotlight adapter (`MDQuery`, CoreServices). The query runs in asynchronous static mode on
//! the calling thread's run loop, which is pumped in short slices so the cancel flag and the
//! deadline are checked every [`POLL_INTERVAL`]. Stopping always goes through `MDQueryStop`,
//! which leaves the rows gathered so far readable and static.
//!
//! Call it from a dedicated worker thread that owns no other run-loop sources (never the main
//! thread of a GUI process). Nothing here logs the query or any result.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use objc2_core_foundation::{
    CFArray, CFDate, CFIndex, CFNumber, CFRetained, CFRunLoop, CFRunLoopRunResult, CFString,
    CFType, kCFRunLoopDefaultMode,
};
use objc2_core_services::{
    MDItem, MDQuery, MDQuerySortOptionFlags, kMDItemContentModificationDate, kMDItemContentType,
    kMDItemFSSize, kMDItemLastUsedDate, kMDItemPath,
};

use super::error::OsIndexError;
use super::exclusions::Exclusions;
use super::predicate::name_predicate;
use super::request::{OS_INDEX_FETCH_LIMIT, OsIndexRequest};
use super::results::{RawOsIndexHit, select_top_paths};
use crate::search::StopReason;

/// Longest gap between cancel and deadline checks (the plan's cancel budget is 50 ms).
const POLL_INTERVAL: Duration = Duration::from_millis(10);
/// `MDQuerySetMaxCount` argument: matches Spotlight gathers. Only their paths are read (from the
/// query's own value cache); the best [`OS_INDEX_FETCH_LIMIT`] by name are read in full. Fits in
/// `CFIndex` (`isize`).
pub(super) const RAW_FETCH_LIMIT: usize = 2_000;
/// Uniform type identifier Spotlight reports for folders.
const FOLDER_CONTENT_TYPE: &str = "public.folder";

/// Runs the name query and returns the raw rows plus how gathering ended.
///
/// Spotlight sorts the matches by last used, then content modified (newest first), and gathers
/// path, type and size with them, so reading a value costs no extra call per item. Paths are read
/// first; rows outside the scopes or on the exclusion list are dropped and the rest ranked by name
/// before any other attribute is read.
pub(super) fn gather(
    request: &OsIndexRequest,
    cancel: &AtomicBool,
) -> Result<(Vec<RawOsIndexHit>, StopReason), OsIndexError> {
    let exclusions = Exclusions::embedded()?;
    let deadline_at = Instant::now() + request.deadline();
    let predicate = CFString::from_str(&name_predicate(request.query())?);
    let names = attribute_names();
    let value_list = attribute_array(&[names.path, names.content_type, names.size]);
    let sorting = attribute_array(&[names.last_used, names.modified]);
    // SAFETY: a NULL allocator selects the default allocator; the value-list and sorting arrays
    // hold only attribute-name CFStrings; the query string is a live CFString. MDQueryCreate
    // returns NULL for invalid syntax, which maps to `QueryRejected`.
    let query = unsafe {
        MDQuery::new(
            None,
            Some(&predicate),
            Some(value_list.as_opaque()),
            Some(sorting.as_opaque()),
        )
    }
    .ok_or(OsIndexError::QueryRejected)?;
    for name in [names.last_used, names.modified].into_iter().flatten() {
        // SAFETY: `name` is one of the query's sorting attributes; set before execution.
        unsafe {
            query.set_sort_option_flags_for_attribute(
                Some(name),
                MDQuerySortOptionFlags::ReverseSortOrderFlag.0,
            )
        };
    }
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
    // SAFETY: called before MDQueryExecute, as required; the count is positive and fits.
    unsafe { query.set_max_count(RAW_FETCH_LIMIT as CFIndex) };
    // SAFETY: option flags 0 select an asynchronous static query (no live updates). Results are
    // delivered through this thread's run loop, which `run_until_settled` pumps.
    if !unsafe { query.execute(0) } {
        return Err(OsIndexError::Unavailable);
    }
    let stop = run_until_settled(&query, cancel, deadline_at);
    // SAFETY: MDQueryStop is valid after execution, also once gathering has finished; afterwards
    // the result list is static, so the reads below cannot race with result updates.
    unsafe { query.stop() };
    // SAFETY: the query is stopped, so the count is stable. A negative count reads as none.
    let count = usize::try_from(unsafe { query.result_count() })
        .map_or(0, |count| count.min(RAW_FETCH_LIMIT));
    let paths: Vec<Option<String>> = (0..count)
        .map(|index| item_path(&query, names.path, index))
        .collect();
    let selected = select_top_paths(request, exclusions, &paths, OS_INDEX_FETCH_LIMIT);
    let rows = selected
        .into_iter()
        .filter_map(|index| read_row(&query, &names, index, paths.get(index)?.clone()?))
        .collect();
    let stop = match stop {
        StopReason::Complete if count >= RAW_FETCH_LIMIT => StopReason::Limit,
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

/// The attribute names the query gathers and sorts by.
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
            modified: kMDItemContentModificationDate,
            last_used: kMDItemLastUsedDate,
        }
    }
}

fn attribute_array(names: &[Option<&'static CFString>]) -> CFRetained<CFArray<CFString>> {
    let names: Vec<&CFString> = names.iter().flatten().copied().collect();
    CFArray::from_objects(&names)
}

fn read_row(
    query: &MDQuery,
    names: &AttributeNames,
    index: usize,
    path: String,
) -> Option<RawOsIndexHit> {
    // A missing type only means "unknown", which the palette shows as a plain file.
    let content_type = string_value(query, names.content_type, index).unwrap_or_default();
    Some(RawOsIndexHit {
        path,
        is_directory: content_type == FOLDER_CONTENT_TYPE,
        content_type,
        // Missing or negative sizes and dates are reported as 0 ("unknown").
        size_bytes: number_value(query, names.size, index).unwrap_or(0),
        modified_unix_ms: date_value(query, names.modified, index).unwrap_or(0),
        last_used_unix_ms: date_value(query, names.last_used, index).unwrap_or(0),
    })
}

/// A gathered value of `name` for result `index`, retained so it outlives the query's cache.
fn value(
    query: &MDQuery,
    name: Option<&'static CFString>,
    index: usize,
) -> Option<CFRetained<CFType>> {
    let name = name?;
    let index = CFIndex::try_from(index).ok()?;
    // SAFETY: the query is stopped and `index < result_count`; `name` is a value-list or sorting
    // attribute of this query. The value is borrowed from the query (Get rule), so it is retained
    // before use; NULL means the result has no such value.
    let raw = unsafe { query.attribute_value_of_result_at_index(Some(name), index) };
    let raw = std::ptr::NonNull::new(raw.cast::<CFType>())?;
    // SAFETY: a non-null CFTypeRef owned by the query, which is alive here.
    Some(unsafe { CFRetained::retain(raw) })
}

/// The result's path. Spotlight computes it per item rather than gathering it with the
/// value-list attributes, so it is the one attribute read from the MDItem.
fn item_path(query: &MDQuery, name: Option<&'static CFString>, index: usize) -> Option<String> {
    let index = CFIndex::try_from(index).ok()?;
    // SAFETY: `0 <= index < result_count` on a stopped (static) query. With no custom
    // create-result function the result is an MDItemRef owned by the query.
    let item = unsafe { query.result_at_index(index) };
    let item = std::ptr::NonNull::new(item.cast_mut())?;
    // SAFETY: a non-null MDItemRef owned by `query`, which outlives this borrow; only read.
    let item = unsafe { item.cast::<MDItem>().as_ref() };
    // SAFETY: `name` is a valid attribute-name CFString; the binding owns the copied value.
    let value = unsafe { item.attribute(Some(name?)) }?;
    Some(value.downcast::<CFString>().ok()?.to_string())
}

fn string_value(query: &MDQuery, name: Option<&'static CFString>, index: usize) -> Option<String> {
    Some(
        value(query, name, index)?
            .downcast::<CFString>()
            .ok()?
            .to_string(),
    )
}

fn number_value(query: &MDQuery, name: Option<&'static CFString>, index: usize) -> Option<u64> {
    let value = value(query, name, index)?.downcast::<CFNumber>().ok()?;
    u64::try_from(value.as_i64()?).ok()
}

fn date_value(query: &MDQuery, name: Option<&'static CFString>, index: usize) -> Option<u64> {
    let value = value(query, name, index)?.downcast::<CFDate>().ok()?;
    let since_epoch = value.to_system_time()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since_epoch.as_millis()).ok()
}
