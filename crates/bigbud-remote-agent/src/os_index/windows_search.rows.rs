//! Reads a Windows Search rowset through one OLE DB accessor into fixed, client-owned buffers
//! (no provider-allocated memory to free). Runs on the worker thread inside its COM apartment.

use std::mem::{ManuallyDrop, offset_of, size_of};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::System::Search::{
    DBACCESSOR_ROWDATA, DBBINDING, DBMEMOWNER_CLIENTOWNED, DBPARAMIO_NOTPARAM, DBPART_LENGTH,
    DBPART_STATUS, DBPART_VALUE, DBSTATUS_S_OK, DBTYPE_FILETIME, DBTYPE_UI4, DBTYPE_UI8,
    DBTYPE_WSTR, HACCESSOR, IAccessor, IRowset,
};
use windows::core::Interface;

use super::super::error::OsIndexError;
use super::super::request::OS_INDEX_FETCH_LIMIT;
use super::super::results::RawOsIndexHit;
use super::oledb::unavailable;

/// Rows fetched per `GetNextRows` call.
const ROW_BATCH: usize = 50;
/// UTF-16 units reserved for a path, terminator included; longer paths come back truncated and
/// are skipped.
const PATH_UNITS: usize = 4096;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
/// Milliseconds from 1601-01-01 (the FILETIME epoch) to 1970-01-01.
const FILETIME_UNIX_EPOCH_MS: u64 = 11_644_473_600_000;

/// One row as the accessor writes it. Statuses are `DBSTATUS` values; the path length is in
/// bytes without the terminator.
#[repr(C)]
struct RowBuffer {
    path_length: usize,
    path_status: u32,
    size_status: u32,
    modified_status: u32,
    attributes_status: u32,
    size: u64,
    /// FILETIME (100 ns ticks since 1601) as one integer.
    modified: u64,
    attributes: u32,
    path: [u16; PATH_UNITS],
}

impl RowBuffer {
    fn new() -> Box<Self> {
        Box::new(Self {
            path_length: 0,
            path_status: 0,
            size_status: 0,
            modified_status: 0,
            attributes_status: 0,
            size: 0,
            modified: 0,
            attributes: 0,
            path: [0; PATH_UNITS],
        })
    }
}

/// An accessor handle, released before its rowset.
struct Accessor {
    accessor: IAccessor,
    handle: HACCESSOR,
}

impl Drop for Accessor {
    fn drop(&mut self) {
        // SAFETY: the handle was created by this accessor and is released exactly once. A failed
        // release cannot be acted on here; the rowset that owns it is released right after.
        let _released = unsafe { self.accessor.ReleaseAccessor(self.handle, None) };
    }
}

/// A client-owned binding for column `ordinal` (1-based, in `SELECTED_COLUMNS` order: path as
/// UTF-16 text, size as `u64`, modification time as FILETIME, attributes as `u32`) at the given
/// `RowBuffer` offsets.
fn binding(ordinal: usize, value: usize, status: usize, length: Option<usize>) -> DBBINDING {
    let (kind, max_bytes) = match ordinal {
        1 => (DBTYPE_WSTR.0, PATH_UNITS * size_of::<u16>()),
        2 => (DBTYPE_UI8.0, size_of::<u64>()),
        3 => (DBTYPE_FILETIME.0, size_of::<u64>()),
        _ => (DBTYPE_UI4.0, size_of::<u32>()),
    };
    let length_part = length.map_or(0, |_| DBPART_LENGTH.0);
    DBBINDING {
        iOrdinal: ordinal,
        obValue: value,
        obLength: length.unwrap_or(0),
        obStatus: status,
        pTypeInfo: ManuallyDrop::new(None),
        pObject: null_mut(),
        pBindExt: null_mut(),
        dwPart: (DBPART_VALUE.0 | DBPART_STATUS.0 | length_part) as u32,
        dwMemOwner: DBMEMOWNER_CLIENTOWNED.0 as u32,
        eParamIO: DBPARAMIO_NOTPARAM.0 as u32,
        cbMaxLen: max_bytes,
        dwFlags: 0,
        wType: kind as u16,
        bPrecision: 0,
        bScale: 0,
    }
}

