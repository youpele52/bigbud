//! Private regular-file operations, always relative to a retained directory.
use super::{
    acl::{self, Policy},
    descriptor::{same_named, stat},
    invalid,
};
use std::{
    ffi::CStr,
    fs::File,
    io,
    os::fd::{AsRawFd, FromRawFd},
};

pub(crate) fn open(parent: &File, name: &CStr, flags: libc::c_int) -> io::Result<File> {
    // SAFETY: live dirfd, fixed single component, mode supplied for O_CREAT.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful openat returns a new uniquely owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

pub(crate) fn validate(parent: &File, name: &CStr, file: &File, uid: u32) -> io::Result<()> {
    let metadata = stat(file)?;
    if metadata.st_mode & libc::S_IFMT != libc::S_IFREG
        || metadata.st_uid != uid
        || metadata.st_mode & 0o7777 != 0o600
        || metadata.st_nlink != 1
    {
        return Err(invalid());
    }
    acl::validate(file, Policy::Private)?;
    same_named(parent, name, &metadata)
}

pub(crate) fn optional(parent: &File, name: &CStr, uid: u32) -> io::Result<Option<File>> {
    match open(parent, name, libc::O_RDONLY) {
        Ok(file) => {
            validate(parent, name, &file, uid)?;
            Ok(Some(file))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(crate) fn validate_optional(
    parent: &File,
    name: &CStr,
    file: Option<&File>,
    uid: u32,
) -> io::Result<()> {
    match file {
        Some(file) => validate(parent, name, file, uid),
        None => match super::descriptor::named(parent, name) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
            Ok(_) => Err(invalid()),
        },
    }
}
