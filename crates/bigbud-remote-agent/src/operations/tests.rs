use super::*;

fn registry() -> OperationRegistry {
    OperationRegistry::new(2, 4, Duration::from_secs(60))
}

#[test]
fn accepts_once_and_rejects_conflicting_digests() {
    let now = Instant::now();
    let mut registry = registry();
    assert_eq!(
        registry.accept("operation-1", vec![1], now),
        Ok(AcceptResult::Accepted)
    );
    assert!(matches!(
        registry.accept("operation-1", vec![2], now),
        Err(OperationError::OperationIdConflict)
    ));
    assert!(matches!(
        registry.accept("operation-1", vec![1], now),
        Ok(AcceptResult::Duplicate(_))
    ));
}

#[test]
fn retains_bounded_output_and_reports_replay_gaps() {
    let now = Instant::now();
    let mut registry = registry();
    registry.accept("operation-1", vec![], now).unwrap();
    registry.start("operation-1", now).unwrap();
    registry
        .append_output("operation-1", OutputStream::Stdout, b"aa".to_vec(), now)
        .unwrap();
    registry
        .append_output("operation-1", OutputStream::Stdout, b"bb".to_vec(), now)
        .unwrap();
    registry
        .append_output("operation-1", OutputStream::Stdout, b"cc".to_vec(), now)
        .unwrap();
    assert!(matches!(
        registry.replay_from("operation-1", 0, now),
        Err(OperationError::ReplayGap {
            first_retained_sequence: 2
        })
    ));
    assert_eq!(
        registry.replay_from("operation-1", 1, now).unwrap()[0].bytes,
        b"bb"
    );
}

#[test]
fn terminal_result_survives_output_replay_until_expiration() {
    let now = Instant::now();
    let mut registry = OperationRegistry::new(1, 4, Duration::from_secs(5));
    registry.accept("operation-1", vec![], now).unwrap();
    registry
        .complete("operation-1", OperationState::Completed, Some(0), None, now)
        .unwrap();
    assert_eq!(
        registry
            .snapshot("operation-1", now)
            .unwrap()
            .terminal
            .unwrap()
            .state,
        OperationState::Completed
    );
    registry.prune(now + Duration::from_secs(6));
    assert_eq!(
        registry.snapshot("operation-1", now + Duration::from_secs(6)),
        Err(OperationError::UnknownOperation)
    );
}

#[test]
fn acknowledgements_release_consumed_output() {
    let now = Instant::now();
    let mut registry = registry();
    registry.accept("operation-1", vec![], now).unwrap();
    registry.start("operation-1", now).unwrap();
    registry
        .append_output("operation-1", OutputStream::Stdout, b"aa".to_vec(), now)
        .unwrap();
    registry
        .append_output("operation-1", OutputStream::Stdout, b"bb".to_vec(), now)
        .unwrap();
    registry.acknowledge("operation-1", 1, now).unwrap();
    assert_eq!(
        registry.replay_from("operation-1", 1, now).unwrap().len(),
        1
    );
    assert!(matches!(
        registry.acknowledge("operation-1", 3, now),
        Err(OperationError::InvalidAcknowledgement)
    ));
}

#[test]
fn restored_wall_clock_retention_does_not_extend_expired_results() {
    let now = Instant::now();
    let mut registry = registry();
    registry
        .restore_journal_record(
            JournalRecord::Accepted {
                operation_id: "operation-1".to_owned(),
                request_digest: vec![],
            },
            now,
        )
        .unwrap();
    registry
        .restore_journal_record(
            JournalRecord::Retention {
                operation_id: "operation-1".to_owned(),
                expires_at_unix_ms: 0,
            },
            now,
        )
        .unwrap();
    assert_eq!(
        registry.snapshot("operation-1", now),
        Err(OperationError::UnknownOperation)
    );
}
