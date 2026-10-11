use std::{
    fs::OpenOptions,
    io,
    mem::size_of,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    ptr,
};
use windows_sys::{
    Wdk::System::Threading::{NtQueryInformationProcess, ProcessHandleInformation},
    Win32::{
        Foundation::{HANDLE, RtlNtStatusToDosError},
        Storage::FileSystem::FILE_READ_ATTRIBUTES,
        System::Threading::GetCurrentProcess,
    },
};

// ProcessHandleInformation is available since Windows 8. Its type index distinguishes non-file
// objects (including nonduplicable ALPC ports) without probing or silently dropping their handles.
// Layout: System Informer phnt/ntpsapi.h PROCESS_HANDLE_TABLE_ENTRY_INFO.
#[repr(C)]
#[derive(Clone, Copy)]
struct Entry {
    handle: HANDLE,
    handle_count: usize,
    pointer_count: usize,
    granted_access: u32,
    type_index: u32,
    attributes: u32,
    reserved: u32,
}

fn snapshot(process: HANDLE) -> io::Result<Vec<Entry>> {
    const HEADER: usize = 2 * size_of::<usize>();
    const CAPACITY: usize = HEADER + 4096 * size_of::<Entry>();
    let mut buffer = vec![0usize; CAPACITY.div_ceil(size_of::<usize>())];
    let mut written = 0;
    // SAFETY: process has query rights; fixed aligned allocation bounds all returned entries.
    let status = unsafe {
        NtQueryInformationProcess(
            process,
            ProcessHandleInformation,
            buffer.as_mut_ptr().cast(),
            CAPACITY as u32,
            &mut written,
        )
    };
    if status < 0 {
        // SAFETY: native NTSTATUS is converted without serializing arbitrary OS error strings.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    let count = buffer[0];
    if written as usize > CAPACITY
        || count > 4096
        || (written as usize) < HEADER + count * size_of::<Entry>()
    {
        return Err(io::Error::other("handle inventory bound"));
    }
    let mut entries = Vec::with_capacity(count);
    for index in 0..count {
        // SAFETY: the complete row range is in the checked returned buffer; read_unaligned avoids
        // reliance on a platform-specific header/entry alignment beyond the documented C layout.
        entries.push(unsafe {
            ptr::read_unaligned(
                buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(HEADER + index * size_of::<Entry>())
                    .cast::<Entry>(),
            )
        });
    }
    Ok(entries)
}

/// Return only kernel-classified File candidates; file handle closure/reuse still fails in the caller.
pub(super) fn files(process: HANDLE) -> io::Result<Vec<(HANDLE, u32)>> {
    // This helper's own executable supplies a known File type without creating any state or reading data.
    let known_file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .open(std::env::current_exe()?)?;
    // SAFETY: current-process pseudo handle is query-only and never closed.
    let local = snapshot(unsafe { GetCurrentProcess() })?;
    let kind = local
        .iter()
        .find(|entry| entry.handle == known_file.as_raw_handle())
        .map(|entry| entry.type_index)
        .filter(|index| *index != 0)
        .ok_or_else(|| io::Error::other("file type unavailable"))?;
    let entries = snapshot(process)?;
    if entries
        .iter()
        .any(|entry| entry.type_index == 0 || entry.handle.is_null())
    {
        return Err(io::Error::other("unclassified snapshot handle"));
    }
    Ok(entries
        .into_iter()
        .filter(|entry| entry.type_index == kind)
        .map(|entry| (entry.handle, entry.granted_access & FILE_READ_ATTRIBUTES))
        .collect())
}
