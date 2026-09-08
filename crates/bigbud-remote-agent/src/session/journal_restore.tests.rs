use std::fs;

use super::test_helpers::hello;
use super::*;

#[test]
fn expired_history_does_not_consume_restore_capacity() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("bigbud-agent-restore-{suffix}"));
    let journal_path = root.join("operations.journal");
    let journal = OperationJournal::open(&journal_path, 64 * 1024 * 1024).unwrap();
    for index in 0..=MAX_PROCESS_OPERATIONS {
        let operation_id = format!("expired-{index}");
        journal
            .append(&JournalRecord::Accepted {
                operation_id: operation_id.clone(),
                request_digest: index.to_le_bytes().to_vec(),
            })
            .unwrap();
        journal
            .append(&JournalRecord::Retention {
                operation_id,
                expires_at_unix_ms: 1,
            })
            .unwrap();
    }
    let retained_id = "retained-operation".to_owned();
    journal
        .append(&JournalRecord::Accepted {
            operation_id: retained_id.clone(),
            request_digest: vec![1],
        })
        .unwrap();
    journal
        .append(&JournalRecord::Completed {
            operation_id: retained_id.clone(),
            state: OperationState::Completed,
            exit_code: Some(0),
            error_code: None,
        })
        .unwrap();
    journal
        .append(&JournalRecord::Retention {
            operation_id: retained_id.clone(),
            expires_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 60_000,
        })
        .unwrap();
    drop(journal);

    let session = AgentSession::with_epoch_and_journal("epoch-2", &journal_path).unwrap();
    assert_eq!(
        session
            .process_operations
            .snapshot(&retained_id, Instant::now())
            .unwrap()
            .terminal
            .unwrap()
            .state,
        OperationState::Completed
    );
    assert!(matches!(
        session
            .process_operations
            .snapshot("expired-0", Instant::now()),
        Err(OperationError::UnknownOperation)
    ));
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
