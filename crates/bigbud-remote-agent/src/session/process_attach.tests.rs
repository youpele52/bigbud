use super::test_helpers::hello;
use super::*;

const MIB: usize = 1024 * 1024;

fn ready_session() -> AgentSession {
    let mut session = AgentSession::with_epoch("epoch-1");
    session.handle(hello()).unwrap();
    session
}

/// Runs a process that wrote `chunks` MiB of unacknowledged output, more than
/// the 8 MiB retained window, as a client asleep for the whole run would see.
fn overflowed_operation(session: &mut AgentSession, chunks: usize, exit_code: Option<i32>) {
    let now = Instant::now();
    let operations = &mut session.process_operations;
    operations.accept("operation-1", vec![1], now).unwrap();
    operations.start("operation-1", now).unwrap();
    for _ in 0..chunks {
        operations
            .append_output("operation-1", OutputStream::Stdout, vec![b'x'; MIB], now)
            .unwrap();
    }
    if let Some(exit_code) = exit_code {
        let state = if exit_code == 0 {
            OperationState::Completed
        } else {
            OperationState::Failed
        };
        let error_code = (exit_code != 0).then(|| "NONZERO_EXIT".to_owned());
        operations
            .complete("operation-1", state, Some(exit_code), error_code, now)
            .unwrap();
    }
}

fn attach(session: &mut AgentSession, after_sequence: u64) -> Vec<v1::Frame> {
    session
        .handle_process_attach(v1::ProcessAttachRequest {
            request_id: "attach-1".to_owned(),
            operation_id: "operation-1".to_owned(),
            after_sequence,
        })
        .unwrap()
}

fn attach_response(frames: &[v1::Frame]) -> &v1::ProcessAttachResponse {
    match frames.first().and_then(|frame| frame.payload.as_ref()) {
        Some(v1::frame::Payload::ProcessAttachResponse(response)) => response,
        other => panic!("expected an attach response, got {other:?}"),
    }
}

fn completed(frames: &[v1::Frame]) -> Option<&v1::ProcessCompleted> {
    frames
        .iter()
        .find_map(|frame| match frame.payload.as_ref() {
            Some(v1::frame::Payload::ProcessCompleted(completed)) => Some(completed),
            _ => None,
        })
}

fn output_sequences(frames: &[v1::Frame]) -> Vec<u64> {
    frames
        .iter()
        .filter_map(|frame| match frame.payload.as_ref() {
            Some(v1::frame::Payload::ProcessOutput(output)) => Some(output.sequence),
            _ => None,
        })
        .collect()
}

#[test]
fn attach_after_an_output_overflow_returns_the_exit_code_with_a_replay_gap() {
    let mut session = ready_session();
    overflowed_operation(&mut session, 10, Some(3));

    let frames = attach(&mut session, 0);

    let response = attach_response(&frames);
    assert!(response.replay_gap);
    assert_eq!(response.first_retained_sequence, 3);
    assert_eq!(response.next_sequence, 11);
    assert_eq!(output_sequences(&frames), (3..=10).collect::<Vec<_>>());
    let completed = completed(&frames).expect("the terminal result is returned");
    assert!(completed.replay_gap);
    assert!(completed.has_exit_code);
    assert_eq!(completed.exit_code, 3);
    assert_eq!(completed.state, "failed");
}

#[test]
fn attach_to_a_running_operation_behind_the_window_resumes_from_retained_output() {
    let mut session = ready_session();
    overflowed_operation(&mut session, 9, None);

    let frames = attach(&mut session, 0);

    let response = attach_response(&frames);
    assert!(response.replay_gap);
    assert_eq!(response.state, "running");
    assert_eq!(output_sequences(&frames).first(), Some(&2));
    assert!(completed(&frames).is_none());
}

#[test]
fn attach_within_the_window_reports_no_replay_gap() {
    let mut session = ready_session();
    overflowed_operation(&mut session, 10, Some(0));

    let frames = attach(&mut session, 2);

    assert!(!attach_response(&frames).replay_gap);
    assert_eq!(output_sequences(&frames).first(), Some(&3));
    let completed = completed(&frames).unwrap();
    assert!(!completed.replay_gap);
    assert_eq!(completed.state, "completed");
}

#[test]
fn attach_to_an_unknown_operation_still_fails_without_replaying() {
    let mut session = ready_session();
    let result = session.handle_process_attach(v1::ProcessAttachRequest {
        request_id: "attach-1".to_owned(),
        operation_id: "missing".to_owned(),
        after_sequence: 0,
    });
    assert!(matches!(
        result,
        Err(SessionError::ProcessReplay(message)) if message.contains("unknown or expired")
    ));
}

