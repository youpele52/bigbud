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

#[path = "dispatch.rs"]
mod dispatch;
#[path = "hello.rs"]
mod hello;
#[path = "journal_restore.rs"]
mod journal_restore;
#[path = "operation_handlers.rs"]
mod operation_handlers;
#[path = "os_index_search.rs"]
mod os_index_search;
#[path = "paste_staging.rs"]
mod paste_staging;
#[path = "process_attach.rs"]
mod process_attach;
#[path = "process_handlers.rs"]
mod process_handlers;
#[path = "process_identity.rs"]
mod process_identity;
#[path = "protocol_helpers.rs"]
mod protocol_helpers;
#[path = "pty_controls.rs"]
mod pty_controls;
#[path = "pty_create.rs"]
mod pty_create;
#[path = "pty_handlers.rs"]
mod pty_handlers;
#[path = "pty_input_reconcile.rs"]
mod pty_input_reconcile;
#[path = "pty_inventory.rs"]
mod pty_inventory;
#[path = "pty_lifecycle.rs"]
mod pty_lifecycle;
#[path = "pty_lifecycle.handlers.rs"]
mod pty_lifecycle_handlers;
#[path = "pty_lifecycle.host.rs"]
mod pty_lifecycle_host;
#[path = "pty_lifecycle.policy.rs"]
mod pty_lifecycle_policy;
#[path = "pty_lifecycle.responder.rs"]
mod pty_lifecycle_responder;
#[path = "pty_profile.rs"]
mod pty_profile;
#[path = "pty_retention.rs"]
mod pty_retention;
#[path = "pty_screen.rs"]
mod pty_screen;
#[path = "pty_screen.cache.rs"]
mod pty_screen_cache;
#[path = "search.rs"]
mod search;
#[cfg(unix)]
#[path = "service_lease.rs"]
mod service_lease;
pub(crate) use pty_controls::is_blocking_pty_control;
pub use pty_controls::{PreparedPtyControl, is_pty_control};
use pty_handlers::PtySession;
pub(crate) use pty_lifecycle::PtyLifecycle;
pub(crate) use pty_lifecycle_host::{HostLifecycle, HostOptions};
pub(crate) use pty_screen::{SnapshotSource, SnapshotTransfer, produce as produce_snapshot};
#[path = "retirement.rs"]
mod retirement;
#[path = "workspace_entries.rs"]
mod workspace_entries;
#[path = "workspace_handlers.rs"]
mod workspace_handlers;
#[path = "workspace_receipt.rs"]
mod workspace_receipt;
#[path = "workspace_watch_handlers.rs"]
mod workspace_watch_handlers;

#[cfg(test)]
#[path = "accepted_operations.tests.rs"]
mod accepted_operations_tests;
#[cfg(test)]
#[path = "journal_restore.tests.rs"]
mod journal_restore_tests;
#[cfg(test)]
#[path = "os_index_search.tests.rs"]
mod os_index_search_tests;
#[cfg(test)]
#[path = "paste_staging.tests.rs"]
mod paste_staging_tests;
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
#[cfg(test)]
#[path = "workspace_entries.tests.rs"]
mod workspace_entries_tests;
#[cfg(test)]
#[path = "workspace_receipt.tests.rs"]
mod workspace_receipt_tests;
#[cfg(test)]
#[path = "workspace_write.tests.rs"]
mod workspace_write_tests;

use journal_restore::restore_process_journal;
pub use os_index_search::PreparedOsIndexSearch;
pub use protocol_helpers::protocol_error_frame;
use protocol_helpers::{
    operation_error, process_attach_response_frame, process_completed_frame, process_environment,
    process_environment_from_entries, process_output_frame, pty_attach_response_frame,
    pty_control_response_frame, pty_create_response_frame, pty_exited_frame, pty_output_frame,
    validate_local_launch_environment, workspace_error_code,
};
pub use search::PreparedSearch;

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
    #[error("managed service lease is unavailable")]
    ServiceLeaseUnavailable,
}

