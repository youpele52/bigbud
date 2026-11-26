use super::{Cancel, ErrorCode, LOST, UNAVAILABLE, checkpoint, pause};
use std::io::{self, Read, Write};
use std::mem::{offset_of, size_of};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::ptr::{addr_of, addr_of_mut};
use std::time::Instant;

pub(super) fn connect_owned(
    path: &Path,
    pid: u32,
    deadline: Instant,
) -> Result<UnixStream, ErrorCode> {
    if Instant::now() >= deadline {
        return Err(LOST);
    }
    let stream = connect(path).map_err(|_| LOST)?;
    // Check the kernel peer on this same fd before writing ANY mux frames.
    if peer_pid(&stream).map_err(|_| UNAVAILABLE)? != pid {
        return Err(UNAVAILABLE);
    }
    Ok(stream)
}

fn connect(path: &Path) -> io::Result<UnixStream> {
    let bytes = path.as_os_str().as_encoded_bytes();
    // SAFETY: sockaddr_un contains only integer fields and arrays thereof.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if !path.is_absolute() || bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (dst, src) in address.sun_path.iter_mut().zip(bytes) {
        *dst = *src as libc::c_char;
    }
    let len = offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1;
    #[cfg(target_os = "macos")]
    {
        address.sun_len = u8::try_from(len).map_err(io::Error::other)?;
    }
    let len = libc::socklen_t::try_from(len).map_err(io::Error::other)?;
    let stream = stream()?;
    stream.set_nonblocking(true)?;
    // SAFETY: the live fd is a Unix stream and len covers the initialized
    // sockaddr_un and NUL terminator. A saturated or pending socket fails closed.
    if unsafe { libc::connect(stream.as_raw_fd(), addr_of!(address).cast(), len) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(stream)
}