#[test]
fn terminal_results_are_retained_for_a_day() {
    assert!(PROCESS_RESULT_RETENTION >= Duration::from_secs(24 * 60 * 60));
    assert!(ACCEPTED_OPERATION_RETENTION >= PROCESS_RESULT_RETENTION);
}

#[test]
fn no_idle_retirement_while_an_operation_is_running() {
    let mut session = ready_session();
    let now = Instant::now();
    session
        .process_operations
        .accept("operation-1", vec![1], now)
        .unwrap();
    session
        .process_operations
        .start("operation-1", now)
        .unwrap();
    assert!(!session.is_idle_for_retirement());
    assert!(!session.restart_work_idle());

    let (response, accepted) = crate::supervisor::shutdown_response(
        &mut session,
        v1::SupervisorShutdownRequest {
            request_id: "shutdown-1".to_owned(),
            expected_agent_epoch: "epoch-1".to_owned(),
            expected_build_digest: crate::identity::build_digest().to_owned(),
            interrupt_owned_work: false,
        },
        false,
        false,
    );
    assert!(!accepted);
    assert!(matches!(
        response.payload,
        Some(v1::frame::Payload::SupervisorShutdownResponse(response))
            if response.detail == "supervisor-not-idle"
    ));

    session
        .process_operations
        .complete("operation-1", OperationState::Completed, Some(0), None, now)
        .unwrap();
    assert!(session.is_idle_for_retirement());
}

#[test]
fn a_restored_result_whose_output_was_compacted_away_still_reports_its_exit_code() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("bigbud-agent-attach-gap-{suffix}"));
    let journal_path = root.join("operations.journal");
    let journal = OperationJournal::open(&journal_path, MAX_OPERATION_JOURNAL_BYTES).unwrap();
    let thirty_minutes_ago_plus_a_day = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + PROCESS_RESULT_RETENTION.as_millis() as u64
        - 30 * 60 * 1_000;
    for record in [
        JournalRecord::Accepted {
            operation_id: "operation-1".to_owned(),
            request_digest: vec![1],
        },
        JournalRecord::Started {
            operation_id: "operation-1".to_owned(),
        },
        JournalRecord::OutputWatermark {
            operation_id: "operation-1".to_owned(),
            next_sequence: 5,
            first_retained_sequence: 5,
        },
        JournalRecord::Retention {
            operation_id: "operation-1".to_owned(),
            expires_at_unix_ms: thirty_minutes_ago_plus_a_day,
        },
        JournalRecord::Completed {
            operation_id: "operation-1".to_owned(),
            state: OperationState::Completed,
            exit_code: Some(0),
            error_code: None,
        },
    ] {
        journal.append(&record).unwrap();
    }
    drop(journal);

    let mut session = AgentSession::with_epoch_and_journal("epoch-2", &journal_path).unwrap();
    session.handle(hello()).unwrap();
    let frames = attach(&mut session, 2);

    assert!(attach_response(&frames).replay_gap);
    assert!(output_sequences(&frames).is_empty());
    let completed = completed(&frames).unwrap();
    assert!(completed.replay_gap);
    assert_eq!((completed.has_exit_code, completed.exit_code), (true, 0));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_running_operation_older_than_600_seconds_is_attachable_through_a_session_attach() {
    let mut session = ready_session();
    // Accepted and started 601 s ago: past the old 600 s retention, and still running.
    let Some(started_at) = Instant::now().checked_sub(Duration::from_secs(601)) else {
        // A monotonic clock this young cannot express the age; nothing to check.
        return;
    };
    let operations = &mut session.process_operations;
    operations
        .accept("operation-1", vec![1], started_at)
        .unwrap();
    operations.start("operation-1", started_at).unwrap();
    operations
        .append_output(
            "operation-1",
            OutputStream::Stdout,
            b"still going".to_vec(),
            started_at,
        )
        .unwrap();

    let frames = attach(&mut session, 0);

    let response = attach_response(&frames);
    assert_eq!(response.state, "running");
    assert!(!response.replay_gap);
    assert_eq!(output_sequences(&frames), vec![1]);
    assert!(completed(&frames).is_none());
}

#[test]
fn a_session_attach_with_a_cursor_at_u64_max_does_not_overflow() {
    let mut session = ready_session();
    overflowed_operation(&mut session, 1, Some(0));

    let frames = attach(&mut session, u64::MAX);

    assert!(!attach_response(&frames).replay_gap);
    assert!(output_sequences(&frames).is_empty());
    assert_eq!(completed(&frames).unwrap().state, "completed");
}
