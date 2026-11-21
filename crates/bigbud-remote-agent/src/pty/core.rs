use std::io;
use std::path::Path;
use std::sync::Arc;

#[cfg(unix)]
use std::collections::VecDeque;
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

/// No native exec proof is currently qualified. This must not be used to
/// advertise authoritative remote profile identity, even for a live PID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchOutcome {
    Unconfirmed(LaunchUnknown),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchUnknown {
    ChannelClosed,
    Timeout,
    PartialReceipt,
    MalformedReceipt,
    ChannelError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum LaunchStage {
    Chdir = 1,
    Exec = 2,
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
    #[error("PTY child launch failed at {stage:?} (errno {errno})")]
    LaunchFailed { stage: LaunchStage, errno: i32 },
    #[error("PTY launch outcome unknown ({0:?}); cleanup retained, do not retry/fallback")]
    LaunchUnknown(LaunchUnknown),
    #[error("PTY operation failed: {0}")]
    Io(#[source] io::Error),
}

#[cfg(unix)]
struct PtyInner {
    master: Mutex<Option<std::fs::File>>,
    child: Arc<child::Child>,
    launch_outcome: LaunchOutcome,
    input: input::InputWriter,
    state: Mutex<PtyStateRecord>,
}

#[cfg(unix)]
struct PtyStateRecord {
    state: PtyState,
    next_sequence: u64,
    first_retained_sequence: u64,
    retained_bytes: usize,
    /// Replay ring cap: `MAX_OUTPUT_BYTES`, or less for a PTY whose screen model and spool
    /// serve restores (terminal lifecycle plan §13 host RSS budget).
    retention_bytes: usize,
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
#[path = "handle.lifecycle.rs"]
mod handle_lifecycle;
pub use handle_lifecycle::RebuildRing;
#[cfg(unix)]
#[path = "launch.rs"]
mod launch;
#[path = "handle.spawn.rs"]
mod spawn;

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
pub use input::{InputOutcome, InputReceipt};

#[cfg(unix)]
#[path = "environment.rs"]
mod environment;
#[cfg(unix)]
#[path = "reader.rs"]
mod reader;
#[cfg(unix)]
pub use reader::{run_events, run_events_gated};

#[cfg(all(test, unix))]
#[path = "reliability.tests.rs"]
mod reliability_tests;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;

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