fn stream() -> io::Result<UnixStream> {
    #[cfg(target_os = "macos")]
    let kind = libc::SOCK_STREAM;
    #[cfg(target_os = "linux")]
    let kind = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
    // SAFETY: socket accepts integer arguments and returns a fresh fd on success.
    let fd = unsafe { libc::socket(libc::AF_UNIX, kind, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the freshly opened fd is owned exactly once.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    #[cfg(target_os = "macos")]
    {
        // SAFETY: fd is valid and these operations set descriptor flags and
        // a socket option using an initialized integer of the correct size.
        let result = unsafe {
            let enabled: libc::c_int = 1;
            libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) == 0
                && libc::setsockopt(
                    fd.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_NOSIGPIPE,
                    addr_of!(enabled).cast(),
                    size_of::<libc::c_int>() as libc::socklen_t,
                ) == 0
        };
        if !result {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(UnixStream::from(fd))
}

#[cfg(target_os = "macos")]
pub(super) fn peer_pid(stream: &UnixStream) -> io::Result<u32> {
    let mut pid: libc::pid_t = 0;
    get_option(stream, libc::SOL_LOCAL, libc::LOCAL_PEERPID, &mut pid)?;
    // macOS identifies the bound listener via LOCAL_PEERPID. Its filesystem
    // uid and permissions are also independently checked by the caller.
    u32::try_from(pid).map_err(io::Error::other)
}

#[cfg(target_os = "linux")]
pub(super) fn peer_pid(stream: &UnixStream) -> io::Result<u32> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    get_option(
        stream,
        libc::SOL_SOCKET,
        libc::SO_PEERCRED,
        &mut credentials,
    )?;
    // SAFETY: geteuid takes no arguments and observes the current process only.
    if credentials.uid != unsafe { libc::geteuid() } {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    u32::try_from(credentials.pid).map_err(io::Error::other)
}

fn get_option<T>(stream: &UnixStream, level: i32, name: i32, value: &mut T) -> io::Result<()> {
    let mut size = libc::socklen_t::try_from(size_of::<T>()).map_err(io::Error::other)?;
    // SAFETY: the only callers supply writable pid_t or ucred for the matching
    // kernel option. The kernel may write at most size bytes.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            level,
            name,
            std::ptr::from_mut(value).cast(),
            addr_of_mut!(size),
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    if size as usize != size_of::<T>() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    Ok(())
}

// Stock OpenSSH mux protocol v4 identity probe. The session caller reuses
// this exact connected fd after HELLO and ALIVE_CHECK.
const HELLO: [u8; 12] = [0, 0, 0, 8, 0, 0, 0, 1, 0, 0, 0, 4];
const CHECK: [u8; 12] = [0, 0, 0, 8, 0x10, 0, 0, 4, 0, 0, 0, 1];
const ALIVE_PREFIX: [u8; 12] = [0, 0, 0, 12, 0x80, 0, 0, 5, 0, 0, 0, 1];

const MAX_HELLO_EXTENSIONS: usize = 1024;

#[cfg(test)]
#[test]
fn hello_accepts_only_bounded_well_formed_informational_strings() {
    assert_eq!(hello_extensions(&HELLO), Ok(0));
    assert_eq!(
        hello_extensions(&[0, 0, 0, 21, 0, 0, 0, 1, 0, 0, 0, 4]),
        Ok(13)
    );
    assert_eq!(
        hello_extensions(&[0xff, 0xff, 0xff, 0xff, 0, 0, 0, 1, 0, 0, 0, 4]),
        Err(UNAVAILABLE)
    );
    assert_eq!(validate_extensions(b"\0\0\0\x05hello\0\0\0\0"), Ok(()));
    assert_eq!(
        validate_extensions(b"\0\0\0\x05hello\0\0\0\x03x"),
        Err(UNAVAILABLE)
    );
}

fn hello_extensions(header: &[u8; 12]) -> Result<usize, ErrorCode> {
    let (length, body) = header.split_at(4);
    if body != [0, 0, 0, 1, 0, 0, 0, 4] {
        return Err(UNAVAILABLE);
    }
    let length = u32::from_be_bytes(length.try_into().map_err(|_| UNAVAILABLE)?) as usize;
    length
        .checked_sub(8)
        .filter(|count| *count <= MAX_HELLO_EXTENSIONS)
        .ok_or(UNAVAILABLE)
}

fn validate_extensions(mut bytes: &[u8]) -> Result<(), ErrorCode> {
    // OpenSSH v4 HELLO carries optional SSH string name/value pairs (Apple's
    // client sends one). Ignore their meaning; reject truncation and never use
    // an extension to grant a mux operation or influence a command.
    while !bytes.is_empty() {
        let (name, rest) = take_ssh_string(bytes)?;
        if name.is_empty() {
            return Err(UNAVAILABLE);
        }
        let (_, rest) = take_ssh_string(rest)?;
        bytes = rest;
    }
    Ok(())
}

fn take_ssh_string(bytes: &[u8]) -> Result<(&[u8], &[u8]), ErrorCode> {
    let (length, body) = bytes.split_first_chunk::<4>().ok_or(UNAVAILABLE)?;
    body.split_at_checked(u32::from_be_bytes(*length) as usize)
        .ok_or(UNAVAILABLE)
}

#[cfg(test)]
pub(super) fn alive(stream: &UnixStream, pid: u32, deadline: Instant) -> Result<(), ErrorCode> {
    alive_with(stream, pid, deadline, None)
}

pub(super) fn alive_with(
    mut stream: &UnixStream,
    pid: u32,
    deadline: Instant,
    cancel: Cancel<'_>,
) -> Result<(), ErrorCode> {
    write_with(&mut stream, &HELLO, deadline, cancel)?;
    let mut hello = [0; 12];
    read_with(&mut stream, &mut hello, deadline, cancel)?;
    let extensions = hello_extensions(&hello)?;
    let mut extension_bytes = [0; MAX_HELLO_EXTENSIONS];
    let data = extension_bytes.get_mut(..extensions).ok_or(UNAVAILABLE)?;
    read_with(&mut stream, data, deadline, cancel)?;
    validate_extensions(data)?;
    write_with(&mut stream, &CHECK, deadline, cancel)?;
    let mut response = [0; 16];
    read_with(&mut stream, &mut response, deadline, cancel)?;
    let (prefix, actual_pid) = response.split_at(12);
    if prefix != ALIVE_PREFIX || actual_pid != pid.to_be_bytes() {
        return Err(UNAVAILABLE);
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn write(
    stream: &mut &UnixStream,
    bytes: &[u8],
    deadline: Instant,
) -> Result<(), ErrorCode> {
    write_with(stream, bytes, deadline, None)
}

pub(super) fn write_with(
    stream: &mut &UnixStream,
    mut bytes: &[u8],
    deadline: Instant,
    cancel: Cancel<'_>,
) -> Result<(), ErrorCode> {
    while !bytes.is_empty() {
        let count = progress(deadline, cancel, || stream.write(bytes))?;
        bytes = bytes.get(count..).ok_or(UNAVAILABLE)?;
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn read(
    stream: &mut &UnixStream,
    bytes: &mut [u8],
    deadline: Instant,
) -> Result<(), ErrorCode> {
    read_with(stream, bytes, deadline, None)
}

pub(super) fn read_with(
    stream: &mut &UnixStream,
    mut bytes: &mut [u8],
    deadline: Instant,
    cancel: Cancel<'_>,
) -> Result<(), ErrorCode> {
    while !bytes.is_empty() {
        let count = progress(deadline, cancel, || stream.read(bytes))?;
        bytes = bytes.get_mut(count..).ok_or(UNAVAILABLE)?;
    }
    Ok(())
}

fn progress(
    deadline: Instant,
    cancel: Cancel<'_>,
    mut transfer: impl FnMut() -> io::Result<usize>,
) -> Result<usize, ErrorCode> {
    while Instant::now() < deadline {
        checkpoint(cancel)?;
        match transfer() {
            Ok(0) => return Err(LOST),
            Ok(count) => return Ok(count),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => pause(deadline),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => (),
            Err(_) => return Err(LOST),
        }
    }
    Err(LOST)
}
