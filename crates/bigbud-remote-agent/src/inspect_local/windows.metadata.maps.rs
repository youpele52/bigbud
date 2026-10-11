use std::{
    collections::BTreeSet,
    io,
    mem::size_of,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::{GetLogicalDrives, QueryDosDeviceW},
    System::{
        Memory::*,
        ProcessStatus::K32GetMappedFileNameW,
        SystemInformation::{GetSystemInfo, SYSTEM_INFO},
    },
};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Mapping {
    pub base: usize,
    pub allocation: usize,
    pub size: usize,
    pub path: String,
}

fn local_path(native: &str) -> io::Result<String> {
    // SAFETY: reads the caller's DOS drive map without opening any target object.
    let drives = unsafe { GetLogicalDrives() };
    if drives == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut matches = Vec::new();
    for index in 0..26 {
        if drives & (1 << index) == 0 {
            continue;
        }
        let letter = b'A' + index as u8;
        let drive = [letter as u16, b':' as u16, 0];
        let mut buffer = vec![0u16; 32768];
        // SAFETY: null-terminated drive name and bounded writable output.
        let count =
            unsafe { QueryDosDeviceW(drive.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) }
                as usize;
        if count == 0 || count >= buffer.len() {
            return Err(io::Error::other("DOS device mapping incomplete"));
        }
        let returned = buffer
            .get(..count)
            .ok_or_else(|| io::Error::other("DOS device buffer bound"))?;
        let end = returned
            .iter()
            .position(|c| *c == 0)
            .ok_or_else(|| io::Error::other("DOS device name bound"))?;
        let target = String::from_utf16(
            returned
                .get(..end)
                .ok_or_else(|| io::Error::other("DOS device name bound"))?,
        )
        .map_err(io::Error::other)?;
        if let Some(rest) = native
            .strip_prefix(&target)
            .filter(|rest| rest.starts_with('\\'))
        {
            matches.push(format!("{}:{rest}", letter as char));
        }
    }
    if matches.len() != 1 {
        return Err(io::Error::other("mapped path is not one local drive"));
    }
    Ok(matches.remove(0))
}

/// Enumerate region/name metadata only; no address is dereferenced or page content read.
pub(super) fn scan(process: HANDLE) -> io::Result<BTreeSet<Mapping>> {
    let mut system = SYSTEM_INFO::default();
    // SAFETY: initialized correctly sized output; reads OS metadata only.
    unsafe {
        GetSystemInfo(&mut system);
    }
    let maximum = system.lpMaximumApplicationAddress as usize;
    let started = Instant::now();
    let mut address = 0usize;
    let mut result = BTreeSet::new();
    let mut incomplete = false;
    for _ in 0..65536 {
        if started.elapsed() > Duration::from_secs(8) {
            return Err(io::Error::other("mapping inspection deadline"));
        }
        if address > maximum {
            if incomplete {
                return Err(io::Error::other("mapping names incomplete"));
            }
            return Ok(result);
        }
        let mut info = MEMORY_BASIC_INFORMATION::default();
        // SAFETY: address is a numeric query key only; live query-only process and sized output.
        let written =
            unsafe { VirtualQueryEx(process, address as *const _, &mut info, size_of_val(&info)) };
        if written != size_of::<MEMORY_BASIC_INFORMATION>() {
            return Err(io::Error::last_os_error());
        }
        let base = info.BaseAddress as usize;
        let next = base
            .checked_add(info.RegionSize)
            .filter(|next| *next > address)
            .ok_or_else(|| io::Error::other("mapping address bound"))?;
        if base != address {
            return Err(io::Error::other("mapping range discontinuity"));
        }
        if info.Type == MEM_MAPPED && info.State == MEM_COMMIT {
            let mut name = vec![0u16; 32768];
            // SAFETY: remote address is passed only to a filename metadata query, never read.
            let count = unsafe {
                K32GetMappedFileNameW(
                    process,
                    info.BaseAddress,
                    name.as_mut_ptr(),
                    name.len() as u32,
                )
            } as usize;
            if count == 0 || count >= name.len() {
                eprintln!(
                    "metadata prototype mapped-name unavailable os={:?}",
                    io::Error::last_os_error().raw_os_error()
                );
                incomplete = true;
            } else {
                let native = String::from_utf16(
                    name.get(..count)
                        .ok_or_else(|| io::Error::other("mapped name bound"))?,
                )
                .map_err(io::Error::other)?;
                // Only paths nominate SHM candidates; membership and file identity are separate proofs.
                if native.ends_with("-shm") {
                    result.insert(Mapping {
                        base,
                        allocation: info.AllocationBase as usize,
                        size: info.RegionSize,
                        path: local_path(&native)?,
                    });
                }
            }
        }
        address = next;
    }
    Err(io::Error::other("mapping inventory bound"))
}
