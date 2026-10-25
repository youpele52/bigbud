use std::io;
use std::os::fd::FromRawFd;
use std::sync::MutexGuard;

/// Called while ALL production process spawns hold the same gate. On failure
/// the unprotected descriptor is closed before releasing that gate. Cleanup
/// ownership was reserved before fork and is separate from this short FD gate.
pub(super) fn configure_master(
    fd: i32,
    gate: MutexGuard<'static, ()>,
) -> io::Result<std::fs::File> {
    // SAFETY: successful forkpty transfers one owned valid master descriptor.
    let master = unsafe { std::fs::File::from_raw_fd(fd) };
    #[cfg(test)]
    tests::before_setup(fd)?;
    let setup = (|| {
        // SAFETY: master keeps fd valid; these fcntl calls only use integer flags.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: exclusively owned live fd, serialized against every other spawn.
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: same descriptor; nonblocking applies to its reader/writer clones.
        if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    })();
    if let Err(error) = setup {
        drop(master);
        drop(gate);
        return Err(error);
    }
    drop(gate);
    Ok(master)
}

#[cfg(test)]
#[path = "platform.tests.rs"]
mod tests;
