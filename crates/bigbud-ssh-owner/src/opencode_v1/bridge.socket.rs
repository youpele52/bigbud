use std::io::{self, ErrorKind};
use std::mem::offset_of;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::{ffi::OsStrExt, net::UnixStream};
use std::path::Path;
use std::ptr::addr_of;

pub(super) struct Destination {
    address: libc::sockaddr_un,
    len: libc::socklen_t,
}

impl Destination {
    pub(super) fn new(path: &Path) -> io::Result<Self> {
        let bytes = path.as_os_str().as_bytes();
        // SAFETY: sockaddr_un contains only integer fields and arrays thereof.
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        if !path.is_absolute() || bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "invalid OpenCode bridge socket path",
            ));
        }
        address.sun_family =
            libc::sa_family_t::try_from(libc::AF_UNIX).map_err(io::Error::other)?;
        for (target, byte) in address.sun_path.iter_mut().zip(bytes) {
            *target = *byte as libc::c_char;
        }
        let len = offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
        #[cfg(any(
            target_vendor = "apple",
            target_os = "freebsd",
            target_os = "dragonfly",
            target_os = "netbsd",
            target_os = "openbsd"
        ))]
        {
            address.sun_len = u8::try_from(len).map_err(io::Error::other)?;
        }
        Ok(Self {
            address,
            len: libc::socklen_t::try_from(len).map_err(io::Error::other)?,
        })
    }

    // Return whether connect completed immediately. In either case the live
    // socket is nonblocking and owned before any other fallible operation.
    pub(super) fn connect(&self) -> io::Result<(UnixStream, bool)> {
        let stream = create_stream()?;
        stream.set_nonblocking(true)?;
        // SAFETY: the live fd is a Unix stream, and address points to a valid
        // sockaddr_un covering len initialized bytes, including the NUL.
        let result =
            unsafe { libc::connect(stream.as_raw_fd(), addr_of!(self.address).cast(), self.len) };
        let connected = if result == 0 {
            true
        } else {
            let error = io::Error::last_os_error();
            // Linux returns EAGAIN instead when the Unix accept queue is full;
            // shed this connection in that case, without retrying or waiting.
            if error.raw_os_error() != Some(libc::EINPROGRESS) {
                return Err(error);
            }
            false
        };
        Ok((stream, connected))
    }
}

const SOCKET_TYPE: libc::c_int = {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        libc::SOCK_STREAM | libc::SOCK_CLOEXEC
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        libc::SOCK_STREAM
    }
};

fn create_stream() -> io::Result<UnixStream> {
    // SAFETY: socket accepts integer parameters and returns a new fd on success.
    let fd = unsafe { libc::socket(libc::AF_UNIX, SOCKET_TYPE, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd is freshly returned by socket and ownership is transferred once.
    let owner = unsafe { OwnedFd::from_raw_fd(fd) };
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        // SAFETY: owner is live and this sets the descriptor's close-on-exec bit.
        if unsafe { libc::fcntl(owner.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(target_vendor = "apple")]
    {
        let no_sigpipe: libc::c_int = 1;
        let len = libc::socklen_t::try_from(std::mem::size_of_val(&no_sigpipe))
            .map_err(io::Error::other)?;
        // SAFETY: owner is live and the option points to an initialized c_int.
        if unsafe {
            libc::setsockopt(
                owner.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_NOSIGPIPE,
                addr_of!(no_sigpipe).cast(),
                len,
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(UnixStream::from(owner))
}
