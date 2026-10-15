use super::{file, security, security_create};
use std::{
    ffi::OsStr,
    fs::File,
    io,
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        fs::MetadataExt,
        io::{AsRawHandle, FromRawHandle},
    },
    ptr,
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_CREATE, FILE_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
            FILE_SYNCHRONOUS_IO_NONALERT, FILE_WRITE_THROUGH, NtCreateFile,
        },
    },
    Win32::{
        Foundation::{
            INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING,
        },
        Storage::FileSystem::*,
        System::IO::IO_STATUS_BLOCK,
    },
};

/// Pin every ancestor against rename/delete for the entire native operation.
pub(super) struct Directory {
    chain: Vec<File>,
    pub id: String,
}
impl Directory {
    pub fn open(path: &str, expected: &str, private: bool) -> io::Result<Self> {
        let chain = file::open_chain(path, true, true, true)?;
        let handle = chain
            .last()
            .ok_or_else(|| io::Error::other("empty chain"))?;
        let info = handle.metadata()?;
        if !info.is_dir() || info.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other("directory rejected"));
        }
        security::private_file(handle.as_raw_handle(), false, !private)?;
        security::private_file(handle.as_raw_handle(), true, false)?;
        let id = file::identity(handle)?;
        if expected != "-" && expected != id {
            return Err(io::Error::other("identity conflict"));
        }
        Ok(Self { chain, id })
    }
    pub fn handle(&self) -> io::Result<&File> {
        self.chain
            .last()
            .ok_or_else(|| io::Error::other("empty chain"))
    }
    pub fn revalidate(&self) -> io::Result<()> {
        for handle in &self.chain {
            if handle.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(io::Error::other("reparse rejected"));
            }
            security::private_file(handle.as_raw_handle(), true, false)?;
        }
        if file::identity(self.handle()?)? != self.id {
            return Err(io::Error::other("identity conflict"));
        }
        Ok(())
    }
    /// Volume-GUID paths come from the held handle, not mutable drive mappings or caller pathnames.
    pub fn child_path(&self, name: &str) -> io::Result<Vec<u16>> {
        component(name)?;
        let mut output = vec![0u16; 32_768];
        // SAFETY: live directory handle, initialized bounded output. GUID volume names reject remote/unsupported volumes.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                self.handle()?.as_raw_handle(),
                output.as_mut_ptr(),
                output.len() as u32,
                VOLUME_NAME_GUID,
            )
        } as usize;
        if length == 0 || length >= output.len() {
            return Err(io::Error::last_os_error());
        }
        output.truncate(length);
        if output.last() != Some(&92) {
            output.push(92);
        }
        output.extend(name.encode_utf16());
        output.push(0);
        if output.len() > 32_768 {
            return Err(io::Error::other("path bound"));
        }
        Ok(output)
    }
}

pub(super) fn component(name: &str) -> io::Result<()> {
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| c < ' ' || "\\/:*?\"<>|".contains(c))
    {
        return Err(io::Error::other("component rejected"));
    }
    let stem = name
        .split('.')
        .next()
        .ok_or_else(|| io::Error::other("component rejected"))?
        .to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4)
    {
        return Err(io::Error::other("device name rejected"));
    }
    Ok(())
}

/// Open/create a single child relative to a retained directory; do not follow reparse points.
pub(super) fn child(
    parent: &Directory,
    name: &str,
    create: bool,
    directory: bool,
    access: u32,
    share: u32,
) -> io::Result<File> {
    component(name)?;
    let mut name: Vec<u16> = OsStr::new(name).encode_wide().collect();
    let length = u16::try_from(name.len() * 2).map_err(io::Error::other)?;
    let unicode = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: name.as_mut_ptr(),
    };
    let descriptor = if create {
        Some(security_create::descriptor(directory)?)
    } else {
        None
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.handle()?.as_raw_handle(),
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        SecurityDescriptor: descriptor
            .as_ref()
            .map_or(ptr::null(), |value| value.0.cast()),
        SecurityQualityOfService: ptr::null(),
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut raw = INVALID_HANDLE_VALUE;
    // SAFETY: retained parent, bounded initialized Unicode name and security descriptor; all outputs live across the call.
    let result = unsafe {
        NtCreateFile(
            &mut raw,
            access | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE,
            &attributes,
            &mut status,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            if create { FILE_CREATE } else { FILE_OPEN },
            FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | if directory { FILE_DIRECTORY_FILE } else { 0 }
                | if create { FILE_WRITE_THROUGH } else { 0 },
            ptr::null(),
            0,
        )
    };
    if result < 0 {
        // SAFETY: NTSTATUS comes from NtCreateFile.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ));
    }
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::other("invalid handle"));
    }
    // SAFETY: successful NtCreateFile transferred a uniquely owned handle.
    let file = unsafe { File::from_raw_handle(raw) };
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::other("reparse rejected"));
    }
    Ok(file)
}
