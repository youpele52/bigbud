use super::*;

const MAX_ENVIRONMENT_ENTRIES: usize = 64;
const MAX_ENVIRONMENT_VALUE_BYTES: usize = 16 * 1024;
const MAX_ENVIRONMENT_BYTES: usize = 256 * 1024;
const ALLOWED_ENVIRONMENT_NAMES: [&str; 21] = [
    "BIGBUD_TEST",
    "CI",
    "COLUMNS",
    "GIT_AUTHOR_DATE",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_NAME",
    "GIT_COMMITTER_DATE",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_ASKPASS",
    "GIT_SSH_COMMAND",
    "GIT_TERMINAL_PROMPT",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "TMPDIR",
    "TZ",
];

pub(super) fn process_environment(
    request: &v1::ProcessRequest,
) -> Result<Vec<(String, String)>, SessionError> {
    process_environment_from_entries(&request.environment)
}

pub(super) fn process_environment_from_entries(
    entries: &[v1::ProcessEnvironment],
) -> Result<Vec<(String, String)>, SessionError> {
    if entries.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err(SessionError::Process(
            "process environment contains too many entries".to_owned(),
        ));
    }
    let mut total_bytes = 0usize;
    entries
        .iter()
        .map(|entry| {
            let valid_name = !entry.name.is_empty()
                && entry.name.bytes().enumerate().all(|(index, byte)| {
                    (index == 0 && (byte == b'_' || byte.is_ascii_uppercase()))
                        || (index > 0
                            && (byte == b'_' || byte.is_ascii_uppercase() || byte.is_ascii_digit()))
                });
            let allowed_name = is_allowed_environment_name(&entry.name);
            total_bytes = total_bytes.saturating_add(entry.name.len() + entry.value.len());
            if !valid_name
                || !allowed_name
                || entry.value.contains('\0')
                || entry.value.len() > MAX_ENVIRONMENT_VALUE_BYTES
                || total_bytes > MAX_ENVIRONMENT_BYTES
            {
                return Err(SessionError::Process(format!(
                    "environment entry '{}' is not permitted by the remote-agent policy",
                    entry.name
                )));
            }
            Ok((entry.name.clone(), entry.value.clone()))
        })
        .collect()
}

fn is_allowed_environment_name(name: &str) -> bool {
    ALLOWED_ENVIRONMENT_NAMES.contains(&name)
        || (name.starts_with("GIT_CONFIG_")
            && (name == "GIT_CONFIG_COUNT"
                || name.strip_prefix("GIT_CONFIG_KEY_").is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
                })
                || name
                    .strip_prefix("GIT_CONFIG_VALUE_")
                    .is_some_and(|suffix| {
                        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
                    })))
}

impl Default for AgentSession {
    fn default() -> Self {
        Self::new()
    }
}

pub fn protocol_error_frame(error: &SessionError) -> v1::Frame {
    let code = match error {
        SessionError::HelloRequired => "HELLO_REQUIRED",
        SessionError::UnsupportedProtocolMajor { .. } => "UNSUPPORTED_PROTOCOL_MAJOR",
        SessionError::MissingClientInstanceId => "MISSING_CLIENT_INSTANCE_ID",
        SessionError::MissingOperationId => "MISSING_OPERATION_ID",
        SessionError::OperationIdConflict => "OPERATION_ID_CONFLICT",
        SessionError::MissingWorkspaceHandle => "MISSING_WORKSPACE_HANDLE",
        SessionError::UnknownWorkspace(_) => "UNKNOWN_WORKSPACE",
        SessionError::ResourceLimit(_) => "RESOURCE_LIMIT",
        SessionError::Process(_) => "PROCESS_ERROR",
        SessionError::ProcessReplay(_) => "PROCESS_REPLAY_ERROR",
        SessionError::ProcessJournal(_) => "PROCESS_JOURNAL_ERROR",
        SessionError::Pty(_) => "PTY_ERROR",
        SessionError::UnexpectedMessage => "UNEXPECTED_MESSAGE",
    };
    v1::Frame {
        payload: Some(v1::frame::Payload::ProtocolError(v1::ProtocolError {
            request_id: String::new(),
            code: code.to_owned(),
            message: error.to_string(),
        })),
    }
}

pub(super) fn operation_error(error: OperationError) -> SessionError {
    SessionError::Process(error.to_string())
}

pub(super) fn process_output_frame(
    operation_id: &str,
    sequence: u64,
    stream: OutputStream,
    bytes: Vec<u8>,
) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::ProcessOutput(v1::ProcessOutput {
            operation_id: operation_id.to_owned(),
            sequence,
            stream: match stream {
                OutputStream::Stdout => "stdout".to_owned(),
                OutputStream::Stderr => "stderr".to_owned(),
            },
            bytes,
        })),
    }
}

pub(super) fn process_completed_frame(
    request_id: &str,
    operation_id: &str,
    terminal: &operations::TerminalResult,
    output_truncated: bool,
) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::ProcessCompleted(v1::ProcessCompleted {
            request_id: request_id.to_owned(),
            operation_id: operation_id.to_owned(),
            state: match terminal.state {
                OperationState::Completed => "completed",
                OperationState::Cancelled => "cancelled",
                OperationState::Failed => "failed",
                OperationState::Expired => "expired",
                _ => "unknown",
            }
            .to_owned(),
            has_exit_code: terminal.exit_code.is_some(),
            exit_code: terminal.exit_code.unwrap_or_default(),
            output_truncated,
            error_code: terminal.error_code.clone().unwrap_or_default(),
            error_message: String::new(),
        })),
    }
}

