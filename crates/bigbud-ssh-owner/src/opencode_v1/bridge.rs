//! A disposable byte relay from the startup reservation to one owner socket.

#[path = "bridge.socket.rs"]
mod socket;
#[cfg(test)]
#[path = "bridge.tests.rs"]
mod tests;

use super::Startup;
use std::io::{self, ErrorKind, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::{fd::AsRawFd, unix::net::UnixStream};
use std::path::Path;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_CONNECTIONS: usize = 16;
const BUFFER_BYTES: usize = 8 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const POLL_FDS: usize = 2 + 2 * MAX_CONNECTIONS;
const READABLE: libc::c_short = libc::POLLIN | libc::POLLHUP;
const WRITABLE: libc::c_short = libc::POLLOUT | libc::POLLHUP;
const FAILED: libc::c_short = libc::POLLERR | libc::POLLNVAL;

/// Owns a single nonblocking worker and its listener clone. The caller must also
/// drop the original `Startup` reservation to release the listening port.
#[must_use = "keep the bridge alive until confirmed shutdown"]
pub struct Bridge {
    worker: Option<Worker>,
}

impl Bridge {
    /// `socket` is the path to a local Unix stream socket in an owner-controlled
    /// directory. Never pass a product input, request parameter, or child output.
    /// This borrows the reservation without rebinding its IPv4 loopback port.
    pub fn start(startup: &Startup, socket: &Path) -> io::Result<Self> {
        Self::start_listener(startup.listener(), socket)
    }

    /// The same relay over an arbitrary owner-retained loopback listener. The
    /// listener must already be bound and nonblocking; it is only cloned.
    pub fn start_listener(listener: &TcpListener, socket: &Path) -> io::Result<Self> {
        let socket = socket::Destination::new(socket)?;
        let listener = listener.try_clone()?;
        let (stop, wake) = UnixStream::pair()?;
        let handle = thread::Builder::new()
            .name("opencode-v1-bridge".into())
            .spawn(move || serve(listener, &wake, &socket))?;
        Ok(Self {
            worker: Some(Worker { stop, handle }),
        })
    }

    /// A liveness check for the owner; not a replacement for `Startup::poll_ready`.
    pub fn is_finished(&self) -> bool {
        self.worker
            .as_ref()
            .is_none_or(|worker| worker.handle.is_finished())
    }

    /// Cancels immediately even with backpressured peers, then joins the worker.
    /// Returns only after the worker-owned descriptors have been released.
    pub fn shutdown(mut self) -> io::Result<()> {
        self.join()
    }

    fn join(&mut self) -> io::Result<()> {
        let Some(Worker { stop, handle }) = self.worker.take() else {
            return Ok(());
        };
        // Closing this end wakes poll. Unlike a queued command, it cannot block.
        drop(stop);
        handle
            .join()
            .map_err(|_| io::Error::other("OpenCode bridge worker panicked"))?
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // Still join on implicit cleanup. Only explicit shutdown reports errors.
        let _ = self.join();
    }
}

struct Worker {
    stop: UnixStream,
    handle: JoinHandle<io::Result<()>>,
}

fn serve(listener: TcpListener, wake: &UnixStream, socket: &socket::Destination) -> io::Result<()> {
    let mut connections: Vec<Connection> = Vec::with_capacity(MAX_CONNECTIONS);
    loop {
        let mut fds = [pollfd(-1, 0); POLL_FDS];
        let [wake_fd, listener_fd, connection_fds @ ..] = &mut fds;
        *wake_fd = pollfd(wake.as_raw_fd(), libc::POLLIN);
        // Still accept at capacity, then immediately close the excess TCP stream.
        *listener_fd = pollfd(listener.as_raw_fd(), libc::POLLIN);
        let mut deadline = None;
        for ([tcp, unix], connection) in connection_fds
            .as_chunks_mut::<2>()
            .0
            .iter_mut()
            .zip(&connections)
        {
            (*tcp, *unix) = connection.pollfds();
            if let Some(next) = connection.connect_deadline {
                deadline = Some(deadline.map_or(next, |current: Instant| current.min(next)));
            }
        }
        let timeout = match deadline {
            Some(deadline) => {
                let ms = deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis();
                // Round up to avoid busy waiting during the final millisecond.
                i32::try_from(ms + 1).map_err(io::Error::other)?
            }
            None => -1,
        };
        let nfds = libc::nfds_t::try_from(2 + 2 * connections.len()).map_err(io::Error::other)?;
        // SAFETY: the initialized array is borrowed exclusively; each enabled
        // descriptor remains owned by the listener, wake stream, or a connection.
        if unsafe { libc::poll(fds.as_mut_ptr(), nfds, timeout) } < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let [wake_fd, listener_fd, connection_fds @ ..] = &fds;
        if wake_fd.revents & FAILED != 0 {
            return Err(io::Error::other(
                "OpenCode bridge wake socket became unavailable",
            ));
        }
        if wake_fd.revents != 0 {
            return Ok(());
        }
        if listener_fd.revents & (FAILED | libc::POLLHUP) != 0 {
            return Err(io::Error::other(
                "OpenCode bridge listener became unavailable",
            ));
        }
        // Reverse traversal keeps poll indices valid with swap_remove. A failed
        // stream dies locally and never causes retry/replay or stops other streams.
        for (i, [tcp, unix]) in connection_fds
            .as_chunks::<2>()
            .0
            .iter()
            .take(connections.len())
            .enumerate()
            .rev()
        {
            let Some(connection) = connections.get_mut(i) else {
                return Err(io::Error::other("OpenCode bridge poll index out of bounds"));
            };
            if !matches!(connection.advance(tcp.revents, unix.revents), Ok(true)) {
                drop(connections.swap_remove(i));
            }
        }
        if listener_fd.revents & libc::POLLIN != 0 {
            match listener.accept() {
                Ok((tcp, _)) if connections.len() < MAX_CONNECTIONS => {
                    if let Ok(connection) = Connection::open(tcp, socket) {
                        connections.push(connection);
                    }
                }
                Ok((excess, _)) => drop(excess),
                Err(error) if retry(&error) || error.kind() == ErrorKind::ConnectionAborted => {}
                Err(error) => return Err(error),
            }
        }
    }
}

fn pollfd(fd: libc::c_int, events: libc::c_short) -> libc::pollfd {
    // Ignore inactive directions entirely; HUP is reported even without events.
    libc::pollfd {
        fd: if events == 0 { -1 } else { fd },
        events,
        revents: 0,
    }
}

struct Connection {
    tcp: TcpStream,
    unix: UnixStream,
    to_unix: Direction,
    to_tcp: Direction,
    connect_deadline: Option<Instant>,
}

impl Connection {
    fn open(tcp: TcpStream, socket: &socket::Destination) -> io::Result<Self> {
        tcp.set_nonblocking(true)?;
        let (unix, connected) = socket.connect()?;
        Ok(Self {
            tcp,
            unix,
            to_unix: Direction::new(),
            to_tcp: Direction::new(),
            connect_deadline: (!connected).then(|| Instant::now() + CONNECT_TIMEOUT),
        })
    }

    fn pollfds(&self) -> (libc::pollfd, libc::pollfd) {
        let (tcp, unix) = if self.connect_deadline.is_some() {
            (0, libc::POLLOUT)
        } else {
            (
                self.to_unix.read_event() | self.to_tcp.write_event(),
                self.to_tcp.read_event() | self.to_unix.write_event(),
            )
        };
        (
            pollfd(self.tcp.as_raw_fd(), tcp),
            pollfd(self.unix.as_raw_fd(), unix),
        )
    }

    fn advance(&mut self, tcp: libc::c_short, unix: libc::c_short) -> io::Result<bool> {
        if (tcp | unix) & FAILED != 0 {
            return Ok(false);
        }
        if let Some(deadline) = self.connect_deadline {
            if Instant::now() >= deadline || unix & libc::POLLHUP != 0 {
                return Ok(false);
            }
            if unix & libc::POLLOUT != 0 {
                if let Some(error) = self.unix.take_error()? {
                    return Err(error);
                }
                self.connect_deadline = None;
            }
            return Ok(true);
        }
        // Read only with an empty buffer, then drain before reading again.
        // Therefore EOF always follows the last forwarded byte in that direction.
        if tcp & READABLE != 0 && self.to_unix.read(&self.tcp)? {
            self.unix.shutdown(Shutdown::Write)?;
        }
        if unix & READABLE != 0 && self.to_tcp.read(&self.unix)? {
            self.tcp.shutdown(Shutdown::Write)?;
        }
        if unix & WRITABLE != 0 {
            self.to_unix.write(&self.unix)?;
        }
        if tcp & WRITABLE != 0 {
            self.to_tcp.write(&self.tcp)?;
        }
        Ok(!self.to_tcp.eof || !self.to_unix.eof)
    }
}

struct Direction {
    bytes: [u8; BUFFER_BYTES],
    start: usize,
    end: usize,
    eof: bool,
}

impl Direction {
    fn new() -> Self {
        Self {
            bytes: [0; BUFFER_BYTES],
            start: 0,
            end: 0,
            eof: false,
        }
    }

    fn read_event(&self) -> libc::c_short {
        if self.start == self.end && !self.eof {
            libc::POLLIN
        } else {
            0
        }
    }

    fn write_event(&self) -> libc::c_short {
        if self.start < self.end {
            libc::POLLOUT
        } else {
            0
        }
    }

    fn read(&mut self, mut source: impl Read) -> io::Result<bool> {
        if self.read_event() == 0 {
            return Ok(false);
        }
        match source.read(&mut self.bytes) {
            Ok(0) => self.eof = true,
            Ok(len) => {
                self.start = 0;
                self.end = len;
            }
            Err(error) if retry(&error) => {}
            Err(error) => return Err(error),
        }
        Ok(self.eof)
    }

    fn write(&mut self, mut destination: impl Write) -> io::Result<()> {
        if self.write_event() == 0 {
            return Ok(());
        }
        let pending = self
            .bytes
            .get(self.start..self.end)
            .ok_or_else(|| io::Error::other("OpenCode bridge buffer index out of bounds"))?;
        match destination.write(pending) {
            Ok(0) => return Err(ErrorKind::WriteZero.into()),
            Ok(len) => self.start += len,
            Err(error) if retry(&error) => {}
            Err(error) => return Err(error),
        }
        Ok(())
    }
}

fn retry(error: &io::Error) -> bool {
    matches!(error.kind(), ErrorKind::Interrupted | ErrorKind::WouldBlock)
}
