use super::{
    framing::{ControlReadError, ReadOutcome, read_frame, write_frame},
    session::{Request, classify, guard_hello, status_frame},
};
use crate::guard::{GuardStatusSnapshot, record::SafetyRecord};
use bigbud_protocol::computer_use::{
    CONTROL_FRAME_BYTES, Channel, DATA_FRAME_BYTES, FrameError, PROTOCOL_MAJOR, PROTOCOL_MINOR,
    QUALIFICATION_PROFILE, common, control, encode_frame, execution, policy,
    v1::{self, frame::Payload},
};
use std::io::Cursor;

fn frame(payload: Payload) -> v1::Frame {
    v1::Frame {
        payload: Some(payload),
    }
}
fn parent_hello() -> common::Hello {
    common::Hello {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: PROTOCOL_MINOR,
        role: "human-control".into(),
        qualification_profile: QUALIFICATION_PROFILE.into(),
        control_frame_bytes: CONTROL_FRAME_BYTES as u32,
        data_frame_bytes: DATA_FRAME_BYTES as u32,
        instance_id: "electron-1".into(),
        ..Default::default()
    }
}
fn status_query(id: &str) -> v1::Frame {
    frame(Payload::Status(control::Status {
        request_id: id.into(),
        ..Default::default()
    }))
}
fn refused(id: &str, code: &'static str) -> Request {
    Request::Refuse {
        request_id: id.into(),
        code,
    }
}

#[test]
fn admission_constants_match_the_protocol_crate() {
    use crate::owner::admission::{hello, limits};
    assert_eq!(hello::PROTOCOL_MAJOR, PROTOCOL_MAJOR);
    assert_eq!(hello::PROTOCOL_MINOR, PROTOCOL_MINOR);
    assert_eq!(limits::CONTROL_FRAME_BYTES as usize, CONTROL_FRAME_BYTES);
    assert_eq!(limits::DATA_FRAME_BYTES as usize, DATA_FRAME_BYTES);
}

#[test]
fn frames_round_trip_and_eof_is_the_lifeline() {
    let mut bytes = Vec::new();
    write_frame(&mut bytes, &guard_hello("guard-1")).unwrap();
    write_frame(&mut bytes, &status_query("q1")).unwrap();
    let mut reader = Cursor::new(bytes);
    let ReadOutcome::Frame(hello) = read_frame(&mut reader, || {}).unwrap() else {
        panic!("expected hello");
    };
    let Some(Payload::Hello(hello)) = hello.payload else {
        panic!("expected hello payload");
    };
    assert_eq!(
        (hello.role.as_str(), hello.tuple_digest.as_str()),
        ("guard", "")
    );
    assert!(matches!(
        read_frame(&mut reader, || {}),
        Ok(ReadOutcome::Frame(_))
    ));
    assert!(matches!(
        read_frame(&mut reader, || {}),
        Ok(ReadOutcome::Closed)
    ));
}

#[test]
fn the_frame_deadline_starts_only_when_a_frame_begins() {
    let started = std::cell::Cell::new(0);
    let closed = read_frame(&mut Cursor::new(Vec::new()), || {
        started.set(started.get() + 1)
    });
    assert!(matches!(closed, Ok(ReadOutcome::Closed)));
    assert_eq!(started.get(), 0);
    let mut bytes = Vec::new();
    write_frame(&mut bytes, &status_query("q")).unwrap();
    let read = read_frame(&mut Cursor::new(bytes), || started.set(started.get() + 1));
    assert!(matches!(read, Ok(ReadOutcome::Frame(_))));
    assert_eq!(started.get(), 1);
}

#[test]
fn malformed_streams_are_refused_before_payload_allocation() {
    let oversized = ((CONTROL_FRAME_BYTES + 1) as u32).to_be_bytes();
    for (bytes, expected) in [
        (vec![0, 0], "truncated"),
        (vec![0, 0, 0, 0], "length"),
        (oversized.to_vec(), "length"),
        (vec![0, 0, 0, 9, 1], "truncated"),
    ] {
        let outcome = read_frame(&mut Cursor::new(bytes), || {});
        match (outcome, expected) {
            (Err(ControlReadError::Truncated), "truncated")
            | (Err(ControlReadError::Frame(FrameError::Length)), "length") => {}
            (other, _) => panic!("{expected}: {other:?}"),
        }
    }
    // A data-channel frame on the control channel is a protocol error.
    let call = frame(Payload::MediatedCall(execution::MediatedCall {
        ticket: "t".into(),
        mcp_frame: vec![1],
        ..Default::default()
    }));
    let bytes = encode_frame(&call, Channel::Data).unwrap();
    assert!(matches!(
        read_frame(&mut Cursor::new(bytes), || {}),
        Err(ControlReadError::Frame(FrameError::Channel))
    ));
}

