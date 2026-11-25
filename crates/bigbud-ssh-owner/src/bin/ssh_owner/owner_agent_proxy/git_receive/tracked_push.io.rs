//! Deadline-bound variant of the disposable receive fixture's pack pump. No
//! subprocess, thread, or transport of its own; it only consumes dedicated pipes.

use std::{
    fs::File,
    io::{self, Read, Write},
    os::{fd::AsRawFd, unix::fs::FileTypeExt},
    time::Instant,
};

// The synthetic push is deliberately small. This is not a product pack budget.
const PACK_CAP: usize = 64 * 1024;
const CANCELLATION_POLL_MS: u128 = 25;

pub(super) struct Budget<'a> {
    deadline: Instant,
    cancelled: &'a dyn Fn() -> bool,
}

impl<'a> Budget<'a> {
    pub(super) fn new(deadline: Instant, cancelled: &'a dyn Fn() -> bool) -> Self {
        Self {
            deadline,
            cancelled,
        }
    }

    pub(super) fn check(&self) -> io::Result<()> {
        if (self.cancelled)() {
            // `Read::read_exact` and `Write::write_all` retry Interrupted.
            Err(io::ErrorKind::ConnectionAborted.into())
        } else if Instant::now() >= self.deadline {
            Err(io::ErrorKind::TimedOut.into())
        } else {
            Ok(())
        }
    }

    fn poll(&self, fds: &mut [libc::pollfd]) -> io::Result<()> {
        loop {
            self.check()?;
            let ms = self
                .deadline
                .saturating_duration_since(Instant::now())
                .as_millis();
            let timeout =
                i32::try_from(ms.clamp(1, CANCELLATION_POLL_MS)).map_err(io::Error::other)?;
            let len = libc::nfds_t::try_from(fds.len()).map_err(io::Error::other)?;
            // SAFETY: the initialized array is exclusively borrowed during poll,
            // and each enabled descriptor is owned by a live pipe in the caller.
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), len, timeout) };
            if ready > 0 {
                self.check()?;
                return Ok(());
            }
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }
}

pub(super) struct Pipe<'a> {
    file: File,
    budget: &'a Budget<'a>,
}

impl<'a> Pipe<'a> {
    pub(super) fn reader(file: File, budget: &'a Budget<'a>) -> io::Result<Self> {
        Self::prepare(file, budget, libc::O_RDONLY)
    }

    pub(super) fn writer(file: File, budget: &'a Budget<'a>) -> io::Result<Self> {
        Self::prepare(file, budget, libc::O_WRONLY)
    }

    fn prepare(file: File, budget: &'a Budget<'a>, mode: i32) -> io::Result<Self> {
        if !file.metadata()?.file_type().is_fifo() {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let fd = file.as_raw_fd();
        // SAFETY: owned pipe descriptor; these calls only read/write flags.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 {
            return Err(io::Error::last_os_error());
        }
        if flags & libc::O_ACCMODE != mode {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        // SAFETY: the adapter transfers exclusive ownership of this pipe end.
        if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { file, budget })
    }

    fn pollfd(&self, events: libc::c_short) -> libc::pollfd {
        libc::pollfd {
            fd: self.file.as_raw_fd(),
            events,
            revents: 0,
        }
    }
}

impl Read for Pipe<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            self.budget.poll(&mut [self.pollfd(libc::POLLIN)])?;
            match self.file.read(buf) {
                Err(error) if retry(&error) => continue,
                result => return result,
            }
        }
    }
}

impl Write for Pipe<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        loop {
            self.budget.poll(&mut [self.pollfd(libc::POLLOUT)])?;
            match self.file.write(buf) {
                Err(error) if retry(&error) => continue,
                result => return result,
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        // File writes directly to the OS without user-space buffering.
        self.budget.check()
    }
}

fn retry(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

/// Fill at most one fixed pack chunk, write only when the remote pipe is
/// ready, and drain the bounded report concurrently. Unlike the standalone
/// fixture, no outer child timeout is needed to interrupt pipe writes.
pub(super) fn exchange(
    mut git: Pipe<'_>,
    mut response: Pipe<'_>,
    request: Pipe<'_>,
    report_cap: usize,
) -> io::Result<Vec<u8>> {
    let budget = git.budget;
    let mut request = Some(request);
    let mut report = Vec::new();
    let mut pack = [0; 4096];
    let mut reply = [0; 4096];
    let mut pending = 0..0;
    let mut read_bytes = 0;
    loop {
        let mut fds = [
            response.pollfd(libc::POLLIN),
            if request.is_some() && pending.is_empty() {
                git.pollfd(libc::POLLIN)
            } else {
                disabled()
            },
            match &request {
                Some(sink) if !pending.is_empty() => sink.pollfd(libc::POLLOUT),
                _ => disabled(),
            },
        ];
        budget.poll(&mut fds)?;
        let [remote, local, sink_ready] = fds;
        if remote.revents != 0 {
            match response.file.read(&mut reply) {
                Ok(0) if pending.is_empty() && read_bytes > 0 => return Ok(report),
                Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                Ok(count) if report.len() + count <= report_cap => {
                    report.extend(reply.get(..count).ok_or(io::ErrorKind::InvalidData)?)
                }
                Ok(_) => return Err(io::ErrorKind::InvalidData.into()),
                Err(error) if retry(&error) => {}
                Err(error) => return Err(error),
            }
        }
        if local.revents != 0 {
            match git.file.read(&mut pack) {
                Ok(0) => request = None,
                Ok(count) if read_bytes + count <= PACK_CAP => {
                    read_bytes += count;
                    pending = 0..count;
                }
                Ok(_) => return Err(io::ErrorKind::InvalidData.into()),
                Err(error) if retry(&error) => {}
                Err(error) => return Err(error),
            }
        }
        if sink_ready.revents != 0
            && let Some(sink) = &mut request
        {
            let ready = pack
                .get(pending.clone())
                .ok_or(io::ErrorKind::InvalidData)?;
            match sink.file.write(ready) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => pending.start += count,
                Err(error) if retry(&error) => {}
                Err(error) => return Err(error),
            }
        }
    }
}

fn disabled() -> libc::pollfd {
    // POSIX poll ignores negative descriptors.
    libc::pollfd {
        fd: -1,
        events: 0,
        revents: 0,
    }
}
