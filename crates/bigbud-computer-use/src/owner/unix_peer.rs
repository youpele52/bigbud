use std::{
    io,
    num::NonZeroU32,
    os::{fd::AsRawFd, unix::net::UnixStream},
};

pub(super) struct PeerCredentials {
    pub uid: u32,
    pub pid: NonZeroU32,
}

/// Reject rather than repair a descriptor that may already have leaked across
/// exec. Darwin std repairs CLOEXEC after creation: the trusted launcher must
/// additionally exclude concurrent launches; this check alone is not that proof.
pub(super) fn ensure_private_fd(stream: &impl AsRawFd) -> io::Result<()> {
    // SAFETY: stream owns a live descriptor; F_GETFD reads flags, no pointer arg.
    let flags = unsafe { libc::fcntl(stream.as_raw_fd(), libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::FD_CLOEXEC == 0 {
        return Err(io::Error::other("inheritable bootstrap endpoint"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn peer_credentials(stream: &UnixStream) -> io::Result<PeerCredentials> {
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: live Unix socket and valid writable uid/gid storage.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut pid: libc::pid_t = 0;
    let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
    // SAFETY: output is exactly pid_t-sized writable storage; size initialized to
    // its capacity, and both pointers live until getsockopt returns.
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            0,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut size,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if size as usize != std::mem::size_of_val(&pid) {
        return Err(invalid());
    }
    Ok(PeerCredentials {
        uid,
        pid: positive(pid)?,
    })
}

#[cfg(target_os = "linux")]
pub(super) fn peer_credentials(stream: &UnixStream) -> io::Result<PeerCredentials> {
    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::uninit();
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: buffer/length point to correctly sized writable ucred storage.
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut size,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if size as usize != std::mem::size_of::<libc::ucred>() {
        return Err(invalid());
    }
    // SAFETY: successful getsockopt returned the full initialized ucred.
    let credentials = unsafe { credentials.assume_init() };
    Ok(PeerCredentials {
        uid: credentials.uid,
        pid: positive(credentials.pid)?,
    })
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn peer_credentials(_: &UnixStream) -> io::Result<PeerCredentials> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "peer identity unavailable",
    ))
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid peer credentials")
}
fn positive(pid: libc::pid_t) -> io::Result<NonZeroU32> {
    if pid <= 1 {
        return Err(invalid());
    }
    NonZeroU32::new(pid as u32).ok_or_else(invalid)
}
