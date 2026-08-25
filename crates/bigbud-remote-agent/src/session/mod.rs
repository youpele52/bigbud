use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bigbud_protocol::{PROTOCOL_MAJOR, PROTOCOL_MINOR, v1};
use thiserror::Error;

use crate::operations;
use crate::operations::{
    AcceptResult, JournalRecord, OperationError, OperationJournal, OperationRegistry,
    OperationState, OutputStream,
};
use crate::process::{self, ProcessOptions, run_bounded_process};
use crate::pty;
use crate::workspace::{WorkspaceError, WorkspaceRoot};

#[path = "journal_restore.rs"]
mod journal_restore;
mod process_handlers;
mod protocol_helpers;
mod pty_handlers;
mod workspace_handlers;
mod workspace_watch_handlers;

#[cfg(test)]
#[path = "accepted_operations.tests.rs"]
mod accepted_operations_tests;
#[cfg(test)]
#[path = "journal_restore.tests.rs"]
mod journal_restore_tests;
#[cfg(test)]
#[path = "pty_handlers.tests.rs"]
mod pty_handler_tests;
#[cfg(test)]
mod tests;

use journal_restore::restore_process_journal;
pub use protocol_helpers::protocol_error_frame;
use protocol_helpers::{
    operation_error, process_attach_response_frame, process_completed_frame, process_environment,
    process_environment_from_entries, process_output_frame, pty_attach_response_frame,
    pty_control_response_frame, pty_create_response_frame, pty_exited_frame, pty_output_frame,
    workspace_error_code,
};

const PROCESS_RESULT_RETENTION: Duration = Duration::from_secs(600);
const ACCEPTED_OPERATION_RETENTION: Duration = Duration::from_secs(600);
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
    #[error("unexpected message after handshake")]
    UnexpectedMessage,
}

pub struct AgentSession {
    ready: bool,
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

struct PtySession {
    handle: Arc<pty::PtyHandle>,
    request_digest: Vec<u8>,
    expires_at: Option<Instant>,
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
    pub fn new() -> Self {
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_millis()
            .to_string();
        Self::with_epoch(epoch)
    }

    pub fn with_epoch(epoch: impl Into<String>) -> Self {
        Self::with_epoch_and_journal_inner(epoch.into(), None)
    }

    pub fn with_epoch_and_journal(
        epoch: impl Into<String>,
        journal_path: impl AsRef<std::path::Path>,
    ) -> Result<Self, SessionError> {
        let journal = OperationJournal::open(journal_path, 64 * 1024 * 1024)
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
            accepted_operations: HashMap::new(),
            process_operations: OperationRegistry::new(
                MAX_PROCESS_OPERATIONS,
                8 * 1024 * 1024,
                PROCESS_RESULT_RETENTION,
            ),
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

    fn handle_client_hello(&mut self, hello: v1::ClientHello) -> Result<v1::Frame, SessionError> {
        if hello.protocol_major != PROTOCOL_MAJOR {
            return Err(SessionError::UnsupportedProtocolMajor {
                actual: hello.protocol_major,
                supported: PROTOCOL_MAJOR,
            });
        }
        if hello.client_instance_id.is_empty() {
            return Err(SessionError::MissingClientInstanceId);
        }

        self.ready = true;
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::AgentHello(v1::AgentHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                agent_version: env!("CARGO_PKG_VERSION").to_owned(),
                build_digest: option_env!("BIGBUD_AGENT_BUILD_DIGEST")
                    .unwrap_or(env!("CARGO_PKG_VERSION"))
                    .to_owned(),
                os: std::env::consts::OS.to_owned(),
                architecture: std::env::consts::ARCH.to_owned(),
                agent_instance_id: self.agent_instance_id.clone(),
                agent_epoch: self.agent_epoch.clone(),
                capabilities: [
                    ("diagnostic", 1),
                    ("workspace.files", 1),
                    ("workspace.search", 1),
                    ("workspace.write", 1),
                    ("workspace.watch", 1),
                    ("process.run", 1),
                    ("process.attach", 1),
                    ("terminal.pty", 1),
                ]
                .into_iter()
                .map(|(name, major)| v1::Capability {
                    name: name.to_owned(),
                    major,
                    minor: 0,
                })
                .collect(),
                max_frame_bytes: bigbud_protocol::DEFAULT_MAX_FRAME_BYTES as u64,
                max_operation_output_bytes: 8 * 1024 * 1024,
                max_journal_bytes: 64 * 1024 * 1024,
            })),
        })
    }

    fn handle_diagnostic_request(
        &mut self,
        request: v1::DiagnosticRequest,
    ) -> Result<v1::Frame, SessionError> {
        if request.operation_id.is_empty() {
            return Err(SessionError::MissingOperationId);
        }

        let _ = self.accept_operation(&request.operation_id, request.request_digest)?;

        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::DiagnosticResponse(
                v1::DiagnosticResponse {
                    request_id: request.request_id,
                    operation_id: request.operation_id,
                    accepted: true,
                    terminal: true,
                    message: "agent-ready".to_owned(),
                },
            )),
        })
    }

    fn handle_cancel_request(
        &mut self,
        request: v1::CancelRequest,
    ) -> Result<v1::Frame, SessionError> {
        let (cancelled, terminal, detail) =
            if let Some(signal) = self.process_cancellations.get(&request.operation_id) {
                signal.store(true, std::sync::atomic::Ordering::Relaxed);
                let _ = self
                    .process_operations
                    .begin_cancel(&request.operation_id, Instant::now());
                (true, false, "cancellation-requested")
            } else if let Ok(snapshot) = self
                .process_operations
                .snapshot(&request.operation_id, Instant::now())
            {
                if snapshot.terminal.is_some() {
                    (false, true, "operation-already-terminal")
                } else {
                    (false, false, "operation-cannot-be-cancelled")
                }
            } else {
                (false, true, "operation-unknown-or-expired")
            };
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::CancelResponse(v1::CancelResponse {
                request_id: request.request_id,
                operation_id: request.operation_id,
                cancelled,
                terminal,
                detail: detail.to_owned(),
            })),
        })
    }

    fn accept_operation(
        &mut self,
        operation_id: &str,
        request_digest: Vec<u8>,
    ) -> Result<bool, SessionError> {
        if operation_id.is_empty() {
            return Err(SessionError::MissingOperationId);
        }
        let now = Instant::now();
        self.accepted_operations
            .retain(|_, operation| operation.expires_at > now);
        if let Some(existing) = self.accepted_operations.get(operation_id) {
            if existing.request_digest != request_digest {
                return Err(SessionError::OperationIdConflict);
            }
            return Ok(true);
        } else {
            if self.accepted_operations.len() >= MAX_ACCEPTED_OPERATIONS {
                return Err(SessionError::ResourceLimit(
                    "accepted operation limit reached".to_owned(),
                ));
            }
            self.accepted_operations.insert(
                operation_id.to_owned(),
                AcceptedOperation {
                    request_digest,
                    expires_at: now + ACCEPTED_OPERATION_RETENTION,
                },
            );
        }
        Ok(false)
    }
}
