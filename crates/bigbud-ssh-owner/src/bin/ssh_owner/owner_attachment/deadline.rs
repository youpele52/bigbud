use std::{
    cell::Cell,
    io::{self, Read, Write},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

use super::LauncherLifetime;

pub(super) struct DeadlineIo<'a> {
    pub(super) stream: &'a UnixStream,
    pub(super) deadline: &'a Cell<Instant>,
    pub(super) lifetime: Option<&'a LauncherLifetime>,
}

impl DeadlineIo<'_> {
    fn remaining(&self) -> io::Result<Duration> {
        let remaining = self
            .deadline
            .get()
            .saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        // Do not let OS timeout precision round a nonzero remainder to no timeout.
        Ok(remaining.max(Duration::from_millis(1)))
    }
}

impl Read for DeadlineIo<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if let Some(lifetime) = self.lifetime {
            lifetime.wait(self.stream, libc::POLLIN, Some(self.remaining()?))?;
        }
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        self.stream.read(buffer)
    }
}

impl Write for DeadlineIo<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if let Some(lifetime) = self.lifetime {
            lifetime.wait(self.stream, libc::POLLOUT, Some(self.remaining()?))?;
        }
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}
