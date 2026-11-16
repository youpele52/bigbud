use super::*;

#[test]
fn detach_preserves_both_ptys_other_subscriber_and_attach_identity() {
    let rig = Rig::new("detach", None);
    let (mut primary, hello) = rig.connect();
    assert!(
        hello
            .capabilities
            .iter()
            .any(|c| c.name == "terminal.pty-detach" && c.major == 1)
    );
    rig.open(&mut primary);
    let pid_a = rig.pty(
        &mut primary,
        "a",
        "read answer; printf A_RETAINED; read finish",
    );
    let pid_b = rig.pty(&mut primary, "b", "read answer; printf B_LIVE; read finish");
    let (mut observer, _) = rig.connect();
    write_request(
        &mut observer,
        v1::frame::Payload::PtyAttachRequest(v1::PtyAttachRequest {
            request_id: "observe-a".into(),
            pty_id: "a".into(),
            after_sequence: 0,
        }),
    );
    read_until(&mut observer, |p| {
        matches!(p, v1::frame::Payload::PtyAttachResponse(_))
    });
    for _ in 0..2 {
        write_request(
            &mut primary,
            v1::frame::Payload::PtyDetachRequest(v1::PtyDetachRequest {
                request_id: "detach-a".into(),
                pty_id: "a".into(),
            }),
        );
        read_until(
            &mut primary,
            |p| matches!(p, v1::frame::Payload::PtyDetachResponse(v) if v.accepted),
        );
    }
    for (stream, id) in [(&mut observer, "a"), (&mut primary, "b")] {
        write_request(
            stream,
            v1::frame::Payload::PtyInput(v1::PtyInput {
                request_id: format!("input-{id}"),
                pty_id: id.into(),
                sequence: 1,
                bytes: b"go\n".to_vec(),
            }),
        );
    }
    let mut observed = Vec::new();
    while !String::from_utf8_lossy(&observed).contains("A_RETAINED") {
        if let v1::frame::Payload::PtyOutput(value) = read_until(&mut observer, |p| {
            matches!(p, v1::frame::Payload::PtyOutput(_))
        }) {
            observed.extend(value.bytes);
        }
    }
    let mut primary_output = Vec::new();
    while !String::from_utf8_lossy(&primary_output).contains("B_LIVE") {
        let payload = read_frame(&mut primary, DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .unwrap()
            .payload
            .unwrap();
        if let v1::frame::Payload::PtyOutput(value) = payload {
            assert_eq!(value.pty_id, "b", "detached A cannot deliver after its ack");
            primary_output.extend(value.bytes);
        }
    }
    write_request(
        &mut primary,
        v1::frame::Payload::PtyListRequest(v1::PtyListRequest {
            request_id: "inventory".into(),
            expected_epoch: hello.agent_epoch.clone(),
            limit: 100,
            ..Default::default()
        }),
    );
    let v1::frame::Payload::PtyListResponse(list) = read_until(&mut primary, |p| {
        matches!(p, v1::frame::Payload::PtyListResponse(_))
    }) else {
        panic!("inventory");
    };
    assert!(list.accepted);
    assert_eq!(list.entries.len(), 2);
    assert_eq!(
        list.entries
            .iter()
            .map(|entry| entry.pid)
            .collect::<Vec<_>>(),
        vec![u64::from(pid_a), u64::from(pid_b)]
    );
    assert!(
        list.entries
            .iter()
            .all(|entry| entry.state == "running" && !entry.verified_exit)
    );
    write_request(
        &mut primary,
        v1::frame::Payload::PtyAttachRequest(v1::PtyAttachRequest {
            request_id: "reattach-a".into(),
            pty_id: "a".into(),
            after_sequence: 0,
        }),
    );
    let v1::frame::Payload::PtyAttachResponse(attached) = read_until(&mut primary, |p| {
        matches!(p, v1::frame::Payload::PtyAttachResponse(_))
    }) else {
        panic!("attach");
    };
    assert_eq!(attached.pid, u64::from(pid_a));
    let mut replay = Vec::new();
    while !String::from_utf8_lossy(&replay).contains("A_RETAINED") {
        if let v1::frame::Payload::PtyOutput(value) = read_until(&mut primary, |p| {
            matches!(p, v1::frame::Payload::PtyOutput(_))
        }) {
            replay.extend(value.bytes);
        }
    }
    for id in ["a", "b"] {
        write_request(
            &mut primary,
            v1::frame::Payload::PtyCloseRequest(v1::PtyCloseRequest {
                request_id: format!("close-{id}"),
                pty_id: id.into(),
                terminate: true,
            }),
        );
        read_until(
            &mut primary,
            |p| matches!(p, v1::frame::Payload::PtyExited(v) if v.pty_id == id && (v.has_exit_code || v.has_signal)),
        );
    }
}
