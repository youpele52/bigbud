use std::io;
use std::path::Path;
use std::sync::Arc;

#[cfg(unix)]
use std::collections::VecDeque;
#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::sync::Mutex;

#[cfg(unix)]
use std::os::fd::AsRawFd;

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
    #[error("PTY input sequence conflicts with its reserved digest")]
    InputConflict,
    #[error("PTY input outcome expired or is unknown; it cannot be replayed")]
    InputExpired,
    #[error("PTY input is fenced after cancellation or uncertain delivery")]
    InputFenced,
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
    master: Mutex<Option<std::fs::File>>,
    child: Arc<child::Child>,
    input: input::InputWriter,
    state: Mutex<PtyStateRecord>,
}

#[cfg(unix)]
struct PtyStateRecord {
    state: PtyState,
    next_sequence: u64,
    first_retained_sequence: u64,
    retained_bytes: usize,
    output: VecDeque<PtyOutputChunk>,
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

#[path = "handle.rs"]
mod handle;

#[cfg(unix)]
#[path = "child.rs"]
mod child;
#[cfg(unix)]
#[path = "cleanup.rs"]
mod cleanup;
#[cfg(unix)]
#[path = "input.rs"]
mod input;
#[cfg(unix)]
#[path = "platform.rs"]
mod platform;
#[cfg(unix)]
pub use cleanup::{CleanupOwner, settled as pending_cleanup_settled};
#[cfg(unix)]
pub use input::InputOutcome;

#[cfg(unix)]
#[path = "environment.rs"]
mod environment;

#[cfg(all(test, unix))]
#[path = "reliability.tests.rs"]
mod reliability_tests;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(unix)]
#[allow(clippy::indexing_slicing)]
pub fn run_events(
    mut reader: std::fs::File,
    handle: &PtyHandle,
    mut callback: impl FnMut(PtyEvent),
) {
    let mut buffer = [0; READ_CHUNK_BYTES];
    let mut exit = None;
    while let Ok(result) = handle.inner.child.poll() {
        exit = result;
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => callback(PtyEvent::Output(buffer[..size].to_vec())),
            Err(error) if error.raw_os_error() == Some(libc::EIO) => break,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                if exit.is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    // EOF can precede actual child exit. This owned worker polls without holding
    // state locks; restart escalation can still signal the live leader authority.
    while exit.is_none() {
        match handle.inner.child.poll() {
            Ok(result) => exit = result,
            Err(_) => return,
        }
        if exit.is_none() {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    if let Some(exit) = exit {
        if handle.inner.input.shutdown().is_err() {
            return;
        }
        callback(PtyEvent::Exited {
            exit_code: exit.code,
            signal: exit.signal,
        });
    }
}

#[cfg(not(unix))]
pub fn run_events(_reader: (), _pid: u32, _callback: impl FnMut(PtyEvent)) {}

#[cfg(unix)]
pub fn read_events(reader: std::fs::File, handle: &PtyHandle) -> Vec<PtyEvent> {
    let mut events = Vec::new();
    run_events(reader, handle, |event| events.push(event));
    events
}

#[cfg(unix)]
fn poisoned() -> PtyError {
    PtyError::Io(io::Error::other("PTY state lock was poisoned"))
}
