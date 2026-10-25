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

#[test]
fn a_running_operation_older_than_its_retention_stays_attachable() {
    let now = Instant::now();
    let mut registry = OperationRegistry::new(2, 4, Duration::from_secs(600));
    registry.accept("operation-1", vec![], now).unwrap();
    registry.start("operation-1", now).unwrap();
    let later = now + Duration::from_secs(601);
    registry.prune(later);
    assert_eq!(
        registry.snapshot("operation-1", later).unwrap().state,
        OperationState::Running
    );
    registry
        .append_output("operation-1", OutputStream::Stdout, b"aa".to_vec(), later)
        .unwrap();
    assert_eq!(
        registry.replay_from("operation-1", 0, later).unwrap().len(),
        1
    );
    assert!(registry.has_live_operations());
}

#[test]
fn a_terminal_result_survives_a_thirty_minute_gap_and_expires_after_a_day() {
    let day = Duration::from_secs(24 * 60 * 60);
    let now = Instant::now();
    let mut registry = OperationRegistry::new(2, 4, day);
    registry.accept("operation-1", vec![], now).unwrap();
    registry.start("operation-1", now).unwrap();
    registry
        .complete("operation-1", OperationState::Failed, Some(2), None, now)
        .unwrap();
    let after_sleep = now + Duration::from_secs(30 * 60);
    registry.prune(after_sleep);
    let terminal = registry
        .snapshot("operation-1", after_sleep)
        .unwrap()
        .terminal
        .unwrap();
    assert_eq!(terminal.exit_code, Some(2));
    assert!(!registry.has_live_operations());
    let expired = now + day + Duration::from_secs(1);
    registry.prune(expired);
    assert_eq!(
        registry.snapshot("operation-1", expired),
        Err(OperationError::UnknownOperation)
    );
}

#[test]
fn a_full_registry_evicts_the_oldest_terminal_result_but_never_running_work() {
    let now = Instant::now();
    let mut registry = OperationRegistry::new(2, 4, Duration::from_secs(60));
    registry.accept("done", vec![], now).unwrap();
    registry
        .complete("done", OperationState::Completed, Some(0), None, now)
        .unwrap();
    registry.accept("running", vec![], now).unwrap();
    registry.start("running", now).unwrap();

    assert_eq!(
        registry.accept("next", vec![], now),
        Ok(AcceptResult::Accepted)
    );
    assert_eq!(
        registry.snapshot("done", now),
        Err(OperationError::UnknownOperation)
    );
    registry.start("next", now).unwrap();
    assert_eq!(
        registry.accept("another", vec![], now),
        Err(OperationError::OperationLimit)
    );
    assert!(registry.snapshot("running", now).is_ok());
}

#[test]
fn terminal_output_beyond_its_budget_drops_bytes_but_keeps_the_exit_code() {
    let now = Instant::now();
    let mut registry =
        OperationRegistry::new(4, 4, Duration::from_secs(60)).with_terminal_output_budget(4);
    for (index, operation_id) in ["older", "newer"].into_iter().enumerate() {
        let completed_at = now + Duration::from_secs(index as u64);
        registry.accept(operation_id, vec![], completed_at).unwrap();
        registry.start(operation_id, completed_at).unwrap();
        registry
            .append_output(
                operation_id,
                OutputStream::Stdout,
                b"abc".to_vec(),
                completed_at,
            )
            .unwrap();
        registry
            .complete(
                operation_id,
                OperationState::Completed,
                Some(0),
                None,
                completed_at,
            )
            .unwrap();
    }

    let older = registry.snapshot("older", now).unwrap();
    assert_eq!(older.first_retained_sequence, older.next_sequence);
    assert_eq!(older.terminal.unwrap().exit_code, Some(0));
    assert!(matches!(
        registry.replay_from("older", 0, now),
        Err(OperationError::ReplayGap { .. })
    ));
    assert_eq!(registry.replay_from("newer", 0, now).unwrap().len(), 1);
}

#[test]
fn a_cursor_at_u64_max_replays_nothing_instead_of_overflowing() {
    let now = Instant::now();
    let mut registry = registry();
    registry.accept("operation-1", vec![], now).unwrap();
    registry.start("operation-1", now).unwrap();
    registry
        .append_output("operation-1", OutputStream::Stdout, b"aa".to_vec(), now)
        .unwrap();
    assert_eq!(
        registry.replay_from("operation-1", u64::MAX, now),
        Ok(vec![])
    );
}
