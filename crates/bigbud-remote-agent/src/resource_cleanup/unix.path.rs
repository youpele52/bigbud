use std::ffi::{CString, OsStr};
use std::io;
use std::os::unix::ffi::OsStrExt;

pub(super) fn cstring(value: &OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"))
}
