//! Account database identity, not HOME, argv, profile or provider configuration.
//! This binds a storage owner only, NOT the interactive login/desktop session.
use crate::native_fs::invalid;
use std::{ffi::CStr, io, os::unix::ffi::OsStrExt, path::PathBuf};

pub(super) struct Account {
    pub(super) uid: u32,
    pub(super) home: PathBuf,
}
impl Account {
    pub(super) fn current() -> io::Result<Self> {
        let uid = current_uid()?;
        // A bounded reentrant lookup; ERANGE fails closed rather than falling
        // back to environment paths. No account enumeration or home contents.
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut result = std::ptr::null_mut();
        // SAFETY: correctly sized passwd and writable owned buffer; returned
        // strings remain in buffer until copied below. Public pwd.h getpwuid_r.
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                entry.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status));
        }
        if result.is_null() || result != entry.as_mut_ptr() {
            return Err(invalid());
        }
        // SAFETY: successful lookup initialized entry and its NUL-terminated strings.
        let entry = unsafe { entry.assume_init() };
        if entry.pw_uid != uid || entry.pw_dir.is_null() {
            return Err(invalid());
        }
        // SAFETY: pw_dir is a valid NUL-terminated string in the still-live buffer.
        let home = unsafe { CStr::from_ptr(entry.pw_dir) };
        let home = PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes()));
        if current_uid()? != uid {
            return Err(invalid());
        }
        Ok(Self { uid, home })
    }
}

pub(super) use crate::native_fs::current_uid;
