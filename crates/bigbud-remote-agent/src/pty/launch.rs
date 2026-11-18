//! Native launch receipt, not executable identity attestation. CLOEXEC EOF is
//! ambiguous under arbitrary pre-exec death on both Linux and macOS. An owned
//! unconfirmed launch is allowed, but this receipt cannot establish actual identity.
use super::{LaunchOutcome, LaunchStage, LaunchUnknown, PtyError};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd};
use std::time::{Duration, Instant};

pub(super) const TIMEOUT: Duration = Duration::from_secs(2);
const FRAME_LEN: usize = 8;

pub(super) struct Receipt {
    pub reader: std::fs::File,
    pub writer: std::fs::File,
}
impl Receipt {
    /// Caller holds the shared spawn gate until both ends are CLOEXEC and the
    /// PTY master is protected. No unrelated production child inherits the pipe.
    pub fn new() -> io::Result<Self> {
        let mut fds = [-1; 2];
        // SAFETY: fds has space for both returned owned pipe descriptors.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful pipe returned two distinct owned descriptors.
        let reader = unsafe { std::fs::File::from_raw_fd(fds[0]) };
        // SAFETY: ownership of the second descriptor is transferred once.
        let writer = unsafe { std::fs::File::from_raw_fd(fds[1]) };
        // forkpty replaces 0/1/2 in the child, even if the parent had one closed.
        let reader = above_stdio(reader)?;
        let writer = above_stdio(writer)?;
        for fd in [reader.as_raw_fd(), writer.as_raw_fd()] {
            // SAFETY: the files own live descriptors; flags have integer values.
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                return Err(io::Error::last_os_error());
            }
        }
        // SAFETY: live pipe read end; O_NONBLOCK bounds reads even after poll.
        if unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) } == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { reader, writer })
    }
}

fn above_stdio(file: std::fs::File) -> io::Result<std::fs::File> {
    if file.as_raw_fd() > libc::STDERR_FILENO {
        return Ok(file);
    }
    // SAFETY: file owns a live fd; fcntl returns a new owned descriptor >= 3.
    let fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if fd == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful duplication transferred this new descriptor to us.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

/// Called only in the fork child, with a freshly captured positive errno.
/// No allocations, Rust locks, formatting, or destructors run in this path.
pub(super) unsafe fn fail(fd: i32, stage: LaunchStage, errno: i32) -> ! {
    let code = errno.to_ne_bytes();
    let frame = [
        b'B',
        b'L',
        1,
        stage as u8,
        code[0],
        code[1],
        code[2],
        code[3],
    ];
    let mut offset = 0;
    while offset < FRAME_LEN {
        // SAFETY: fd is the inherited writer; pointer and length are in frame.
        let written =
            unsafe { libc::write(fd, frame.as_ptr().add(offset).cast(), FRAME_LEN - offset) };
        if written > 0 {
            offset += written as usize;
        } else if written == -1 && errno_value() == libc::EINTR {
            continue;
        } else {
            break; // Parent reports unknown if a complete receipt was not delivered.
        }
    }
    // SAFETY: never unwind or run inherited Rust destructors after fork.
    unsafe {
        libc::_exit(if stage == LaunchStage::Chdir {
            126
        } else {
            127
        })
    }
}

/// libc's thread-local errno accessor; does not allocate or take a Rust lock.
pub(super) fn errno_value() -> i32 {
    #[cfg(target_os = "linux")]
    // SAFETY: libc provides a valid thread-local errno pointer.
    unsafe {
        *libc::__errno_location()
    }
    #[cfg(target_os = "macos")]
    // SAFETY: libc provides a valid thread-local errno pointer.
    unsafe {
        *libc::__error()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    compile_error!("PTY launch receipt needs an async-signal-safe errno accessor");
}

pub(super) fn receive(
    mut reader: std::fs::File,
    timeout: Duration,
) -> Result<LaunchOutcome, PtyError> {
    let deadline = Instant::now() + timeout;
    let mut frame = [0; FRAME_LEN + 1];
    let mut used = 0;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(PtyError::LaunchUnknown(LaunchUnknown::Timeout));
        }
        let mut pollfd = libc::pollfd {
            fd: reader.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: pollfd is live, initialized, and describes our owned read end.
        let result =
            unsafe { libc::poll(&mut pollfd, 1, remaining.as_millis().clamp(1, 100) as i32) };
        if result < 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(PtyError::LaunchUnknown(LaunchUnknown::ChannelError));
        }
        if result == 0 {
            continue;
        }
        let Some(unfilled) = frame.get_mut(used..) else {
            return Err(PtyError::LaunchUnknown(LaunchUnknown::MalformedReceipt));
        };
        match reader.read(unfilled) {
            Ok(0) if used == 0 => {
                return Ok(LaunchOutcome::Unconfirmed(LaunchUnknown::ChannelClosed));
            }
            Ok(0) => return Err(PtyError::LaunchUnknown(LaunchUnknown::PartialReceipt)),
            Ok(size) => {
                used += size;
                if used >= FRAME_LEN {
                    if used != FRAME_LEN || frame[..3] != [b'B', b'L', 1] {
                        return Err(PtyError::LaunchUnknown(LaunchUnknown::MalformedReceipt));
                    }
                    let stage = match frame[3] {
                        1 => LaunchStage::Chdir,
                        2 => LaunchStage::Exec,
                        _ => return Err(PtyError::LaunchUnknown(LaunchUnknown::MalformedReceipt)),
                    };
                    let errno = i32::from_ne_bytes([frame[4], frame[5], frame[6], frame[7]]);
                    if errno <= 0 {
                        return Err(PtyError::LaunchUnknown(LaunchUnknown::MalformedReceipt));
                    }
                    return Err(PtyError::LaunchFailed { stage, errno });
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => return Err(PtyError::LaunchUnknown(LaunchUnknown::ChannelError)),
        }
    }
}

#[cfg(test)]
#[path = "launch.cleanup.tests.rs"]
mod cleanup_tests;
#[cfg(test)]
#[path = "launch.tests.rs"]
mod tests;
