use super::*;

fn session() -> AgentSession {
    let mut session = AgentSession::new().expect("session");
    session.handle(test_helpers::hello()).expect("hello");
    for id in ["pty-c", "pty-a", "pty-b"] {
        session.pty_create_failures.insert(
            id.to_owned(),
            pty_create::PtyCreateFailure {
                request_digest: vec![1, 2],
                error: "unknown".to_owned(),
            },
        );
    }
    session
}

fn request(session: &AgentSession) -> v1::PtyListRequest {
    v1::PtyListRequest {
        request_id: "list".to_owned(),
        expected_epoch: session.agent_epoch.clone(),
        limit: 2,
        ..Default::default()
    }
}

fn response(session: &mut AgentSession, request: v1::PtyListRequest) -> v1::PtyListResponse {
    let frame = session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::PtyListRequest(request)),
        })
        .expect("list");
    match frame.payload {
        Some(v1::frame::Payload::PtyListResponse(value)) => value,
        _ => panic!("expected list response"),
    }
}

#[test]
fn inventory_is_sorted_paginated_read_only_and_available_while_draining() {
    let mut session = session();
    session.accepting_work = false;
    let mut req = request(&session);
    let first = response(&mut session, req.clone());
    assert!(first.accepted);
    assert_eq!(
        first
            .entries
            .iter()
            .map(|e| e.pty_id.as_str())
            .collect::<Vec<_>>(),
        ["pty-a", "pty-b"]
    );
    assert!(
        first
            .entries
            .iter()
            .all(|e| e.state == "outcome-unknown" && !e.verified_exit)
    );
    assert_eq!(first.next_after_pty_id, "pty-b");
    req.after_pty_id = first.next_after_pty_id;
    req.snapshot_id = first.snapshot_id;
    let second = response(&mut session, req);
    assert!(second.accepted);
    assert_eq!(second.entries.len(), 1);
    assert_eq!(second.entries[0].pty_id, "pty-c");
    assert!(second.next_after_pty_id.is_empty());
    assert_eq!(session.pty_create_failures.len(), 3);
    assert!(session.pty_sessions.is_empty());
}

#[test]
fn changed_membership_and_epoch_require_new_discovery() {
    let mut session = session();
    let mut req = request(&session);
    let first = response(&mut session, req.clone());
    req.after_pty_id = first.next_after_pty_id;
    req.snapshot_id = first.snapshot_id;
    session.pty_create_failures.remove("pty-c");
    assert_eq!(
        response(&mut session, req.clone()).error_code,
        "PTY_INVENTORY_CHANGED"
    );
    req.expected_epoch = "old".to_owned();
    assert_eq!(response(&mut session, req).error_code, "PTY_EPOCH_MISMATCH");
}

#[test]
fn invalid_limits_cursors_and_oversized_legacy_entries_fail_explicitly() {
    let mut session = session();
    for limit in [0, 101, u32::MAX] {
        let mut req = request(&session);
        req.limit = limit;
        assert_eq!(
            response(&mut session, req).error_code,
            "PTY_INVENTORY_INVALID"
        );
    }
    let mut req = request(&session);
    req.after_pty_id = "pty-a".to_owned();
    assert_eq!(
        response(&mut session, req).error_code,
        "PTY_INVENTORY_INVALID"
    );
    session.pty_create_failures.insert(
        "x".repeat(257),
        pty_create::PtyCreateFailure {
            request_digest: vec![1],
            error: "unknown".to_owned(),
        },
    );
    let req = request(&session);
    let rejected = response(&mut session, req);
    assert_eq!(rejected.error_code, "PTY_INVENTORY_BOUNDS");
    assert!(rejected.entries.is_empty());
    assert!(!rejected.accepted);
}

#[test]
fn inventory_requires_hello() {
    let mut session = AgentSession::new().expect("session");
    let req = request(&session);
    assert!(matches!(
        session.handle(v1::Frame {
            payload: Some(v1::frame::Payload::PtyListRequest(req))
        }),
        Err(SessionError::HelloRequired)
    ));
}

#[cfg(unix)]
#[test]
fn running_handle_and_reaped_exit_are_observed_without_inventory_mutation() {
    let mut session = session();
    session.pty_create_failures.clear();
    let job = pty::PtyHandle::spawn(
        "pty-live".to_owned(),
        &std::env::temp_dir(),
        "/bin/sh",
        &["-c".to_owned(), "read answer; exit 7".to_owned()],
        80,
        24,
        &[],
    )
    .expect("spawn bounded PTY fixture");
    let handle = Arc::clone(&job.handle);
    session.pty_sessions.insert(
        "pty-live".to_owned(),
        PtySession {
            handle: Arc::clone(&handle),
            request_digest: vec![4],
            expires_at: None,
        },
    );
    let req = request(&session);
    let running = response(&mut session, req.clone());
    assert_eq!(running.entries[0].state, "running");
    assert_eq!(running.entries[0].pid, u64::from(handle.pid));
    assert!(!running.entries[0].verified_exit);
    handle
        .write_input(1, b"continue\n")
        .expect("release fixture");
    let events = pty::read_events(job.reader, &handle);
    let exit = events
        .into_iter()
        .find_map(|event| match event {
            pty::PtyEvent::Exited { exit_code, signal } => Some((exit_code, signal)),
            _ => None,
        })
        .expect("reaped exit");
    assert_eq!(exit.0, Some(7));
    session
        .complete_pty("pty-live", exit.0, exit.1)
        .expect("record exit");
    let exited = response(&mut session, req);
    assert_eq!(exited.entries[0].state, "exited");
    assert!(exited.entries[0].verified_exit);
    assert_eq!(exited.snapshot_id, running.snapshot_id);
    assert_eq!(session.pty_sessions.len(), 1);
}
