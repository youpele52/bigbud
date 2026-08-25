use std::fs;

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
