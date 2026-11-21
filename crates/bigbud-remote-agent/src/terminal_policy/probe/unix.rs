//! Terminal and process-group queries shared by every Unix.

use std::io;

pub(super) fn foreground_group(master_fd: i32) -> io::Result<i32> {
    // SAFETY: tcgetpgrp only reads the terminal state of the descriptor; an invalid or
    // non-terminal descriptor fails with -1 and errno, which is reported.
    let group = unsafe { libc::tcgetpgrp(master_fd) };
    if group < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(group)
}

pub(super) fn process_group(pid: i32) -> io::Result<i32> {
    // SAFETY: getpgid takes a plain pid and reports a missing process through errno.
    let group = unsafe { libc::getpgid(pid) };
    if group < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(group)
}
