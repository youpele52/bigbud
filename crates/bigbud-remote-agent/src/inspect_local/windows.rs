use super::{file, handles, object, protocol::hex, security};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::{
    collections::BTreeSet,
    fs::File,
    io,
    mem::size_of,
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::{Foundation::*, Storage::FileSystem::*, System::Threading::*};

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

fn at<T>(stage: &'static str, result: io::Result<T>) -> io::Result<T> {
    result.inspect_err(|error| {
        eprintln!("local metadata stage={stage} os={:?}", error.raw_os_error())
    })
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
    let started = Instant::now();
    let mut files = BTreeSet::new();
    let mut reply_bytes = image.len() * 2 + 64;
    for (handle, rights) in at("table", handles::files(raw))? {
        if started.elapsed() > Duration::from_secs(4) {
            return Err(io::Error::other("inspection bound"));
        }
        // A vanished, unclassified handle can hide another database: reject incomplete inventories.
        let retained = at("retain", duplicate(raw, handle, rights))?;
        if !at("type", object::is_file(retained.as_raw_handle()))? {
            return Err(io::Error::other("snapshot file classification changed"));
        }
        // SAFETY: retained duplicate is live; no data read or file position change.
        match unsafe { GetFileType(retained.as_raw_handle()) } {
            FILE_TYPE_DISK => {}
            FILE_TYPE_CHAR | FILE_TYPE_PIPE => continue,
            _ => return Err(io::Error::other("snapshot file classification changed")),
        }
        // Basic attributes, final path and file ID need no data access. Keep the original object
        // pinned; use a separately checked, identity-matched path handle only for owner ACL access.
        let metadata: File = retained.into();
        let mut info = FILE_STANDARD_INFO::default();
        // SAFETY: live disk handle and correctly sized output. Standard info needs no attribute
        // access, unlike Basic info; a traverse-only CWD directory can therefore be proven irrelevant.
        if unsafe {
            GetFileInformationByHandleEx(
                metadata.as_raw_handle(),
                FileStandardInfo,
                ptr::from_mut(&mut info).cast(),
                size_of::<FILE_STANDARD_INFO>() as u32,
            )
        } == 0
        {
            return at("standard-info", Err(io::Error::last_os_error()));
        }
        if info.Directory {
            continue;
        }
        if info.DeletePending {
            return Err(io::Error::other("deleted file handle"));
        }
        let path = at("path", file::name(&metadata))?;
        let identity = at("identity", file::identity(&metadata))?;
        let named = at("checked-path", file::open_checked(&path, false, false))?;
        if file::identity(&named)? != identity {
            return Err(io::Error::other("file replaced"));
        }
        let owned = security::private_file(named.as_raw_handle(), false, true).is_ok();
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