pub(super) fn process_attach_response_frame(
    request_id: &str,
    snapshot: &operations::OperationSnapshot,
) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::ProcessAttachResponse(
            v1::ProcessAttachResponse {
                request_id: request_id.to_owned(),
                operation_id: snapshot.operation_id.clone(),
                state: operation_state_name(snapshot.state).to_owned(),
                next_sequence: snapshot.next_sequence,
                first_retained_sequence: snapshot.first_retained_sequence,
            },
        )),
    }
}

pub(super) fn pty_create_response_frame(
    request: &v1::PtyCreateRequest,
    accepted: bool,
    pid: u64,
    error_code: &str,
    error_message: &str,
) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::PtyCreateResponse(
            v1::PtyCreateResponse {
                request_id: request.request_id.clone(),
                pty_id: request.pty_id.clone(),
                accepted,
                pid,
                error_code: error_code.to_owned(),
                error_message: error_message.to_owned(),
            },
        )),
    }
}

pub(super) fn pty_output_frame(pty_id: &str, sequence: u64, bytes: Vec<u8>) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::PtyOutput(v1::PtyOutput {
            pty_id: pty_id.to_owned(),
            sequence,
            bytes,
        })),
    }
}

pub(super) fn pty_attach_response_frame(
    request_id: &str,
    pty_id: &str,
    snapshot: &pty::PtySnapshot,
    replay_gap: bool,
) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::PtyAttachResponse(
            v1::PtyAttachResponse {
                request_id: request_id.to_owned(),
                pty_id: pty_id.to_owned(),
                state: pty_state_name(snapshot.state).to_owned(),
                pid: snapshot.pid as u64,
                next_sequence: snapshot.next_sequence,
                first_retained_sequence: snapshot.first_retained_sequence,
                replay_gap,
            },
        )),
    }
}

pub(super) fn pty_exited_frame(
    pty_id: &str,
    exit_code: Option<i32>,
    signal: Option<i32>,
) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::PtyExited(v1::PtyExited {
            pty_id: pty_id.to_owned(),
            exit_code: exit_code.unwrap_or_default(),
            has_exit_code: exit_code.is_some(),
            signal: signal.unwrap_or_default(),
            has_signal: signal.is_some(),
        })),
    }
}

pub(super) fn pty_control_response_frame(
    request_id: String,
    pty_id: String,
    result: Result<(), SessionError>,
    error_code: &str,
    kind: &str,
) -> v1::Frame {
    let (accepted, code, message) = match result {
        Ok(()) => (true, String::new(), String::new()),
        Err(error) => (false, error_code.to_owned(), error.to_string()),
    };
    let payload = match kind {
        "signal" => v1::frame::Payload::PtySignalResponse(v1::PtySignalResponse {
            request_id,
            pty_id,
            accepted,
            error_code: code,
            error_message: message,
        }),
        "close" => v1::frame::Payload::PtyCloseResponse(v1::PtyCloseResponse {
            request_id,
            pty_id,
            accepted,
            error_code: code,
            error_message: message,
        }),
        "input" => v1::frame::Payload::PtyInputResponse(v1::PtyInputResponse {
            request_id,
            pty_id,
            accepted,
            error_code: code,
            error_message: message,
        }),
        "ack" => v1::frame::Payload::PtyOutputAckResponse(v1::PtyOutputAckResponse {
            request_id,
            pty_id,
            accepted,
            error_code: code,
            error_message: message,
        }),
        _ => v1::frame::Payload::PtyResizeResponse(v1::PtyResizeResponse {
            request_id,
            pty_id,
            accepted,
            error_code: code,
            error_message: message,
        }),
    };
    v1::Frame {
        payload: Some(payload),
    }
}

pub(super) fn pty_state_name(state: pty::PtyState) -> &'static str {
    match state {
        pty::PtyState::Running => "running",
        pty::PtyState::Exited => "exited",
        pty::PtyState::Closed => "closed",
    }
}

pub(super) fn operation_state_name(state: OperationState) -> &'static str {
    match state {
        OperationState::Accepted => "accepted",
        OperationState::Running => "running",
        OperationState::Cancelling => "cancelling",
        OperationState::Completed => "completed",
        OperationState::Cancelled => "cancelled",
        OperationState::Failed => "failed",
        OperationState::Expired => "expired",
    }
}

pub(super) fn workspace_error_code(error: &WorkspaceError) -> &'static str {
    match error {
        WorkspaceError::RootNotDirectory => "ROOT_NOT_DIRECTORY",
        WorkspaceError::InvalidPath(_) => "INVALID_PATH",
        WorkspaceError::OutsideRoot => "OUTSIDE_ROOT",
        WorkspaceError::SymlinkComponent => "SYMLINK_COMPONENT",
        WorkspaceError::NotFound(_) => "NOT_FOUND",
        WorkspaceError::NotDirectory => "NOT_DIRECTORY",
        WorkspaceError::NotRegularFile => "NOT_REGULAR_FILE",
        WorkspaceError::DirectoryLimitExceeded => "DIRECTORY_LIMIT_EXCEEDED",
        WorkspaceError::WriteLimitExceeded => "WRITE_LIMIT_EXCEEDED",
        WorkspaceError::WriteConflict { .. } => "WRITE_CONFLICT",
        WorkspaceError::EmptySearchQuery => "EMPTY_SEARCH_QUERY",
        WorkspaceError::SearchLimitExceeded => "SEARCH_LIMIT_EXCEEDED",
        WorkspaceError::Io(_) => "IO_ERROR",
    }
}
