use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::journal::JournalRecord;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationState {
    Accepted,
    Running,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
    Expired,
}

impl OperationState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Cancelled | Self::Failed | Self::Expired
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputChunk {
    pub sequence: u64,
    pub stream: OutputStream,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalResult {
    pub state: OperationState,
    pub exit_code: Option<i32>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationSnapshot {
    pub operation_id: String,
    pub state: OperationState,
    pub next_sequence: u64,
    pub first_retained_sequence: u64,
    pub terminal: Option<TerminalResult>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OperationError {
    #[error("operation ID conflicts with an earlier request digest")]
    OperationIdConflict,
    #[error("operation limit has been reached")]
    OperationLimit,
    #[error("operation is unknown or expired")]
    UnknownOperation,
    #[error("operation is already terminal")]
    AlreadyTerminal,
    #[error("operation output chunk exceeds the configured limit")]
    OutputChunkLimit,
    #[error(
        "retained output begins at sequence {first_retained_sequence}; replay requested before that"
    )]
    ReplayGap { first_retained_sequence: u64 },
    #[error("acknowledged sequence is beyond the emitted output")]
    InvalidAcknowledgement,
    #[error("operation journal is inconsistent")]
    JournalCorrupt,
}

#[derive(Debug)]
struct OperationRecord {
    request_digest: Vec<u8>,
    state: OperationState,
    next_sequence: u64,
    first_retained_sequence: u64,
    retained_bytes: usize,
    output: VecDeque<OutputChunk>,
    terminal: Option<TerminalResult>,
    expires_at: Instant,
}

#[derive(Debug)]
pub struct OperationRegistry {
    max_operations: usize,
    max_output_bytes: usize,
    retention: Duration,
    operations: HashMap<String, OperationRecord>,
}

#[path = "registry.rs"]
mod registry;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcceptResult {
    Accepted,
    Duplicate(OperationSnapshot),
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
