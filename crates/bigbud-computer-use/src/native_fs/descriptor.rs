//! Shared descriptor-relative Darwin filesystem operations.
use super::invalid;
use std::{
    ffi::{CStr, CString},
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
};

pub(crate) fn open_at(parent: libc::c_int, name: &CStr) -> io::Result<File> {
    // SAFETY: live parent fd (or AT_FDCWD), NUL-terminated path; no vararg needed.
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful openat returned a new descriptor owned only here.
    Ok(unsafe { File::from_raw_fd(fd) })
}

pub(crate) fn stat(file: &impl AsRawFd) -> io::Result<libc::stat> {
    let mut value = std::mem::MaybeUninit::uninit();
    // SAFETY: valid fd and writable stat-sized storage.
    if unsafe { libc::fstat(file.as_raw_fd(), value.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat succeeded and initialized the entire ABI structure.
    Ok(unsafe { value.assume_init() })
}

pub(crate) fn named(parent: &File, name: &CStr) -> io::Result<libc::stat> {
    let mut value = std::mem::MaybeUninit::uninit();
    // SAFETY: live directory, NUL-terminated name and stat-sized output.
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            value.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful fstatat initialized the output.
    Ok(unsafe { value.assume_init() })
}

pub(crate) fn same_named(parent: &File, name: &CStr, expected: &libc::stat) -> io::Result<()> {
    let current = named(parent, name)?;
    if current.st_dev != expected.st_dev
        || current.st_ino != expected.st_ino
        || current.st_uid != expected.st_uid
        || current.st_mode != expected.st_mode
    {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn absolute_components(path: &Path) -> io::Result<Vec<CString>> {
    let bytes = path.as_os_str().as_bytes();
    if !bytes.starts_with(b"/") || bytes.len() > 4096 {
        return Err(invalid());
    }
    let mut result = Vec::new();
    for name in bytes.get(1..).ok_or_else(invalid)?.split(|b| *b == b'/') {
        if name.is_empty() || name == b"." || name == b".." || result.len() >= 64 {
            return Err(invalid());
        }
        result.push(CString::new(name).map_err(|_| invalid())?);
    }
    Ok(result)
}
