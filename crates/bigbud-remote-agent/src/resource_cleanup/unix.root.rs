use std::ffi::CStr;
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd};

use bigbud_protocol::v1;

pub(super) fn path_matches(path: &CStr, expected: &v1::ResourceCleanupIdentity) -> bool {
    // SAFETY: path is retained from validated bootstrap input and is NUL-terminated.
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return false;
    }
    // SAFETY: open returned a new owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    super::matches_identity(file.as_raw_fd(), expected)
}
