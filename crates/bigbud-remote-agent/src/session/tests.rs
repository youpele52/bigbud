use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

fn hello() -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: "client-1".to_owned(),
            connection_id: "connection-1".to_owned(),
            server_nonce: "nonce".to_owned(),
            max_frame_bytes: 1024,
        })),
    }
}

#[test]
fn negotiates_a_compatible_hello() {
    let mut session = AgentSession::new();
    let response = session.handle(hello()).unwrap();
    let Some(v1::frame::Payload::AgentHello(agent)) = response.payload else {
        panic!("expected agent hello");
    };
    assert_eq!(agent.protocol_major, PROTOCOL_MAJOR);
    assert_eq!(agent.protocol_minor, PROTOCOL_MINOR);
    assert_eq!(agent.capabilities[0].name, "diagnostic");
}

#[test]
fn rejects_conflicting_operation_digests() {
    let mut session = AgentSession::new();
    session.handle(hello()).unwrap();
    let request = |digest: &[u8]| v1::Frame {
        payload: Some(v1::frame::Payload::DiagnosticRequest(
            v1::DiagnosticRequest {
                request_id: "request-1".to_owned(),
                operation_id: "operation-1".to_owned(),
                request_digest: digest.to_vec(),
                workspace_handle: "workspace-1".to_owned(),
                deadline_unix_ms: 1,
                kind: "diagnostic".to_owned(),
            },
        )),
    };

    session.handle(request(b"one")).unwrap();
    let error = session.handle(request(b"two")).unwrap_err();
    assert!(matches!(error, SessionError::OperationIdConflict));
}

#[test]
fn rejects_environment_values_outside_the_agent_allowlist() {
    let result = process_environment_from_entries(&[v1::ProcessEnvironment {
        name: "AWS_SECRET_ACCESS_KEY".to_owned(),
        value: "should-not-forward".to_owned(),
    }]);
    assert!(
        matches!(result, Err(SessionError::Process(message)) if message.contains("not permitted"))
    );
}

#[test]
fn exposes_explicit_terminal_cancellation_result() {
    let mut session = AgentSession::new();
    session.handle(hello()).unwrap();
    let response = session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::CancelRequest(v1::CancelRequest {
                request_id: "request-2".to_owned(),
                operation_id: "operation-1".to_owned(),
            })),
        })
        .unwrap();
    let Some(v1::frame::Payload::CancelResponse(cancel)) = response.payload else {
        panic!("expected cancel response");
    };
    assert!(!cancel.cancelled);
    assert!(cancel.terminal);
}

