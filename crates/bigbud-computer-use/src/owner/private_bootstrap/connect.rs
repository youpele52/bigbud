//! Nonblocking connect: std's UnixStream::connect may block before returning.
use super::io::{invalid, remaining, wait};
use std::{
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, net::UnixStream},
    },
    path::Path,
    time::Instant,
};

pub(super) fn connect(path: &Path, deadline: Instant) -> io::Result<UnixStream> {
    remaining(deadline)?;
    // SAFETY: AF_UNIX stream creation takes no pointers. Darwin flag repair is
    // covered by the still-unissued production launch-exclusion permit, not
    // claimed atomic here. Same-process fixtures never launch subprocesses.
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: newly returned descriptor exclusively owned by this scope.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: live owned descriptor; F_SETFD changes only its inheritance flag.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = UnixStream::from(fd);
    stream.set_nonblocking(true)?;
    // SAFETY: zero is valid sockaddr_un initialization; fields populated below.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    let bytes = path.as_os_str().as_bytes();
    if bytes.is_empty() || bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
        return Err(invalid());
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    address.sun_len = std::mem::size_of_val(&address) as u8;
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    // SAFETY: live socket and initialized sockaddr_un with bounded NUL-terminated
    // path. Kernel copies the address; no pointer outlives the call.
    let status = unsafe {
        libc::connect(
            stream.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            std::mem::size_of_val(&address) as libc::socklen_t,
        )
    };
    if status != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(error);
        }
        loop {
            wait(&stream, libc::POLLOUT, deadline)?;
            if let Some(error) = stream.take_error()? {
                return Err(error);
            }
            match stream.peer_addr() {
                Ok(_) => break,
                Err(error) if error.kind() == io::ErrorKind::NotConnected => {}
                Err(error) => return Err(error),
            }
        }
    }
    remaining(deadline)?;
    Ok(stream)
}