#[test]
fn stop_is_never_gated_and_status_needs_a_compatible_hello() {
    let mut hello = false;
    let stop = frame(Payload::Stop(control::Stop {
        operation_id: "op-1".into(),
        desktop_scope: String::new(),
    }));
    assert_eq!(
        classify(stop.clone(), &mut hello),
        Request::Stop {
            operation_id: "op-1".into()
        }
    );
    assert_eq!(
        classify(status_query("q1"), &mut hello),
        refused("q1", "hello_required")
    );
    assert_eq!(
        classify(frame(Payload::Hello(parent_hello())), &mut hello),
        Request::Accepted
    );
    assert!(hello);
    assert_eq!(
        classify(status_query("q2"), &mut hello),
        Request::Status {
            request_id: "q2".into()
        }
    );
    assert_eq!(
        classify(frame(Payload::Hello(parent_hello())), &mut hello),
        refused("", "duplicate_hello")
    );
    assert!(matches!(classify(stop, &mut hello), Request::Stop { .. }));
}

#[test]
fn incompatible_peers_and_non_query_frames_are_refused() {
    for change in [
        |h: &mut common::Hello| h.role = "server".into(),
        |h: &mut common::Hello| h.protocol_major = 2,
        |h: &mut common::Hello| h.qualification_profile = "other".into(),
        |h: &mut common::Hello| h.control_frame_bytes = 1024,
        |h: &mut common::Hello| h.instance_id.clear(),
    ] {
        let mut peer = parent_hello();
        change(&mut peer);
        let mut hello = false;
        assert_eq!(
            classify(frame(Payload::Hello(peer)), &mut hello),
            Request::Incompatible
        );
        assert!(!hello);
    }
    let mut hello = true;
    let answer = frame(Payload::Status(control::Status {
        request_id: "q3".into(),
        state: "unpaused".into(),
        ..Default::default()
    }));
    assert_eq!(
        classify(answer, &mut hello),
        refused("q3", "invalid_request")
    );
    assert_eq!(
        classify(status_query(""), &mut hello),
        refused("", "invalid_request")
    );
    let resume = frame(Payload::Resume(control::Resume {
        request_id: "r1".into(),
        ..Default::default()
    }));
    assert_eq!(
        classify(resume, &mut hello),
        refused("r1", "resume_unavailable")
    );
    let apply = frame(Payload::ApplyPolicy(policy::ApplyPolicy::default()));
    assert_eq!(classify(apply, &mut hello), refused("", "unsupported"));
    assert_eq!(
        classify(v1::Frame { payload: None }, &mut hello),
        refused("", "invalid_request")
    );
}

#[test]
fn status_projects_only_the_persisted_safety_record() {
    let status = |frame: v1::Frame| match frame.payload {
        Some(Payload::Status(status)) => status,
        other => panic!("expected status, got {other:?}"),
    };
    assert_eq!(status(status_frame("q", None)).state, "starting");
    let mut record = SafetyRecord::initial();
    record.pause_epoch = 3;
    let snapshot = GuardStatusSnapshot {
        record: record.clone(),
        denial_persisted: true,
        storage_ok: true,
    };
    let paused = status(status_frame("q", Some(&snapshot)));
    assert_eq!(
        (
            paused.state.as_str(),
            paused.pause_epoch,
            paused.retirement.as_str(),
            paused.input_state.as_str(),
            paused.applied_revision.as_str(),
            paused.queued_operations,
        ),
        ("paused", 3, "none_attached", "known", "", 0)
    );
    let failed = GuardStatusSnapshot {
        storage_ok: false,
        ..snapshot
    };
    assert_eq!(
        status(status_frame("q", Some(&failed))).state,
        "storage_failed"
    );
}
