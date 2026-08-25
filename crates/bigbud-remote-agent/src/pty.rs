use std::io;
use std::path::Path;
use std::sync::Arc;

#[cfg(unix)]
use std::collections::VecDeque;
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::sync::Mutex;

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};

const MAX_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const READ_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyOutputChunk {
    pub sequence: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtySnapshot {
    pub state: PtyState,
    pub pid: u32,
    pub next_sequence: u64,
    pub first_retained_sequence: u64,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyState {
    Running,
    Exited,
    Closed,
}

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("PTY support is unavailable on this platform")]
    Unsupported,
    #[error("PTY ID is required")]
    MissingId,
    #[error("PTY shell is required")]
    MissingShell,
    #[error("PTY input sequence must be {expected}, received {actual}")]
    InputSequence { expected: u64, actual: u64 },
    #[error("PTY input exceeds the configured 64 KiB limit")]
    InputLimit,
    #[error("PTY output acknowledgement is invalid")]
    InvalidAcknowledgement,
    #[error("PTY replay begins at sequence {first_retained_sequence}")]
    ReplayGap { first_retained_sequence: u64 },
    #[error("PTY is unknown")]
    Unknown,
    #[error("PTY operation failed: {0}")]
    Io(#[source] io::Error),
}

#[cfg(unix)]
struct PtyInner {
    master: Mutex<std::fs::File>,
    state: Mutex<PtyStateRecord>,
}

#[cfg(unix)]
struct PtyStateRecord {
    state: PtyState,
    next_sequence: u64,
    first_retained_sequence: u64,
    retained_bytes: usize,
    output: VecDeque<PtyOutputChunk>,
    last_input_sequence: u64,
    exit_code: Option<i32>,
    signal: Option<i32>,
}

pub struct PtyHandle {
    pub id: String,
    pub pid: u32,
    #[cfg(unix)]
    inner: Arc<PtyInner>,
}

pub struct PtyJob {
    pub handle: Arc<PtyHandle>,
    #[cfg(unix)]
    pub reader: std::fs::File,
}

#[derive(Debug)]
pub enum PtyEvent {
    Output(Vec<u8>),
    Exited {
        exit_code: Option<i32>,
        signal: Option<i32>,
    },
}

#[path = "pty.handle.rs"]
mod handle;

#[cfg(test)]
#[path = "pty.tests.rs"]
mod tests;

#[cfg(unix)]
pub fn run_events(mut reader: std::fs::File, pid: u32, mut callback: impl FnMut(PtyEvent)) {
    let mut buffer = [0; READ_CHUNK_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => callback(PtyEvent::Output(buffer[..size].to_vec())),
            Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
            Err(_) => break,
        }
    }
    let mut status = 0;
    let result = unsafe { libc::waitpid(pid as i32, &mut status, 0) };
    if result > 0 {
        let exit_code = if libc::WIFEXITED(status) {
            Some(libc::WEXITSTATUS(status))
        } else {
            None
        };
        let signal = if libc::WIFSIGNALED(status) {
            Some(libc::WTERMSIG(status))
        } else {
            None
        };
        callback(PtyEvent::Exited { exit_code, signal });
    }
}

#[cfg(not(unix))]
pub fn run_events(_reader: (), _pid: u32, _callback: impl FnMut(PtyEvent)) {}

#[cfg(unix)]
pub fn read_events(reader: std::fs::File, pid: u32) -> Vec<PtyEvent> {
    let mut events = Vec::new();
    run_events(reader, pid, |event| events.push(event));
    events
}

#[cfg(unix)]
fn poisoned() -> PtyError {
    PtyError::Io(io::Error::other("PTY state lock was poisoned"))
}
