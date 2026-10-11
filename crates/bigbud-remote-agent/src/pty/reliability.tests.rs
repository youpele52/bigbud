use super::*;

#[test]
fn real_exit_retained_handle_has_no_signal_authority_during_later_retirement() {
    let job = PtyHandle::spawn(
        "retained-exit".into(),
        &std::env::current_dir().unwrap(),
        "sh",
        &["-c".into(), "exit 0".into()],
        80,
        24,
        &[],
    )
    .unwrap();
    let events = read_events(job.reader, &job.handle);
    assert!(events.iter().any(|event| matches!(
        event,
        PtyEvent::Exited {
            exit_code: Some(0),
            ..
        }
    )));
    job.handle.mark_exited(Some(0), None).unwrap();
    assert!(job.handle.native_settled());
    job.handle.signal("SIGTERM").unwrap();
    job.handle.force_kill().unwrap();
    job.handle.close(true).unwrap();
}
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn spawn(id: &str, script: &str) -> Result<PtyJob, PtyError> {
    PtyHandle::spawn(
        id.to_owned(),
        Path::new("/"),
        "sh",
        &["-c".to_owned(), script.to_owned()],
        80,
        24,
        &[],
    )
}

#[test]
fn blocked_real_pty_input_does_not_hold_state_or_delay_sibling_and_close() {
    let job = spawn("blocked", "stty -echo -icanon; printf ready; sleep 20").unwrap();
    let handle = Arc::clone(&job.handle);
    let (events, received) = mpsc::channel();
    let reader_handle = Arc::clone(&handle);
    let reader = std::thread::spawn(move || {
        run_events(job.reader, &job.handle, |event| {
            if let PtyEvent::Output(bytes) = &event {
                reader_handle.append_output(bytes.clone()).unwrap();
            }
            events.send(event).unwrap();
        })
    });
    assert!(matches!(
        received.recv_timeout(Duration::from_secs(2)).unwrap(),
        PtyEvent::Output(_)
    ));
    let blocked = Arc::clone(&handle);
    let writer = std::thread::spawn(move || blocked.write_input(1, &vec![b'x'; 64 * 1024]));
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if matches!(handle.input_status(1), Ok(InputOutcome::Writing(_))) {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let started = Instant::now();
    let sibling = spawn("sibling", "printf sibling").unwrap();
    let sibling_events = read_events(sibling.reader, &sibling.handle);
    assert!(
        sibling_events
            .iter()
            .any(|event| matches!(event, PtyEvent::Output(bytes) if bytes == b"sibling"))
    );
    handle.snapshot().unwrap();
    handle.resize(100, 30).unwrap();
    handle.close(true).unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(writer.join().unwrap().is_err());
    assert!(matches!(
        handle.input_status(1).unwrap(),
        InputOutcome::PartialUnknown(_) | InputOutcome::FailedBeforeWrite
    ));
    reader.join().unwrap();
}

#[test]
fn output_ack_and_replay_reject_beyond_produced_and_overflowing_cursor() {
    let job = spawn("acks", "printf bounded").unwrap();
    let handle = job.handle;
    read_events(job.reader, &handle);
    handle.append_output(b"one".to_vec()).unwrap();
    handle.append_output(b"two".to_vec()).unwrap();
    assert!(matches!(
        handle.acknowledge(3),
        Err(PtyError::InvalidAcknowledgement)
    ));
    assert!(matches!(
        handle.replay(u64::MAX),
        Err(PtyError::InvalidAcknowledgement)
    ));
    assert_eq!(handle.replay(0).unwrap().len(), 2);
    handle.acknowledge(2).unwrap();
    handle.acknowledge(2).unwrap();
    handle.acknowledge(1).unwrap(); // Preserve legacy idempotent global release semantics.
    assert!(matches!(handle.replay(0), Err(PtyError::ReplayGap { .. })));
    handle.close(false).unwrap();
}

#[test]
fn failed_child_chdir_never_runs_shell_in_an_unintended_directory() {
    let job = PtyHandle::spawn(
        "chdir".to_owned(),
        Path::new("/bigbud-missing-cwd-fixture"),
        "sh",
        &["-c".to_owned(), "printf must-not-run".to_owned()],
        80,
        24,
        &[],
    )
    .unwrap();
    let events = read_events(job.reader, &job.handle);
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, PtyEvent::Output(_)))
    );
    assert!(events.iter().any(|event| matches!(
        event,
        PtyEvent::Exited {
            exit_code: Some(126),
            ..
        }
    )));
    job.handle.close(false).unwrap();
}
