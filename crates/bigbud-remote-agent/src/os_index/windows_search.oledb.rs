//! OLE DB plumbing for the Windows Search worker thread. Everything here runs on that thread
//! inside its own multithreaded COM apartment; every COM object is a local released (by
//! `windows-rs`) before the apartment is left. No UI is shown: the provider is opened from a
//! connection string, never through a data-link prompt.

use std::mem::ManuallyDrop;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use windows::Win32::Storage::IndexServer::DBID;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED, CoCreateInstance,
    CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::Search::{
    CSearchManager, DB_E_ERRORSINCOMMAND, DBPROP, DBPROP_COMMANDTIMEOUT, DBPROPOPTIONS_OPTIONAL,
    DBPROPSET, ICommandProperties, ICommandText, IDBCreateCommand, IDBCreateSession, IDBInitialize,
    IDataInitialize, IRowset, ISearchManager, MSDAINITIALIZE,
};
use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_I4};
use windows::core::{GUID, HSTRING, IUnknown, Interface, PCWSTR, w};

use super::super::error::OsIndexError;
use super::super::results::RawOsIndexHit;
use super::rows::read_rows;

/// `DBGUID_DEFAULT` (oledb.h): the provider's default SQL dialect.
const DBGUID_DEFAULT: GUID = GUID::from_u128(0xc8b521fb_5cf3_11ce_ade5_00aa0044773d);
/// `DBPROPSET_ROWSET` (oledb.h), which holds `DBPROP_COMMANDTIMEOUT`.
const DBPROPSET_ROWSET: GUID = GUID::from_u128(0xc8b522be_5cf3_11ce_ade5_00aa0044773d);
/// The connection string `ISearchQueryHelper::get_ConnectionString` reports.
const CONNECTION_STRING: PCWSTR =
    w!("Provider=Search.CollatorDSO;Extended Properties=\"Application=Windows\"");

/// Runs `sql` against `SystemIndex` and returns at most [`OS_INDEX_FETCH_LIMIT`] rows. Stops
/// between row batches once `abandon` is set.
pub fn query_rows(
    sql: &str,
    timeout: Duration,
    abandon: &AtomicBool,
) -> Result<Vec<RawOsIndexHit>, OsIndexError> {
    let _apartment = ComApartment::enter()?;
    // Every COM object lives inside this call, so all are released before the apartment ends.
    query_in_apartment(sql, timeout, abandon)
}

/// A multithreaded COM apartment on the current thread, left on drop.
struct ComApartment;

