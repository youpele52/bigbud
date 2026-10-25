use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bigbud_protocol::{PROTOCOL_MAJOR, PROTOCOL_MINOR, v1};
use thiserror::Error;

use crate::operations;
use crate::operations::journal::MAX_OPERATION_JOURNAL_BYTES;
use crate::operations::{
    AcceptResult, JournalRecord, OperationError, OperationJournal, OperationRegistry,
    OperationState, OutputStream,
};
use crate::process::{self, ProcessOptions, run_bounded_process};
use crate::pty;
use crate::workspace::{WorkspaceError, WorkspaceRoot};

#[path = "hello.rs"]
mod hello;
#[path = "journal_restore.rs"]
mod journal_restore;
#[path = "operation_handlers.rs"]
mod operation_handlers;
#[path = "process_attach.rs"]
mod process_attach;
#[path = "process_handlers.rs"]
mod process_handlers;
#[path = "protocol_helpers.rs"]
mod protocol_helpers;
#[path = "pty_controls.rs"]
mod pty_controls;
#[path = "pty_handlers.rs"]
mod pty_handlers;
pub use pty_controls::{PreparedPtyControl, is_pty_control};
use pty_handlers::PtySession;
#[path = "retirement.rs"]
mod retirement;
#[path = "workspace_handlers.rs"]
mod workspace_handlers;
#[path = "workspace_watch_handlers.rs"]
mod workspace_watch_handlers;

#[cfg(test)]
#[path = "accepted_operations.tests.rs"]
mod accepted_operations_tests;
#[cfg(test)]
#[path = "journal_restore.tests.rs"]
mod journal_restore_tests;
#[cfg(test)]
#[path = "process_attach.tests.rs"]
mod process_attach_tests;
#[cfg(test)]
#[path = "pty_handlers.tests.rs"]
mod pty_handler_tests;
#[cfg(test)]
#[path = "test_helpers.rs"]
mod test_helpers;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;

use journal_restore::restore_process_journal;
pub use protocol_helpers::protocol_error_frame;
use protocol_helpers::{
    operation_error, process_attach_response_frame, process_completed_frame, process_environment,
    process_environment_from_entries, process_output_frame, pty_attach_response_frame,
    pty_control_response_frame, pty_create_response_frame, pty_exited_frame, pty_output_frame,
    workspace_error_code,
};

/// How long a terminal process result (state, exit code, output watermark)
/// and an accepted-operation identity are kept. Long enough to survive a
/// laptop sleep; retained output stays bounded by the per-operation and
/// journal byte caps, and running work never expires.
const PROCESS_RESULT_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
const ACCEPTED_OPERATION_RETENTION: Duration = PROCESS_RESULT_RETENTION;
const MAX_ACCEPTED_OPERATIONS: usize = 256;
const MAX_CONCURRENT_PROCESS_OPERATIONS: usize = 32;
const MAX_PROCESS_OPERATIONS: usize = 256;
const MAX_PTY_SESSIONS: usize = 64;
const MAX_WORKSPACE_ROOTS: usize = 64;
const PTY_RESULT_RETENTION: Duration = Duration::from_secs(600);

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("the first frame must be client hello")]
    HelloRequired,
    #[error("unsupported protocol major version {actual}; supported version is {supported}")]
    UnsupportedProtocolMajor { actual: u32, supported: u32 },
    #[error("client instance ID is required")]
    MissingClientInstanceId,
    #[error("operation ID is required")]
    MissingOperationId,
    #[error("operation ID conflicts with an earlier request digest")]
    OperationIdConflict,
    #[error("workspace handle is required")]
    MissingWorkspaceHandle,
    #[error("workspace watch subscription ID is required")]
    MissingWorkspaceWatchSubscriptionId,
    #[error("workspace handle is not open: {0}")]
    UnknownWorkspace(String),
    #[error("agent resource limit reached: {0}")]
    ResourceLimit(String),
    #[error("process operation failed: {0}")]
    Process(String),
    #[error("process replay failed: {0}")]
    ProcessReplay(String),
    #[error("process journal failed: {0}")]
    ProcessJournal(String),
    #[error("PTY operation failed: {0}")]
    Pty(String),
    #[error("system clock is before Unix epoch")]
    ClockBeforeUnixEpoch(#[source] std::time::SystemTimeError),
    #[error("unexpected message after handshake")]
    UnexpectedMessage,
    #[error("supervisor is stopping and is not accepting new work")]
    Restarting,
}

pub struct AgentSession {
    ready: bool,
    accepting_work: bool,
    accepted_operations: HashMap<String, AcceptedOperation>,
    process_operations: OperationRegistry,
    process_journal: Option<OperationJournal>,
    process_cancellations: HashMap<String, Arc<AtomicBool>>,
    pty_sessions: HashMap<String, PtySession>,
    workspace_roots: HashMap<String, WorkspaceRoot>,
    agent_instance_id: String,
    agent_epoch: String,
}

struct AcceptedOperation {
    request_digest: Vec<u8>,
    expires_at: Instant,
}

#[derive(Clone)]
pub struct ProcessJob {
    pub request_id: String,
    pub operation_id: String,
    pub workspace_root: std::path::PathBuf,
    pub command: String,
    pub args: Vec<String>,
    pub environment: Vec<(String, String)>,
    pub stdin: Vec<u8>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
    pub cancellation: Arc<AtomicBool>,
}

