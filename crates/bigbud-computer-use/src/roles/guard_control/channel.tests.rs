//! End-to-end guard role over an isolated fixture root: real election,
//! recovery, guard service and control channel over socket pairs.
use super::super::framing::{ReadOutcome, read_frame, write_frame};
use crate::{
    guard::{DurableRoot, test_support::TestDirectory},
    roles::{
        guard::{EXIT_SETTLED, elect, serve_with},
        guard_control::ControlConfig,
    },
};
use bigbud_protocol::computer_use::{
    CONTROL_FRAME_BYTES, DATA_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, QUALIFICATION_PROFILE,
    common, control,
    v1::{self, frame::Payload},
};
use std::{io::Write, os::unix::net::UnixStream, sync::mpsc, thread, time::Duration};

fn frame(payload: Payload) -> v1::Frame {
    v1::Frame {
        payload: Some(payload),
    }
}
fn next(reader: &mut UnixStream) -> Payload {
    match read_frame(reader, || {}) {
        Ok(ReadOutcome::Frame(frame)) => frame.payload.unwrap(),
        other => panic!("expected a frame, got {other:?}"),
    }
}
fn hello() -> v1::Frame {
    frame(Payload::Hello(common::Hello {
        protocol_major: PROTOCOL_MAJOR,
        protocol_minor: PROTOCOL_MINOR,
        role: "human-control".into(),
        qualification_profile: QUALIFICATION_PROFILE.into(),
        control_frame_bytes: CONTROL_FRAME_BYTES as u32,
        data_frame_bytes: DATA_FRAME_BYTES as u32,
        instance_id: "electron-test".into(),
        ..Default::default()
    }))
}
fn query(id: &str) -> v1::Frame {
    frame(Payload::Status(control::Status {
        request_id: id.into(),
        ..Default::default()
    }))
}
fn stop(id: &str) -> v1::Frame {
    frame(Payload::Stop(control::Stop {
        operation_id: id.into(),
        desktop_scope: String::new(),
    }))
}
fn status(payload: Payload) -> control::Status {
    match payload {
        Payload::Status(status) => status,
        other => panic!("expected status, got {other:?}"),
    }
}

struct Guard {
    to_guard: UnixStream,
    from_guard: UnixStream,
    finished: mpsc::Receiver<u8>,
}
fn start(fixture: &TestDirectory) -> Guard {
    start_with(fixture, ControlConfig::default())
}
fn start_with(fixture: &TestDirectory, config: ControlConfig) -> Guard {
    let lock = elect(DurableRoot::fixture(&fixture.0, true).unwrap()).unwrap();
    let (to_guard, guard_input) = UnixStream::pair().unwrap();
    let (from_guard, guard_output) = UnixStream::pair().unwrap();
    from_guard
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let (done, finished) = mpsc::channel();
    thread::spawn(move || {
        done.send(serve_with(lock, guard_input, guard_output, config))
            .unwrap();
    });
    Guard {
        to_guard,
        from_guard,
        finished,
    }
}
fn persisted_epoch(fixture: &TestDirectory) -> (u64, bool) {
    let mut lock = elect(DurableRoot::fixture(&fixture.0, true).unwrap()).unwrap();
    let recovery = lock.recover_retained();
    let record = recovery.record().unwrap();
    (record.pause_epoch, record.latched)
}

#[test]
fn hello_status_and_stop_latch_durably_then_eof_settles() {
    let fixture = TestDirectory::new();
    let mut guard = start(&fixture);
    let Payload::Hello(greeting) = next(&mut guard.from_guard) else {
        panic!("guard must speak first");
    };
    assert_eq!(greeting.role, "guard");
    assert!(greeting.instance_id.starts_with("guard-"));

    write_frame(&mut guard.to_guard, &hello()).unwrap();
    write_frame(&mut guard.to_guard, &query("q1")).unwrap();
    let mut before = status(next(&mut guard.from_guard));
    // The first answer may precede the storage lane's first pass.
    while before.state == "starting" {
        thread::sleep(Duration::from_millis(20));
        write_frame(&mut guard.to_guard, &query("q1")).unwrap();
        before = status(next(&mut guard.from_guard));
    }
    assert_eq!(
        (before.request_id.as_str(), before.state.as_str()),
        ("q1", "paused")
    );

    write_frame(&mut guard.to_guard, &stop("op-1")).unwrap();
    let Payload::Revoked(revoked) = next(&mut guard.from_guard) else {
        panic!("Stop must be confirmed by a durable latch");
    };
    assert_eq!(revoked.operation_id, "op-1");
    assert_eq!(revoked.pause_epoch, before.pause_epoch + 1);
    // Idempotent: a repeated Stop reports the same persisted latch.
    write_frame(&mut guard.to_guard, &stop("op-2")).unwrap();
    let Payload::Revoked(again) = next(&mut guard.from_guard) else {
        panic!("repeated Stop");
    };
    assert_eq!(again.pause_epoch, revoked.pause_epoch);

    let resume = frame(Payload::Resume(control::Resume {
        request_id: "r1".into(),
        ..Default::default()
    }));
    write_frame(&mut guard.to_guard, &resume).unwrap();
    let Payload::ProtocolError(error) = next(&mut guard.from_guard) else {
        panic!("Resume must be refused");
    };
    assert_eq!(
        (error.request_id.as_str(), error.code.as_str()),
        ("r1", "resume_unavailable")
    );

    drop(guard.to_guard);
    let code = guard
        .finished
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    assert_eq!(code, EXIT_SETTLED);
    assert_eq!(persisted_epoch(&fixture), (revoked.pause_epoch, true));
}

#[test]
fn a_malformed_stream_latches_and_shuts_down() {
    let fixture = TestDirectory::new();
    let mut guard = start(&fixture);
    let _hello = next(&mut guard.from_guard);
    // Garbage that is not a valid protobuf frame of the stated length.
    guard.to_guard.write_all(&[0, 0, 0, 2, 0xff, 0xff]).unwrap();
    let Payload::ProtocolError(error) = next(&mut guard.from_guard) else {
        panic!("expected a protocol error");
    };
    assert_eq!(error.code, "malformed_frame");
    let code = guard
        .finished
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    assert_eq!(code, EXIT_SETTLED);
    // Initial record (epoch 0, latched) plus exactly one durable denial.
    assert_eq!(persisted_epoch(&fixture), (1, true));
}

#[test]
fn a_frame_stalled_past_its_deadline_latches_and_shuts_down() {
    let fixture = TestDirectory::new();
    let config = ControlConfig {
        frame_deadline: Duration::from_millis(300),
        ..ControlConfig::default()
    };
    let mut guard = start_with(&fixture, config);
    let _hello = next(&mut guard.from_guard);
    // Announce 9 bytes, send one, then stall with the stream still open.
    guard.to_guard.write_all(&[0, 0, 0, 9, 0x0a]).unwrap();
    let code = guard
        .finished
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    assert_eq!(code, EXIT_SETTLED);
    assert_eq!(persisted_epoch(&fixture), (1, true));
    drop(guard.to_guard);
}
