use super::{file, object, protocol::hex, security};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::{
    collections::BTreeSet,
    fs::File,
    io,
    mem::size_of,
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::*,
    System::{Diagnostics::ProcessSnapshotting::*, Threading::*},
};

struct Snapshot(HPSS);
impl Drop for Snapshot {
    fn drop(&mut self) {
        // SAFETY: this snapshot was captured into the current process, without a clone.
        let result = unsafe { PssFreeSnapshot(GetCurrentProcess(), self.0) };
        if result != 0 {
            eprintln!("local inspection snapshot cleanup failed");
        }
    }
}
struct Marker(HPSSWALK);
impl Drop for Marker {
    fn drop(&mut self) {
        // SAFETY: marker was allocated by PssWalkMarkerCreate and has one owner.
        let result = unsafe { PssWalkMarkerFree(self.0) };
        if result != 0 {
            eprintln!("local inspection marker cleanup failed");
        }
    }
}

fn duplicate(process: HANDLE, handle: HANDLE, rights: u32) -> io::Result<OwnedHandle> {
    let mut raw = ptr::null_mut();
    // SAFETY: output pointer is valid; no source-close or same-access flag, no inheritance.
    if unsafe { DuplicateHandle(process, handle, GetCurrentProcess(), &mut raw, rights, 0, 0) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: DuplicateHandle returned a new owned handle with only requested rights.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn snapshot_name(pointer: *const u16, bytes: u16) -> io::Result<String> {
    if pointer.is_null() || bytes == 0 || !bytes.is_multiple_of(2) {
        return Err(io::Error::other("unclassified snapshot handle"));
    }
    // SAFETY: PSS supplied this counted string, whose allocation remains live with the walk marker.
    String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, usize::from(bytes) / 2) })
        .map_err(io::Error::other)
}

fn snapshot_disk_candidate(entry: &PSS_HANDLE_ENTRY) -> io::Result<bool> {
    // HAVE_TYPE validates ObjectType, whose enum omits files; TypeName is captured separately.
    if entry.Flags & PSS_HANDLE_HAVE_TYPE != 0
        && matches!(
            entry.ObjectType,
            PSS_OBJECT_TYPE_PROCESS
                | PSS_OBJECT_TYPE_THREAD
                | PSS_OBJECT_TYPE_MUTANT
                | PSS_OBJECT_TYPE_EVENT
                | PSS_OBJECT_TYPE_SECTION
                | PSS_OBJECT_TYPE_SEMAPHORE
        )
    {
        return Ok(false);
    }
    if entry.TypeName.is_null() || entry.TypeNameLength == 0 {
        return Ok(true);
    }
    if snapshot_name(entry.TypeName, entry.TypeNameLength)? != "File" {
        return Ok(false);
    }
    if entry.Flags & PSS_HANDLE_HAVE_NAME == 0 {
        return Ok(true);
    }
    let name = snapshot_name(entry.ObjectName, entry.ObjectNameLength)?.to_ascii_lowercase();
    // Known device names cannot contain SQLite files and need no retained probe. Missing PSS
    // metadata is not proof of irrelevance: it is classified below without using any socket API.
    Ok(![
        r"\device\afd",
        r"\device\namedpipe",
        r"\device\condrv",
        r"\device\null",
    ]
    .iter()
    .any(|device| name == *device || name.starts_with(&format!("{device}\\"))))
}