pub struct AgentSession {
    ready: bool,
    accepting_work: bool,
    accepted_operations: HashMap<String, AcceptedOperation>,
    process_operations: OperationRegistry,
    process_journal: Option<OperationJournal>,
    process_cancellations: HashMap<String, Arc<AtomicBool>>,
    pty_sessions: HashMap<String, PtySession>,
    pty_create_failures: HashMap<String, pty_create::PtyCreateFailure>,
    workspace_roots: HashMap<String, WorkspaceRoot>,
    /// Explicit workspace-root reference counts (plan §8.10).
    workspace_refs: HashMap<String, usize>,
    /// Terminal lifecycle state; only a supervisor (terminal host) enables it.
    terminal_host: Option<Arc<HostLifecycle>>,
    agent_instance_id: String,
    agent_epoch: String,
    paste_staging: Option<crate::paste_staging::PasteStore>,
    search_registry: crate::search::SearchRegistry,
    /// Separate slots so "this computer" never waits behind project searches.
    os_index_registry: crate::search::SearchRegistry,
    os_index: bool,
    /// "This computer" scopes resolved once per (level, home) for the session's lifetime.
    os_index_scopes:
        HashMap<(crate::os_index::OsIndexScopeLevel, std::path::PathBuf), Vec<std::path::PathBuf>>,
    #[cfg(unix)]
    managed_service_lease: Option<Arc<crate::service_lease::Bridge>>,
}

struct AcceptedOperation {
    request_digest: Vec<u8>,
    expires_at: Instant,
    /// SHA-256 of the bytes a write operation put on disk, recorded only after it succeeded;
    /// answers `workspace.write` 1.2 receipt queries.
    result_sha256: Option<String>,
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
            pty_create_failures: HashMap::new(),
            workspace_roots: HashMap::new(),
            workspace_refs: HashMap::new(),
            terminal_host: None,
            agent_instance_id: format!("agent-{}", std::process::id()),
            agent_epoch: epoch,
            paste_staging: None,
            search_registry: crate::search::SearchRegistry::default(),
            os_index_registry: crate::search::SearchRegistry::default(),
            os_index: false,
            os_index_scopes: HashMap::new(),
            #[cfg(unix)]
            managed_service_lease: None,
        }
    }

    /// Turns this session into a terminal host (protocol 1.9 lifecycle, plan R5). The spool
    /// lives under `state_root`; without one, `terminal.spool` is not advertised.
    pub(crate) fn enable_terminal_host(
        &mut self,
        state_root: Option<&std::path::Path>,
        options: HostOptions,
    ) -> Arc<HostLifecycle> {
        let host = HostLifecycle::new(&self.agent_epoch, state_root, options);
        self.terminal_host = Some(Arc::clone(&host));
        host
    }

    /// Enables terminal lifecycle for a supervisor (`--supervisor`): screens, spools under
    /// `state_root`, policy and notices. `local_desktop_host` adds `terminal.local-launch`.
    pub fn enable_terminal_lifecycle(
        &mut self,
        state_root: &std::path::Path,
        local_desktop_host: bool,
    ) {
        let _host = self.enable_terminal_host(
            Some(state_root),
            HostOptions {
                local_desktop_host,
                ..HostOptions::default()
            },
        );
    }

    fn has_managed_service_account(&self) -> bool {
        #[cfg(unix)]
        {
            self.managed_service_lease.is_some()
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
    fn has_active_service_lease(&self) -> bool {
        #[cfg(unix)]
        {
            self.managed_service_lease
                .as_ref()
                .is_some_and(|lease| lease.active())
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
    #[cfg(unix)]
    pub(crate) fn service_lease_for_retirement(&self) -> Option<Arc<crate::service_lease::Bridge>> {
        self.managed_service_lease.as_ref().map(Arc::clone)
    }
}

fn session_epoch(now: SystemTime) -> Result<String, SessionError> {
    now.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .map_err(SessionError::ClockBeforeUnixEpoch)
}
