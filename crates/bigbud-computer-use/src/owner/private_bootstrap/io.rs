use std::{
    io,
    os::{fd::AsRawFd, unix::net::UnixStream},
    time::{Duration, Instant},
};

pub(super) fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|left| !left.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "bootstrap deadline expired"))
}

pub(super) fn wait(stream: &impl AsRawFd, events: i16, deadline: Instant) -> io::Result<()> {
    let left = remaining(deadline)?.min(Duration::from_millis(100));
    let millis = i32::try_from(left.as_millis().max(1))
        .map_err(|_| io::Error::other("bootstrap poll overflow"))?;
    let mut fd = libc::pollfd {
        fd: stream.as_raw_fd(),
        events,
        revents: 0,
    };
    // SAFETY: one live descriptor and writable pollfd; bounded timeout.
    let result = unsafe { libc::poll(&mut fd, 1, millis) };
    if result < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    remaining(deadline)?;
    Ok(())
}

pub(super) fn retry(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
    )
}

pub(super) fn write_all(
    stream: &UnixStream,
    mut bytes: &[u8],
    deadline: Instant,
) -> io::Result<()> {
    // Darwin send can still block with MSG_DONTWAIT alone under backpressure.
    // The bootstrap owns this endpoint exclusively; enforce O_NONBLOCK too.
    stream.set_nonblocking(true)?;
    while !bytes.is_empty() {
        remaining(deadline)?;
        // SAFETY: live socket and readable bounded slice; no pointer retained.
        // MSG_NOSIGNAL prevents a closed courier from terminating the supervisor.
        let result = unsafe {
            libc::send(
                stream.as_raw_fd(),
                bytes.as_ptr().cast(),
                bytes.len(),
                libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
            )
        };
        remaining(deadline)?;
        if result < 0 {
            let error = io::Error::last_os_error();
            if !retry(&error) {
                return Err(error);
            }
            wait(stream, libc::POLLOUT, deadline)?;
        } else if result == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "bootstrap write closed",
            ));
        } else {
            bytes = bytes.get(result as usize..).ok_or_else(invalid)?;
        }
    }
    Ok(())
}

pub(super) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid bootstrap delivery")
}