/// Inspect process handles only; database contents and the process address space are never read.
pub(super) fn inspect(pid: u32) -> io::Result<String> {
    // SAFETY: OpenProcess is called with query/duplicate only, never termination or VM rights.
    let raw = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_DUP_HANDLE, 0, pid) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful OpenProcess transfers ownership of one handle.
    let process = unsafe { OwnedHandle::from_raw_handle(raw) };
    if !security::current_user()?.same(&security::process_user(raw)?) {
        return Err(io::Error::other("process owner mismatch"));
    }
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let mut image = vec![0u16; 32_768];
    let mut image_length = image.len() as u32;
    // SAFETY: live process and initialized output structures/buffer.
    unsafe {
        if GetProcessTimes(raw, &mut creation, &mut exit, &mut kernel, &mut user) == 0
            || QueryFullProcessImageNameW(raw, 0, image.as_mut_ptr(), &mut image_length) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    let image = String::from_utf16(
        image
            .get(..image_length as usize)
            .ok_or_else(|| io::Error::other("image bound"))?,
    )
    .map_err(io::Error::other)?;
    let mut snapshot = ptr::null_mut();
    let mut handles = 0;
    // SAFETY: query-only process handle and valid DWORD output; reject large inventories before capture allocation.
    if unsafe { GetProcessHandleCount(raw, &mut handles) } == 0 || handles > 4096 {
        return Err(io::Error::other("handle inventory bound"));
    }
    // SAFETY: capture only the handle table; no memory, threads or process clone.
    let result = unsafe {
        PssCaptureSnapshot(
            raw,
            PSS_CAPTURE_HANDLES
                | PSS_CAPTURE_HANDLE_NAME_INFORMATION
                | PSS_CAPTURE_HANDLE_BASIC_INFORMATION
                | PSS_CAPTURE_HANDLE_TYPE_SPECIFIC_INFORMATION,
            0,
            &mut snapshot,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let snapshot = Snapshot(snapshot);
    let mut marker = ptr::null_mut();
    // SAFETY: default allocator and valid output pointer.
    let result = unsafe { PssWalkMarkerCreate(ptr::null(), &mut marker) };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let marker = Marker(marker);
    let started = Instant::now();
    let mut files = BTreeSet::new();
    let mut reply_bytes = image.len() * 2 + 64;
    let mut count = 0;
    loop {
        if count > 4096 || started.elapsed() > Duration::from_secs(4) {
            return Err(io::Error::other("inspection bound"));
        }
        let mut entry = PSS_HANDLE_ENTRY::default();
        // SAFETY: snapshot and marker are live; entry has the specified allocation size.
        let result = unsafe {
            PssWalkSnapshot(
                snapshot.0,
                PSS_WALK_HANDLES,
                marker.0,
                ptr::from_mut(&mut entry).cast(),
                size_of::<PSS_HANDLE_ENTRY>() as u32,
            )
        };
        if result == ERROR_NO_MORE_ITEMS {
            break;
        }
        if result != 0 {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
        count += 1;
        if !snapshot_disk_candidate(&entry)? {
            continue;
        }
        // A vanished, unclassified handle can hide another database: reject incomplete inventories.
        let retained = duplicate(raw, entry.Handle, 0)?;
        if !object::is_file(retained.as_raw_handle())? {
            continue;
        }
        // SAFETY: retained zero-right duplicate is live; no data read or file position change.
        match unsafe { GetFileType(retained.as_raw_handle()) } {
            FILE_TYPE_DISK => {}
            FILE_TYPE_CHAR | FILE_TYPE_PIPE => continue,
            _ => return Err(io::Error::other("snapshot file classification changed")),
        }
        // Upgrade only our retained duplicate; never resample the source handle number.
        // SAFETY: current-process pseudo handle is not closed or used to access process memory.
        let metadata: File = duplicate(
            unsafe { GetCurrentProcess() },
            retained.as_raw_handle(),
            FILE_READ_ATTRIBUTES | READ_CONTROL,
        )?
        .into();
        if !metadata.metadata()?.is_file() {
            continue;
        }
        let path = file::name(&metadata)?;
        let identity = file::identity(&metadata)?;
        let named = file::open_checked(&path, false, false)?;
        if file::identity(&named)? != identity {
            return Err(io::Error::other("file replaced"));
        }
        let owned = security::private_file(metadata.as_raw_handle(), false, true).is_ok();
        let row = format!("{},{},{}", hex(path.as_bytes()), identity, u8::from(owned));
        if !files.contains(&row) {
            reply_bytes += row.len() + 1;
            if reply_bytes > 512 * 1024 {
                return Err(io::Error::other("metadata bound"));
            }
            files.insert(row);
        }
    }
    // The retained process handle prevents PID reuse from impersonating this inspection.
    let mut code = 0;
    // SAFETY: process handle remains live until function return.
    if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) } == 0
        || code != STILL_ACTIVE as u32
    {
        return Err(io::Error::other("process exited"));
    }
    let reply = format!(
        "OK\t{:08x}{:08x}\t{}\t{}",
        creation.dwHighDateTime,
        creation.dwLowDateTime,
        hex(image.as_bytes()),
        files.into_iter().collect::<Vec<_>>().join(";")
    );
    if reply.len() > 512 * 1024 {
        return Err(io::Error::other("metadata bound"));
    }
    Ok(reply)
}
