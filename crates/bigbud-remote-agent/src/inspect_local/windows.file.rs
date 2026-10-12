use super::{protocol::hex, security};
use std::os::windows::{
    ffi::OsStrExt,
    fs::{MetadataExt, OpenOptionsExt},
    io::{AsRawHandle, FromRawHandle},
};
use std::{
    ffi::OsStr,
    fs::File,
    io::{self, Read},
    mem::size_of,
    path::{Component, Path, Prefix},
    ptr,
};
use windows_sys::Wdk::{
    Foundation::OBJECT_ATTRIBUTES,
    Storage::FileSystem::{
        FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, NtCreateFile,
    },
};
use windows_sys::Win32::{
    Foundation::{
        HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING,
    },
    Storage::FileSystem::*,
    System::IO::IO_STATUS_BLOCK,
};

fn relative(parent: &File, name: &OsStr, read: bool) -> io::Result<File> {
    let mut name: Vec<u16> = name.encode_wide().collect();
    let bytes = u16::try_from(name.len() * 2).map_err(io::Error::other)?;
    let unicode = UNICODE_STRING {
        Length: bytes,
        MaximumLength: bytes,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: ptr::null(),
        SecurityQualityOfService: ptr::null(),
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut raw = INVALID_HANDLE_VALUE;
    // SAFETY: stable relative parent handle and initialized bounded name/structures; open-existing only.
    let result = unsafe {
        NtCreateFile(
            &mut raw,
            FILE_READ_ATTRIBUTES
                | READ_CONTROL
                | SYNCHRONIZE
                | if read { FILE_READ_DATA } else { 0 },
            &attributes,
            &mut status,
            ptr::null(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    };
    if result < 0 {
        // SAFETY: result is an NTSTATUS returned by NtCreateFile.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ));
    }
    if raw == INVALID_HANDLE_VALUE || raw.is_null() {
        return Err(io::Error::other("invalid handle"));
    }
    // SAFETY: successful NtCreateFile transferred ownership of a new file handle.
    Ok(unsafe { File::from_raw_handle(raw) })
}

/// Walk relative to retained directory handles; no reparse point can redirect a checked ancestor.
pub(super) fn open_checked(path: &str, read: bool, private: bool) -> io::Result<File> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(io::Error::other("absolute path required"));
    }
    let mut parts = path.components();
    let prefix = parts
        .next()
        .ok_or_else(|| io::Error::other("missing prefix"))?;
    if !matches!(prefix, Component::Prefix(value) if matches!(value.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        || parts.next() != Some(Component::RootDir)
    {
        return Err(io::Error::other("invalid root"));
    }
    let root = Path::new(prefix.as_os_str()).join("\\");
    let mut file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | READ_CONTROL)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(root)?;
    let names: Vec<_> = parts.collect();
    if names.is_empty() || names.len() > 256 {
        return Err(io::Error::other("path bound"));
    }
    for (index, part) in names.iter().enumerate() {
        if !matches!(part, Component::Normal(_))
            || part
                .as_os_str()
                .encode_wide()
                .any(|c| c == 0 || c == u16::from(b':'))
        {
            return Err(io::Error::other("invalid component"));
        }
        if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other("reparse rejected"));
        }
        if private {
            security::private_file(file.as_raw_handle(), true, false)?;
        }
        file = relative(&file, part.as_os_str(), read && index + 1 == names.len())?;
    }
    let info = file.metadata()?;
    if !info.is_file() || info.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other("regular file required"));
    }
    if private {
        security::private_file(file.as_raw_handle(), false, false)?;
    }
    Ok(file)
}

pub(super) fn read_private(path: &str) -> io::Result<Vec<u8>> {
    let mut file = open_checked(path, true, true)?;
    let before = identity(&file)?;
    if file.metadata()?.len() > 16_384 {
        return Err(io::Error::other("read bound"));
    }
    let mut bytes = Vec::new();
    file.by_ref().take(16_385).read_to_end(&mut bytes)?;
    security::private_file(file.as_raw_handle(), false, false)?;
    let after = open_checked(path, false, true)?;
    if bytes.len() > 16_384 || before != identity(&file)? || before != identity(&after)? {
        return Err(io::Error::other("read identity changed"));
    }
    Ok(bytes)
}

pub(super) fn identity(file: &File) -> io::Result<String> {
    let mut info = FILE_ID_INFO::default();
    // SAFETY: file is live and output has the documented size/alignment.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileIdInfo,
            ptr::from_mut(&mut info).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(format!(
        "{:016x}:{}",
        info.VolumeSerialNumber,
        hex(&info.FileId.Identifier)
    ))
}