impl ComApartment {
    fn enter() -> Result<Self, OsIndexError> {
        // SAFETY: the worker thread is fresh and owned by this adapter. Only a successful
        // result (S_OK or S_FALSE) is balanced by `CoUninitialize` in `Drop`.
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result.is_ok() {
            Ok(Self)
        } else {
            Err(OsIndexError::Unavailable)
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        // SAFETY: balances the successful `CoInitializeEx` on this same thread; the COM objects
        // created in the apartment were locals of `query_in_apartment`, already released.
        unsafe { CoUninitialize() };
    }
}

/// The open provider objects. Fields drop in declaration order: command, session, source.
struct Connection {
    command: ICommandText,
    _session: IUnknown,
    _source: IDBInitialize,
}

pub(super) fn unavailable(_error: windows::core::Error) -> OsIndexError {
    OsIndexError::Unavailable
}

fn query_in_apartment(
    sql: &str,
    timeout: Duration,
    abandon: &AtomicBool,
) -> Result<Vec<RawOsIndexHit>, OsIndexError> {
    ensure_index_running()?;
    let connection = open_connection(timeout)?;
    let text = HSTRING::from(sql);
    // SAFETY: the command is live; the dialect GUID and the NUL-terminated text outlive the
    // call, and the provider copies the text.
    unsafe { connection.command.SetCommandText(&DBGUID_DEFAULT, &text) }
        .map_err(|_| OsIndexError::QueryRejected)?;
    let mut rowset: Option<IUnknown> = None;
    // SAFETY: no aggregation and no parameters; `rowset` receives an owned IRowset pointer that
    // `windows-rs` releases on drop, before `connection`.
    unsafe {
        connection
            .command
            .Execute(None, &IRowset::IID, None, None, Some(&raw mut rowset))
    }
    .map_err(|error| match error.code() {
        DB_E_ERRORSINCOMMAND => OsIndexError::QueryRejected,
        _ => OsIndexError::Unavailable,
    })?;
    let rowset: IRowset = rowset
        .ok_or(OsIndexError::Unavailable)?
        .cast()
        .map_err(unavailable)?;
    read_rows(&rowset, abandon)
}

/// Activating the search manager starts or reaches the Windows Search service; it fails when the
/// service is stopped or disabled, which is reported as "unavailable".
fn ensure_index_running() -> Result<(), OsIndexError> {
    // SAFETY: COM is initialised on this thread; `CSearchManager` is the documented class for
    // `ISearchManager`, served out of process by the Windows Search service.
    let manager: ISearchManager =
        unsafe { CoCreateInstance(&CSearchManager, None, CLSCTX_LOCAL_SERVER) }
            .map_err(unavailable)?;
    // SAFETY: the manager is live and the catalog name is a static NUL-terminated string.
    let _catalog = unsafe { manager.GetCatalog(w!("SystemIndex")) }.map_err(unavailable)?;
    Ok(())
}

fn open_connection(timeout: Duration) -> Result<Connection, OsIndexError> {
    // SAFETY: COM is initialised; `MSDAINITIALIZE` is the OLE DB service component's
    // in-process class implementing `IDataInitialize`.
    let initializer: IDataInitialize =
        unsafe { CoCreateInstance(&MSDAINITIALIZE, None, CLSCTX_INPROC_SERVER) }
            .map_err(unavailable)?;
    let mut source: Option<IUnknown> = None;
    // SAFETY: no aggregation; the connection string is a static NUL-terminated string and
    // `source` receives an owned pointer.
    unsafe {
        initializer.GetDataSource(
            None,
            CLSCTX_INPROC_SERVER.0,
            CONNECTION_STRING,
            &IDBInitialize::IID,
            &raw mut source,
        )
    }
    .map_err(unavailable)?;
    let source: IDBInitialize = source
        .ok_or(OsIndexError::Unavailable)?
        .cast()
        .map_err(unavailable)?;
    // SAFETY: the data source was just created and is not initialised yet.
    unsafe { source.Initialize() }.map_err(unavailable)?;
    let session_factory: IDBCreateSession = source.cast().map_err(unavailable)?;
    // SAFETY: the data source is initialised; no aggregation; the session is returned owned.
    let session = unsafe { session_factory.CreateSession(None, &IDBCreateCommand::IID) }
        .map_err(unavailable)?;
    let command_factory: IDBCreateCommand = session.cast().map_err(unavailable)?;
    // SAFETY: the session is live; no aggregation; the command is returned owned.
    let command: ICommandText = unsafe { command_factory.CreateCommand(None, &ICommandText::IID) }
        .map_err(unavailable)?
        .cast()
        .map_err(unavailable)?;
    set_command_timeout(&command, timeout);
    Ok(Connection {
        command,
        _session: session,
        _source: source,
    })
}

/// Asks the provider to give up after `timeout` (whole seconds, rounded up). The property is
/// optional on purpose: a provider that ignores it leaves the worker bounded by the abandon flag
/// and the worker cap, and the caller has already stopped waiting.
fn set_command_timeout(command: &ICommandText, timeout: Duration) {
    let Ok(properties) = command.cast::<ICommandProperties>() else {
        return;
    };
    let seconds = i32::try_from(timeout.as_millis().div_ceil(1_000).max(1)).unwrap_or(i32::MAX);
    let mut property = DBPROP {
        dwPropertyID: DBPROP_COMMANDTIMEOUT.0 as u32,
        dwOptions: DBPROPOPTIONS_OPTIONAL.0 as u32,
        dwStatus: 0,
        // All zeroes is `DB_NULLID`, as a property that names no column requires.
        colid: DBID::default(),
        vValue: i4_variant(seconds),
    };
    let set = DBPROPSET {
        rgProperties: &raw mut property,
        cProperties: 1,
        guidPropertySet: DBPROPSET_ROWSET,
    };
    // SAFETY: `set` points at one initialised property that outlives the call; the provider
    // copies the value. A `VT_I4` variant owns no memory, so nothing needs clearing.
    let _optional = unsafe { properties.SetProperties(&[set]) };
}

fn i4_variant(value: i32) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_I4,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { lVal: value },
            }),
        },
    }
}
