use std::{
    io,
    num::NonZeroU32,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
};

pub(super) fn exited(fd: &OwnedFd) -> io::Result<bool> {
    let mut event = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one valid writable pollfd and a live owned pidfd; timeout zero
    // never waits on the worker or consumes/reaps its process identity.
    let result = unsafe { libc::poll(&mut event, 1, 0) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    if event.revents & (libc::POLLNVAL | libc::POLLERR) != 0 {
        return Err(io::Error::other("pidfd observation failed"));
    }
    Ok(event.revents & libc::POLLIN != 0)
}

pub(super) fn open(pid: NonZeroU32) -> io::Result<Option<OwnedFd>> {
    // SAFETY: pid is a validated positive PID, flags=0; syscall has no pointers.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid.get() as libc::pid_t, 0) };
    if fd < 0 {
        let error = io::Error::last_os_error();
        // Only an absent kernel API permits the anchored-group fallback. Seccomp,
        // permissions and resource errors remain failures, not silent weakening.
        if error.raw_os_error() == Some(libc::ENOSYS) {
            return Ok(None);
        }
        return Err(error);
    }
    let fd = i32::try_from(fd).map_err(|_| io::Error::other("invalid pidfd"))?;
    // SAFETY: successful pidfd_open returns a new owned CLOEXEC descriptor.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    // SAFETY: borrowed live descriptor, F_GETFD has no third argument.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::FD_CLOEXEC == 0 {
        return Err(io::Error::other("inheritable pidfd"));
    }
    Ok(Some(fd))
}
