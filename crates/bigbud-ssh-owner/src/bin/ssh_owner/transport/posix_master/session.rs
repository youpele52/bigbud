//! Only the disposable folder picker, on an already verified mux v4 stream.

pub(super) mod agent;
#[cfg(any(test, target_os = "linux"))]
pub(super) mod forward;
mod stdio;
#[cfg(test)]
mod tests;

use super::super::folders;
use super::{Cancel, ErrorCode, Folders, LOST, TICK, checkpoint, probe};
use std::io::{self, PipeReader, Read};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::time::Instant;

const OUTPUT_CAP: usize = 1024 * 1024;
const NEW_SESSION: u32 = 0x1000_0002;
const REQUEST_ID: u32 = 2; // ALIVE_CHECK used 1 on this same stream.
const EXIT_MESSAGE: u32 = 0x8000_0004;
const SESSION_OPENED: u32 = 0x8000_0006;
const TIMED_OUT: ErrorCode = ErrorCode::ListTimedOut;

pub(super) struct Picker(Vec<u8>);

impl Picker {
    pub(super) fn new(path: Option<&str>) -> Result<Self, ErrorCode> {
        let command = folders::command(path)?;
        let length = u32::try_from(command.len()).map_err(|_| ErrorCode::InvalidOperands)?;
        // No tty, X11, agent, subsystem, term or environment is sent.
        let words = [NEW_SESSION, REQUEST_ID, 0, 0, 0, 0, 0, u32::MAX, 0, length];
        let header = std::mem::size_of_val(&words);
        let mut frame = Vec::with_capacity(4 + header + command.len());
        frame.extend_from_slice(&(header as u32 + length).to_be_bytes());
        frame.extend(words.into_iter().flat_map(u32::to_be_bytes));
        frame.extend_from_slice(command.as_bytes());
        Ok(Self(frame))
    }

    pub(super) fn run(self, stream: &UnixStream, deadline: Instant) -> Result<Output, ErrorCode> {
        self.run_with(stream, deadline, None)
    }

    pub(super) fn run_with(
        self,
        mut stream: &UnixStream,
        deadline: Instant,
        cancel: Cancel<'_>,
    ) -> Result<Output, ErrorCode> {
        checkpoint(cancel)?;
        let fds = stdio::Stdio::new()?;
        let classify_io = |error| {
            if error == LOST && Instant::now() >= deadline {
                TIMED_OUT
            } else {
                error
            }
        };
        probe::write_with(&mut stream, &self.0, deadline, cancel).map_err(classify_io)?;
        let output = fds.send(stream, deadline, cancel)?;
        let mut opened = [0; 16];
        probe::read_with(&mut stream, &mut opened, deadline, cancel).map_err(classify_io)?;
        let [length, kind, request, id] = words(&opened);
        if (length, kind, request) != (12, SESSION_OPENED, REQUEST_ID) {
            return Err(LOST);
        }
        collect(stream, output, id, deadline, cancel)
    }
}

pub(super) struct Output {
    status: u32,
    bytes: Vec<u8>,
    truncated: bool,
}

impl Output {
    pub(super) fn folders(self) -> Result<Folders, ErrorCode> {
        // Even 255 is a remote exit status if it came from EXIT_MESSAGE;
        // an absent final status is a mux/transport error, never a remote result.
        match self.status {
            0 => folders::parse(&self.bytes, self.truncated),
            3 => Err(ErrorCode::ListPathUnavailable),
            _ => Err(ErrorCode::ListFailed),
        }
    }
}

fn collect(
    mut stream: &UnixStream,
    mut stdout: PipeReader,
    id: u32,
    deadline: Instant,
    cancel: Cancel<'_>,
) -> Result<Output, ErrorCode> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut fds = [poll_read(stream.as_raw_fd()), poll_read(stdout.as_raw_fd())];
    let mut final_reply = FinalReply::new(id);
    let mut buffer = [0; 8192];
    // OpenSSH can emit EXIT_MESSAGE before it has drained stdout, and closes
    // the control channel after session cleanup. Wait for both EOFs; stopping
    // at the final message could cut off the tail of the listing.
    while fds.iter().any(|fd| fd.fd >= 0) {
        poll(&mut fds, deadline, cancel)?;
        if fds[0].revents != 0 && final_reply.read(&mut stream)? {
            fds[0].fd = -1;
        }
        if fds[1].revents != 0 {
            match stdout.read(&mut buffer) {
                Ok(0) => fds[1].fd = -1,
                Ok(count) => {
                    let keep = count.min(OUTPUT_CAP - bytes.len());
                    bytes.extend_from_slice(buffer.get(..keep).ok_or(LOST)?);
                    truncated |= count > keep;
                }
                Err(error) if transient(&error) => (),
                Err(_) => return Err(LOST),
            }
        }
    }
    Ok(Output {
        status: final_reply.status.ok_or(LOST)?,
        bytes,
        truncated,
    })
}

struct FinalReply {
    id: u32,
    packet: [u8; 16],
    used: usize,
    status: Option<u32>,
}

impl FinalReply {
    fn new(id: u32) -> Self {
        Self {
            id,
            packet: [0; 16],
            used: 0,
            status: None,
        }
    }

    fn read(&mut self, stream: &mut &UnixStream) -> Result<bool, ErrorCode> {
        let mut extra = [0; 1];
        let target = if self.status.is_some() {
            &mut extra[..]
        } else {
            self.packet.get_mut(self.used..).ok_or(LOST)?
        };
        match stream.read(target) {
            Ok(0) if self.status.is_some() => Ok(true),
            Ok(0) => Err(LOST),
            Ok(_) if self.status.is_some() => Err(LOST),
            Ok(count) => {
                self.used += count;
                if self.used == self.packet.len() {
                    let [length, kind, id, status] = words(&self.packet);
                    if (length, kind, id) != (12, EXIT_MESSAGE, self.id) {
                        return Err(LOST);
                    }
                    self.status = Some(status);
                }
                Ok(false)
            }
            Err(error) if transient(&error) => Ok(false),
            Err(_) => Err(LOST),
        }
    }
}

pub(super) fn words(bytes: &[u8; 16]) -> [u32; 4] {
    let [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p] = *bytes;
    [[a, b, c, d], [e, f, g, h], [i, j, k, l], [m, n, o, p]].map(u32::from_be_bytes)
}

fn poll_read(fd: i32) -> libc::pollfd {
    libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    }
}

fn poll(
    fds: &mut [libc::pollfd; 2],
    deadline: Instant,
    cancel: Cancel<'_>,
) -> Result<(), ErrorCode> {
    loop {
        checkpoint(cancel)?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(TIMED_OUT);
        }
        // Only the cancellable fixture wakes periodically while the peer is quiet.
        let wait = if cancel.is_some() {
            remaining.min(TICK)
        } else {
            remaining
        };
        let millis = wait.as_millis().clamp(1, i32::MAX as u128) as i32;
        // SAFETY: the slice has two initialized pollfd entries and the
        // underlying descriptors stay owned by the caller while polling.
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), 2, millis) };
        if ready > 0 {
            return checkpoint(cancel);
        }
        if ready < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(LOST);
        }
    }
}

fn transient(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}