fn create_accessor(rowset: &IRowset) -> Result<Accessor, OsIndexError> {
    // Ordinals follow `SELECTED_COLUMNS`: path, size, modified, attributes.
    let bindings = [
        binding(
            1,
            offset_of!(RowBuffer, path),
            offset_of!(RowBuffer, path_status),
            Some(offset_of!(RowBuffer, path_length)),
        ),
        binding(
            2,
            offset_of!(RowBuffer, size),
            offset_of!(RowBuffer, size_status),
            None,
        ),
        binding(
            3,
            offset_of!(RowBuffer, modified),
            offset_of!(RowBuffer, modified_status),
            None,
        ),
        binding(
            4,
            offset_of!(RowBuffer, attributes),
            offset_of!(RowBuffer, attributes_status),
            None,
        ),
    ];
    let accessor: IAccessor = rowset.cast().map_err(unavailable)?;
    let mut handle = HACCESSOR(0);
    let mut statuses = [0_u32; 4];
    // SAFETY: each binding describes a field of `RowBuffer` with a size that fits it, and the
    // row size is `RowBuffer`'s size; the bindings, `handle` and `statuses` outlive the call.
    unsafe {
        accessor.CreateAccessor(
            DBACCESSOR_ROWDATA.0 as u32,
            bindings.len(),
            bindings.as_ptr(),
            size_of::<RowBuffer>(),
            &raw mut handle,
            Some(statuses.as_mut_ptr()),
        )
    }
    .map_err(unavailable)?;
    Ok(Accessor { accessor, handle })
}

pub(super) fn read_rows(
    rowset: &IRowset,
    abandon: &AtomicBool,
) -> Result<Vec<RawOsIndexHit>, OsIndexError> {
    let accessor = create_accessor(rowset)?;
    let mut buffer = RowBuffer::new();
    let mut rows = Vec::new();
    while rows.len() < OS_INDEX_FETCH_LIMIT && !abandon.load(Ordering::Relaxed) {
        let mut handles = [0_usize; ROW_BATCH];
        // `windows-rs` passes this array's length as `cRows` and its address as `prghRows`
        // (`HROW**`); its first element points at the consumer-allocated `handles`.
        let mut handle_array: [*mut usize; ROW_BATCH] = [null_mut(); ROW_BATCH];
        if let Some(first) = handle_array.first_mut() {
            *first = handles.as_mut_ptr();
        }
        let mut obtained = 0_usize;
        // SAFETY: `*prghRows` is non-null, so the provider fills `handles` (room for `cRows`
        // handles) instead of allocating; `obtained` outlives the call.
        let fetched = unsafe { rowset.GetNextRows(0, 0, &raw mut obtained, &mut handle_array) };
        let obtained = obtained.min(ROW_BATCH);
        for &row in handles.iter().take(obtained) {
            buffer.path_status = u32::MAX;
            // SAFETY: `row` is a live handle from `GetNextRows`, the accessor belongs to this
            // rowset, and its bindings fit inside `buffer`, which is exclusively borrowed.
            let read = unsafe { rowset.GetData(row, accessor.handle, (&raw mut *buffer).cast()) };
            // A row that cannot be read is skipped; that can only return fewer rows.
            if read.is_ok()
                && let Some(hit) = row_from_buffer(&buffer)
            {
                rows.push(hit);
            }
        }
        // SAFETY: releases exactly the `obtained` handles returned above, once; the optional
        // output arrays are null.
        let released = unsafe {
            rowset.ReleaseRows(obtained, handles.as_ptr(), null(), null_mut(), null_mut())
        };
        fetched.map_err(unavailable)?;
        released.map_err(unavailable)?;
        // Fewer rows than asked for means `DB_S_ENDOFROWSET`.
        if obtained < ROW_BATCH {
            break;
        }
    }
    rows.truncate(OS_INDEX_FETCH_LIMIT);
    Ok(rows)
}

fn row_from_buffer(buffer: &RowBuffer) -> Option<RawOsIndexHit> {
    let known = |status: u32| status == DBSTATUS_S_OK.0 as u32;
    // A null or truncated path cannot be shown or opened.
    if !known(buffer.path_status) {
        return None;
    }
    let units = buffer.path.get(..buffer.path_length / size_of::<u16>())?;
    let path = String::from_utf16(units).ok()?;
    let attributes = known(buffer.attributes_status).then_some(buffer.attributes);
    Some(RawOsIndexHit {
        path,
        is_directory: attributes.is_some_and(|value| value & FILE_ATTRIBUTE_DIRECTORY != 0),
        content_type: String::new(),
        // Unknown sizes and times are reported as 0.
        size_bytes: if known(buffer.size_status) {
            buffer.size
        } else {
            0
        },
        modified_unix_ms: known(buffer.modified_status)
            .then(|| filetime_to_unix_ms(buffer.modified))
            .flatten()
            .unwrap_or(0),
        // Windows Search has no reliable "last used" for files; access times are often off.
        last_used_unix_ms: 0,
    })
}

/// FILETIME ticks to Unix milliseconds; `None` before 1970.
fn filetime_to_unix_ms(ticks: u64) -> Option<u64> {
    (ticks / 10_000).checked_sub(FILETIME_UNIX_EPOCH_MS)
}
