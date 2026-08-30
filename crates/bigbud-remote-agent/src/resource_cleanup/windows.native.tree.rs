use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::ptr;

use bigbud_protocol::v1;
use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ID_BOTH_DIR_INFO, FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo,
    GetFileInformationByHandleEx,
};

use super::{delete, native_identity, open_existing};
use crate::resource_cleanup::{MAX_DEPTH, MAX_ENTRIES, MAX_KNOWN_BYTES, windows::check_deadline};

const DIRECTORY_BUFFER_SIZE: usize = 64 * 1024;

pub(super) fn validate_tree(
    file: &File,
    expected: &v1::ResourceCleanupIdentity,
    root_volume: &str,
    depth: usize,
    entries: &mut usize,
    known_bytes: &mut u64,
    deadline: u64,
) -> io::Result<()> {
    check_deadline(deadline)?;
    *entries += 1;
    if depth > MAX_DEPTH || *entries > MAX_ENTRIES {
        return Err(io::Error::other("cleanup bound exceeded"));
    }
    let actual = native_identity(file)?;
    if actual.identity != *expected {
        return Err(io::Error::other("identity changed"));
    }
    if actual.identity.device_or_volume != root_volume {
        return Err(io::Error::other("mount boundary"));
    }
    if actual.is_directory && !actual.is_reparse_point {
        for name in child_names(file, MAX_ENTRIES.saturating_sub(*entries))? {
            let child = open_existing(file, &name)?;
            let child_identity = native_identity(&child)?.identity;
            validate_tree(
                &child,
                &child_identity,
                root_volume,
                depth + 1,
                entries,
                known_bytes,
                deadline,
            )?;
        }
    } else {
        add_known_bytes(file, known_bytes)?;
    }
    if native_identity(file)?.identity != *expected {
        return Err(io::Error::other("identity changed"));
    }
    Ok(())
}

pub(super) fn remove_tree(
    file: File,
    expected: &v1::ResourceCleanupIdentity,
    root_volume: &str,
    depth: usize,
    entries: &mut usize,
    known_bytes: &mut u64,
    deadline: u64,
) -> io::Result<()> {
    check_deadline(deadline)?;
    *entries += 1;
    if depth > MAX_DEPTH || *entries > MAX_ENTRIES {
        return Err(io::Error::other("cleanup bound exceeded"));
    }
    let actual = native_identity(&file)?;
    if actual.identity != *expected {
        return Err(io::Error::other("identity changed"));
    }
    if actual.identity.device_or_volume != root_volume {
        return Err(io::Error::other("mount boundary"));
    }
    if actual.is_directory && !actual.is_reparse_point {
        for name in child_names(&file, MAX_ENTRIES.saturating_sub(*entries))? {
            check_deadline(deadline)?;
            let child = open_existing(&file, &name)?;
            let child_identity = native_identity(&child)?.identity;
            remove_tree(
                child,
                &child_identity,
                root_volume,
                depth + 1,
                entries,
                known_bytes,
                deadline,
            )?;
        }
    } else {
        add_known_bytes(&file, known_bytes)?;
    }
    delete(file)
}

fn add_known_bytes(file: &File, known_bytes: &mut u64) -> io::Result<()> {
    *known_bytes = known_bytes
        .checked_add(file.metadata()?.len())
        .ok_or_else(|| io::Error::other("known-byte bound exceeded"))?;
    if *known_bytes > MAX_KNOWN_BYTES {
        return Err(io::Error::other("known-byte bound exceeded"));
    }
    Ok(())
}

fn child_names(directory: &File, remaining: usize) -> io::Result<Vec<OsString>> {
    let mut buffer = vec![0u64; DIRECTORY_BUFFER_SIZE / size_of::<u64>()];
    let mut restart = true;
    let mut names = Vec::new();
    loop {
        let class = if restart {
            FileIdBothDirectoryRestartInfo
        } else {
            FileIdBothDirectoryInfo
        };
        restart = false;
        // SAFETY: buffer is writable, aligned, and its exact size is supplied to the OS.
        let succeeded = unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle() as HANDLE,
                class,
                buffer.as_mut_ptr().cast(),
                DIRECTORY_BUFFER_SIZE as u32,
            )
        };
        if succeeded == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(error);
        }
        parse_directory_buffer(&buffer, &mut names, remaining)?;
    }
    Ok(names)
}

fn parse_directory_buffer(
    buffer: &[u64],
    names: &mut Vec<OsString>,
    remaining: usize,
) -> io::Result<()> {
    let bytes = size_of_val(buffer);
    let mut offset = 0usize;
    loop {
        if offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName) > bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid directory entry",
            ));
        }
        // SAFETY: the fixed header is in bounds; unaligned read supports packed records.
        let entry = unsafe {
            ptr::read_unaligned(
                buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<FILE_ID_BOTH_DIR_INFO>(),
            )
        };
        let name_bytes = usize::try_from(entry.FileNameLength)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid file name"))?;
        let name_offset = offset + offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
        if name_bytes % size_of::<u16>() != 0 || name_offset + name_bytes > bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid file name",
            ));
        }
        // SAFETY: name bounds were checked and the backing allocation is u64-aligned.
        let name = unsafe {
            std::slice::from_raw_parts(
                buffer.as_ptr().cast::<u8>().add(name_offset).cast::<u16>(),
                name_bytes / size_of::<u16>(),
            )
        };
        if name != [b'.' as u16] && name != [b'.' as u16, b'.' as u16] {
            if names.len() == remaining {
                return Err(io::Error::other("cleanup bound exceeded"));
            }
            names.push(OsString::from_wide(name));
        }
        if entry.NextEntryOffset == 0 {
            return Ok(());
        }
        offset = offset
            .checked_add(entry.NextEntryOffset as usize)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid directory entry"))?;
    }
}