#[test]
fn opens_a_root_and_reads_through_the_bounded_workspace_protocol() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("bigbud-agent-session-{suffix}"));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("hello.txt"), "hello remote").unwrap();

    let mut session = AgentSession::new();
    session.handle(hello()).unwrap();
    let opened = session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::WorkspaceOpenRequest(
                v1::WorkspaceOpenRequest {
                    request_id: "open-1".to_owned(),
                    workspace_handle: "workspace-1".to_owned(),
                    root: root.to_string_lossy().into_owned(),
                },
            )),
        })
        .unwrap();
    let Some(v1::frame::Payload::WorkspaceOpenResponse(opened)) = opened.payload else {
        panic!("expected workspace open response");
    };
    assert!(opened.accepted);

    let response = session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::ReadFileRequest(v1::ReadFileRequest {
                request_id: "read-1".to_owned(),
                operation_id: "operation-1".to_owned(),
                request_digest: vec![1],
                workspace_handle: "workspace-1".to_owned(),
                path: "hello.txt".to_owned(),
                offset: 0,
                max_bytes: 5,
            })),
        })
        .unwrap();
    let Some(v1::frame::Payload::ReadFileResponse(response)) = response.payload else {
        panic!("expected read response");
    };
    assert_eq!(response.bytes, b"hello");
    assert!(response.truncated);

    let write = session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::WriteFileRequest(v1::WriteFileRequest {
                request_id: "write-1".to_owned(),
                operation_id: "write-operation-1".to_owned(),
                request_digest: vec![2],
                workspace_handle: "workspace-1".to_owned(),
                path: "nested/updated.txt".to_owned(),
                bytes: b"updated".to_vec(),
                expected_sha256: String::new(),
            })),
        })
        .unwrap();
    let Some(v1::frame::Payload::WriteFileResponse(write)) = write.payload else {
        panic!("expected write response");
    };
    assert_eq!(write.written_bytes, 7);
    assert_eq!(
        fs::read(root.join("nested/updated.txt")).unwrap(),
        b"updated"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn retryable_workspace_reads_do_not_exhaust_retained_mutation_slots() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("bigbud-agent-read-limit-{suffix}"));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("hello.txt"), "hello remote").unwrap();

    let mut session = AgentSession::new();
    session.handle(hello()).unwrap();
    session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::WorkspaceOpenRequest(
                v1::WorkspaceOpenRequest {
                    request_id: "open-1".to_owned(),
                    workspace_handle: "workspace-1".to_owned(),
                    root: root.to_string_lossy().into_owned(),
                },
            )),
        })
        .unwrap();

    for index in 0..=MAX_ACCEPTED_OPERATIONS {
        let response = session
            .handle(v1::Frame {
                payload: Some(v1::frame::Payload::ReadFileRequest(v1::ReadFileRequest {
                    request_id: format!("read-{index}"),
                    operation_id: format!("read-operation-{index}"),
                    request_digest: index.to_le_bytes().to_vec(),
                    workspace_handle: "workspace-1".to_owned(),
                    path: "hello.txt".to_owned(),
                    offset: 0,
                    max_bytes: 5,
                })),
            })
            .unwrap();
        assert!(matches!(
            response.payload,
            Some(v1::frame::Payload::ReadFileResponse(_))
        ));
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejected_process_concurrency_is_not_persisted_to_the_journal() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("bigbud-agent-capacity-{suffix}"));
    let workspace = root.join("workspace");
    let journal_path = root.join("operations.journal");
    fs::create_dir_all(&workspace).unwrap();

    let mut session = AgentSession::with_epoch_and_journal("epoch-1", &journal_path).unwrap();
    session.handle(hello()).unwrap();
    session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::WorkspaceOpenRequest(
                v1::WorkspaceOpenRequest {
                    request_id: "open-1".to_owned(),
                    workspace_handle: "workspace-1".to_owned(),
                    root: workspace.to_string_lossy().into_owned(),
                },
            )),
        })
        .unwrap();

    let request = |index: usize| v1::ProcessRequest {
        request_id: format!("process-{index}"),
        operation_id: format!("operation-{index}"),
        request_digest: index.to_le_bytes().to_vec(),
        workspace_handle: "workspace-1".to_owned(),
        command: "true".to_owned(),
        args: Vec::new(),
        timeout_ms: 1_000,
        max_output_bytes: 1_024,
        environment: Vec::new(),
        stdin: Vec::new(),
    };
    for index in 0..MAX_CONCURRENT_PROCESS_OPERATIONS {
        session.prepare_process_request(request(index)).unwrap();
    }
    assert!(matches!(
        session.prepare_process_request(request(MAX_CONCURRENT_PROCESS_OPERATIONS)),
        Err(SessionError::ResourceLimit(message)) if message.contains("concurrent process")
    ));
    drop(session);

    AgentSession::with_epoch_and_journal("epoch-2", &journal_path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn restores_the_latest_process_retention_deadline() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("bigbud-agent-retention-{suffix}"));
    let journal_path = root.join("operations.journal");
    let journal = OperationJournal::open(&journal_path, 1024 * 1024).unwrap();
    let operation_id = "operation-1".to_owned();
    for record in [
        JournalRecord::Accepted {
            operation_id: operation_id.clone(),
            request_digest: vec![1],
        },
        JournalRecord::Retention {
            operation_id: operation_id.clone(),
            expires_at_unix_ms: 1,
        },
        JournalRecord::Started {
            operation_id: operation_id.clone(),
        },
        JournalRecord::Completed {
            operation_id: operation_id.clone(),
            state: OperationState::Completed,
            exit_code: Some(0),
            error_code: None,
        },
        JournalRecord::Retention {
            operation_id: operation_id.clone(),
            expires_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 60_000,
        },
    ] {
        journal.append(&record).unwrap();
    }
    drop(journal);

    let session = AgentSession::with_epoch_and_journal("epoch-2", &journal_path).unwrap();
    assert_eq!(
        session
            .process_operations
            .snapshot(&operation_id, Instant::now())
            .unwrap()
            .terminal
            .unwrap()
            .state,
        OperationState::Completed
    );
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn replays_completed_processes_from_the_user_only_journal() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("bigbud-agent-journal-{suffix}"));
    fs::create_dir_all(&root).unwrap();
    let journal_path = root.join("operations.journal");
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).unwrap();

    let open = v1::Frame {
        payload: Some(v1::frame::Payload::WorkspaceOpenRequest(
            v1::WorkspaceOpenRequest {
                request_id: "open-1".to_owned(),
                workspace_handle: "workspace-1".to_owned(),
                root: workspace.to_string_lossy().into_owned(),
            },
        )),
    };
    let process = v1::ProcessRequest {
        request_id: "process-1".to_owned(),
        operation_id: "operation-1".to_owned(),
        request_digest: vec![1, 2, 3],
        workspace_handle: "workspace-1".to_owned(),
        command: "printf".to_owned(),
        args: vec!["journal-ok".to_owned()],
        timeout_ms: 2_000,
        max_output_bytes: 1024,
        environment: Vec::new(),
        stdin: Vec::new(),
    };

    let mut first = AgentSession::with_epoch_and_journal("epoch-1", &journal_path).unwrap();
    first.handle(hello()).unwrap();
    first.handle(open.clone()).unwrap();
    let first_responses = first.handle_process_request(process.clone()).unwrap();
    assert!(
        first_responses
            .iter()
            .any(|frame| matches!(frame.payload, Some(v1::frame::Payload::ProcessCompleted(_))))
    );

    let mut restarted = AgentSession::with_epoch_and_journal("epoch-2", &journal_path).unwrap();
    restarted.handle(hello()).unwrap();
    restarted.handle(open).unwrap();
    let replayed = restarted
        .handle_process_attach(v1::ProcessAttachRequest {
            request_id: "attach-1".to_owned(),
            operation_id: process.operation_id,
            after_sequence: 0,
        })
        .unwrap();
    assert!(
        replayed
            .iter()
            .any(|frame| matches!(frame.payload, Some(v1::frame::Payload::ProcessOutput(_))))
    );
    assert!(replayed.iter().any(|frame| matches!(
        frame.payload,
        Some(v1::frame::Payload::ProcessAttachResponse(ref status))
            if status.state == "completed" && status.next_sequence == 2
    )));
    assert!(
        replayed
            .iter()
            .any(|frame| matches!(frame.payload, Some(v1::frame::Payload::ProcessCompleted(_))))
    );
    let _ = fs::remove_dir_all(root);
}