pub struct PreparedProcess {
    pub responses: Vec<v1::Frame>,
    pub job: Option<ProcessJob>,
}

pub use workspace_watch_handlers::{PreparedWorkspaceWatch, workspace_watch_event_frame};

impl AgentSession {
    pub fn new() -> Result<Self, SessionError> {
        let epoch = session_epoch(SystemTime::now())?;
        Ok(Self::with_epoch(epoch))
    }

    pub fn with_epoch(epoch: impl Into<String>) -> Self {
        Self::with_epoch_and_journal_inner(epoch.into(), None)
    }

    pub fn with_epoch_and_journal(
        epoch: impl Into<String>,
        journal_path: impl AsRef<std::path::Path>,
    ) -> Result<Self, SessionError> {
        let journal = OperationJournal::open(journal_path, MAX_OPERATION_JOURNAL_BYTES)
            .map_err(|error| SessionError::ProcessJournal(error.to_string()))?;
        let mut session = Self::with_epoch_and_journal_inner(epoch.into(), Some(journal));
        let now = Instant::now();
        if let Some(journal) = &session.process_journal {
            let records = journal
                .records()
                .map_err(|error| SessionError::ProcessJournal(error.to_string()))?;
            restore_process_journal(&mut session.process_operations, records, now)?;
        }
        session.process_operations.expire_non_terminal(now);
        Ok(session)
    }

    fn with_epoch_and_journal_inner(
        epoch: String,
        process_journal: Option<OperationJournal>,
    ) -> Self {
        Self {
            ready: false,
            accepting_work: true,
            accepted_operations: HashMap::new(),
            process_operations: OperationRegistry::new(
                MAX_PROCESS_OPERATIONS,
                8 * 1024 * 1024,
                PROCESS_RESULT_RETENTION,
            )
            .with_terminal_output_budget(MAX_OPERATION_JOURNAL_BYTES),
            process_journal,
            process_cancellations: HashMap::new(),
            pty_sessions: HashMap::new(),
            workspace_roots: HashMap::new(),
            agent_instance_id: format!("agent-{}", std::process::id()),
            agent_epoch: epoch,
        }
    }

    pub fn handle(&mut self, frame: v1::Frame) -> Result<v1::Frame, SessionError> {
        match frame.payload {
            Some(v1::frame::Payload::ClientHello(hello)) => self.handle_client_hello(hello),
            Some(v1::frame::Payload::DiagnosticRequest(request)) if self.ready => {
                self.handle_diagnostic_request(request)
            }
            Some(v1::frame::Payload::CancelRequest(request)) if self.ready => {
                self.handle_cancel_request(request)
            }
            _ if self.ready && !self.accepting_work => Err(SessionError::Restarting),
            Some(v1::frame::Payload::WorkspaceOpenRequest(request)) if self.ready => {
                Ok(self.handle_workspace_open(request))
            }
            Some(v1::frame::Payload::ReadFileRequest(request)) if self.ready => {
                self.handle_read_file(request)
            }
            Some(v1::frame::Payload::ListDirectoryRequest(request)) if self.ready => {
                self.handle_list_directory(request)
            }
            Some(v1::frame::Payload::FilenameSearchRequest(request)) if self.ready => {
                self.handle_filename_search(request)
            }
            Some(v1::frame::Payload::ContentSearchRequest(request)) if self.ready => {
                self.handle_content_search(request)
            }
            Some(v1::frame::Payload::WriteFileRequest(request)) if self.ready => {
                self.handle_write_file(request)
            }
            Some(v1::frame::Payload::ProcessRequest(request)) if self.ready => self
                .handle_process_request(request)
                .and_then(|mut responses| responses.pop().ok_or(SessionError::UnexpectedMessage)),
            Some(v1::frame::Payload::ProcessAttachRequest(request)) if self.ready => self
                .handle_process_attach(request)
                .and_then(|mut responses| responses.pop().ok_or(SessionError::UnexpectedMessage)),
            Some(v1::frame::Payload::ProcessOutputAck(request)) if self.ready => {
                Ok(self.handle_process_output_ack(request))
            }
            Some(v1::frame::Payload::PtyInput(request)) if self.ready => {
                Ok(self.handle_pty_input(request))
            }
            Some(v1::frame::Payload::PtyOutputAck(request)) if self.ready => {
                Ok(self.handle_pty_output_ack(request))
            }
            Some(v1::frame::Payload::PtyResizeRequest(request)) if self.ready => {
                Ok(self.handle_pty_resize(request))
            }
            Some(v1::frame::Payload::PtySignalRequest(request)) if self.ready => {
                Ok(self.handle_pty_signal(request))
            }
            Some(v1::frame::Payload::PtyCloseRequest(request)) if self.ready => {
                Ok(self.handle_pty_close(request))
            }
            _ if !self.ready => Err(SessionError::HelloRequired),
            _ => Err(SessionError::UnexpectedMessage),
        }
    }
}

fn session_epoch(now: SystemTime) -> Result<String, SessionError> {
    now.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .map_err(SessionError::ClockBeforeUnixEpoch)
}
