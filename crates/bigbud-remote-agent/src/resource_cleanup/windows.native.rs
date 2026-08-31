use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::ptr;

use bigbud_protocol::v1;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_FOR_BACKUP_INTENT, FILE_OPEN_IF,
    FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION, FILE_SYNCHRONOUS_IO_NONALERT,
    FileRenameInformation, NtCreateFile, NtSetInformationFile,
};
use windows_sys::Win32::Foundation::{
    ERROR_LOCK_VIOLATION, HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE,
    RtlNtStatusToDosError, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_DATA,
    FileDispositionInfoEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx,
    SYNCHRONIZE, SetFileInformationByHandle,
};
use windows_sys::Win32::System::IO::{IO_STATUS_BLOCK, OVERLAPPED};

use super::{identity, raw_identity};

const LOCK_NAME: &str = ".bigbud-resource-cleanup.lock";

pub(super) struct OperationLock {
    _file: File,
}

impl OperationLock {
    pub(super) fn acquire(root: &File) -> io::Result<Self> {
        let file = open_relative(root, OsStr::new(LOCK_NAME), FILE_OPEN_IF, true)?;
        if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other("unsupported lock reparse point"));
        }
        let mut overlapped = OVERLAPPED::default();
        // SAFETY: file is live and overlapped remains valid for this synchronous lock request.
        if unsafe {
            LockFileEx(
                file.as_raw_handle() as HANDLE,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
                Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "cleanup lock busy",
                ))
            } else {
                Err(error)
            };
        }
        Ok(Self { _file: file })
    }
}

pub(super) fn open_parent(root: &File, relative: &str) -> io::Result<(File, std::ffi::OsString)> {
    let path = std::path::Path::new(relative);
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing name"))?
        .to_owned();
    let mut parent = root.try_clone()?;
    if let Some(ancestors) = path.parent() {
        for component in ancestors.components() {
            parent = open_existing(&parent, component.as_os_str())?;
            let metadata = parent.metadata()?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(io::Error::other("unsupported parent entry"));
            }
        }
    }
    Ok((parent, name))
}

pub(super) fn open_existing(parent: &File, name: &OsStr) -> io::Result<File> {
    open_relative(parent, name, FILE_OPEN, false)
}

pub(super) fn open_optional(parent: &File, name: &OsStr) -> io::Result<Option<File>> {
    match open_existing(parent, name) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn open_relative(
    parent: &File,
    name: &OsStr,
    disposition: u32,
    writable: bool,
) -> io::Result<File> {
    let mut name = name.encode_wide().collect::<Vec<_>>();
    let name_bytes = name
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "relative name too long"))?;
    let unicode = UNICODE_STRING {
        Length: name_bytes,
        MaximumLength: name_bytes,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle() as HANDLE,
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: ptr::null(),
        SecurityQualityOfService: ptr::null(),
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut handle = INVALID_HANDLE_VALUE;
    let desired_access = DELETE
        | FILE_READ_ATTRIBUTES
        | FILE_LIST_DIRECTORY
        | SYNCHRONIZE
        | if writable { FILE_WRITE_DATA } else { 0 };
    let create_options = FILE_OPEN_REPARSE_POINT
        | FILE_OPEN_FOR_BACKUP_INTENT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | if writable { FILE_NON_DIRECTORY_FILE } else { 0 };
    // SAFETY: all pointed-to structures and the UTF-16 name remain live for the synchronous call.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            desired_access,
            &attributes,
            &mut status,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            disposition,
            create_options,
            ptr::null(),
            0,
        )
    };
    if result < 0 {
        // SAFETY: conversion accepts the NTSTATUS returned by NtCreateFile.
        let code = unsafe { RtlNtStatusToDosError(result) };
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::other("relative open returned an invalid handle"));
    }
    // SAFETY: NtCreateFile returned a new owned handle and INVALID_HANDLE_VALUE was rejected.
    Ok(unsafe { File::from_raw_handle(handle as _) })
}

pub(super) fn rename(file: &File, parent: &File, name: &OsStr) -> io::Result<()> {
    let name = name.encode_wide().collect::<Vec<_>>();
    let name_bytes = name
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "rename name too long"))?;
    let byte_len = offset_of!(FILE_RENAME_INFORMATION, FileName)
        .checked_add(name_bytes)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "rename buffer too large"))?;
    let mut storage = vec![0usize; byte_len.div_ceil(size_of::<usize>())];
    let information = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    let mut status = IO_STATUS_BLOCK::default();
    // SAFETY: storage is aligned and sized for the fixed header and complete UTF-16 name.
    unsafe {
        (*information).Anonymous.ReplaceIfExists = false;
        (*information).RootDirectory = parent.as_raw_handle() as HANDLE;
        (*information).FileNameLength = u32::try_from(name_bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "rename name too long"))?;
        ptr::copy_nonoverlapping(
            name.as_ptr(),
            information
                .cast::<u8>()
                .add(offset_of!(FILE_RENAME_INFORMATION, FileName))
                .cast::<u16>(),
            name.len(),
        );
        let result = NtSetInformationFile(
            file.as_raw_handle() as HANDLE,
            &mut status,
            information.cast(),
            u32::try_from(byte_len).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidInput, "rename buffer too large")
            })?,
            FileRenameInformation,
        );
        if result < 0 {
            let error = io::Error::from_raw_os_error(RtlNtStatusToDosError(result) as i32);
            #[cfg(test)]
            eprintln!("Windows resource cleanup rename failed: {error:?}");
            return Err(error);
        }
    }
    Ok(())
}

pub(super) fn native_identity(file: &File) -> io::Result<NativeIdentity> {
    let attributes = file.metadata()?.file_attributes();
    Ok(NativeIdentity {
        identity: raw_identity(file, attributes)?,
        is_directory: attributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        is_reparse_point: attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
    })
}

pub(super) struct NativeIdentity {
    pub(super) identity: v1::ResourceCleanupIdentity,
    pub(super) is_directory: bool,
    pub(super) is_reparse_point: bool,
}

pub(super) fn verified_identity(file: &File) -> io::Result<v1::ResourceCleanupIdentity> {
    identity(file)
}

pub(super) fn delete(file: File) -> io::Result<()> {
    let information = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    // SAFETY: information is initialized and file is a live handle with DELETE access.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as HANDLE,
            FileDispositionInfoEx,
            ptr::from_ref(&information).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } == 0
    {
        let error = io::Error::last_os_error();
        #[cfg(test)]
        eprintln!("Windows resource cleanup delete failed: {error:?}");
        return Err(error);
    }
    drop(file);
    Ok(())
}

#[path = "windows.native.tree.rs"]
mod tree;

pub(super) fn validate_tree(
    file: &File,
    expected: &v1::ResourceCleanupIdentity,
    root_volume: &str,
    entries: &mut usize,
    known_bytes: &mut u64,
    deadline: u64,
) -> io::Result<()> {
    tree::validate_tree(
        file,
        expected,
        root_volume,
        0,
        entries,
        known_bytes,
        deadline,
    )
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
    tree::remove_tree(
        file,
        expected,
        root_volume,
        depth,
        entries,
        known_bytes,
        deadline,
    )
}
