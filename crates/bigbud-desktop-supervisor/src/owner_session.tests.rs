use super::*;
use std::io::Cursor;

use crate::{DEFAULT_MAX_FRAME_BYTES, canonical_batch_id, read_frame, write_frame};

fn hello(protocol_major: u32) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: "desktop-1".to_owned(),
            requested_limits: None,
        })),
    }
}

fn attach() -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::AttachConsumer(v1::AttachConsumer {
            consumer_id: "main".to_owned(),
            consumer_generation: 1,
            server_epoch: "epoch-1".to_owned(),
            applied_sequence: 10,
        })),
    }
}

fn batch() -> v1::EventBatch {
    let mut batch = v1::EventBatch {
        batch_id: String::new(),
        server_epoch: "epoch-1".to_owned(),
        subscription_generation: 1,
        consumer_id: "main".to_owned(),
        consumer_generation: 1,
        events: vec![v1::Event {
            event_id: "event-11".to_owned(),
            sequence: 11,
            canonical_payload: vec![1, 2, 3],
        }],
    };
    batch.batch_id = canonical_batch_id(&batch);
    batch
}

fn batch_frame(batch: v1::EventBatch) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::EventBatch(batch)),
    }
}

fn acknowledgement(batch_id: String) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::ApplicationAck(v1::ApplicationAck {
            batch_id,
            consumer_id: "main".to_owned(),
            consumer_generation: 1,
            received_through_sequence: 11,
            applied_through_sequence: 11,
            application_duration_ms: 1,
        })),
    }
}

fn framed(frame: v1::Frame) -> v1::Frame {
    let mut bytes = Vec::new();
    write_frame(&mut bytes, &frame, DEFAULT_MAX_FRAME_BYTES).expect("frame should encode");
    read_frame(&mut Cursor::new(bytes), DEFAULT_MAX_FRAME_BYTES)
        .expect("frame should decode")
        .expect("frame should be present")
}

fn protocol_error_code(result: &SessionResult) -> Option<&str> {
    let frame = result.responses.first()?;
    let v1::frame::Payload::ProtocolError(error) = frame.payload.as_ref()? else {
        return None;
    };
    Some(error.code.as_str())
}

#[test]
fn rejects_operations_before_client_hello() {
    let limits = Limits::default();
    let mut session = OwnerSession::new(limits, "supervisor-1".to_owned());
    let mut supervisor = Supervisor::new(limits);

    let result = session.handle_frame(&mut supervisor, attach(), 0);
    assert!(result.is_ok(), "unexpected error: {result:?}");
    let Ok(result) = result else {
        return;
    };
    assert!(result.close);
    assert_eq!(protocol_error_code(&result), Some("handshake_required"));
    assert_eq!(
        supervisor.state("main", 1),
        Err(SupervisorError::ConsumerMissing)
    );
}

#[test]
fn closes_after_an_incompatible_protocol_major() {
    let limits = Limits::default();
    let mut session = OwnerSession::new(limits, "supervisor-1".to_owned());
    let mut supervisor = Supervisor::new(limits);

    let result = session.handle_frame(&mut supervisor, hello(PROTOCOL_MAJOR + 1), 0);
    assert!(result.is_ok(), "unexpected error: {result:?}");
    let Ok(result) = result else {
        return;
    };
    assert!(result.close);
    assert_eq!(protocol_error_code(&result), Some("incompatible_protocol"));

    let retry = session.handle_frame(&mut supervisor, hello(PROTOCOL_MAJOR), 1);
    assert!(retry.is_ok(), "unexpected error: {retry:?}");
    let Ok(retry) = retry else {
        return;
    };
    assert!(retry.close);
    assert_eq!(protocol_error_code(&retry), Some("session_rejected"));
}

#[test]
fn accepts_operations_only_after_a_compatible_handshake() {
    let limits = Limits::default();
    let mut session = OwnerSession::new(limits, "supervisor-1".to_owned());
    let mut supervisor = Supervisor::new(limits);

    let greeting = session.handle_frame(&mut supervisor, hello(PROTOCOL_MAJOR), 0);
    assert!(matches!(
        greeting,
        Ok(SessionResult {
            close: false,
            responses,
        }) if matches!(
            responses.first().and_then(|frame| frame.payload.as_ref()),
            Some(v1::frame::Payload::SupervisorHello(_))
        )
    ));
    let attached = session.handle_frame(&mut supervisor, attach(), 1);
    assert!(matches!(
        attached,
        Ok(SessionResult {
            close: false,
            responses,
        }) if matches!(
            responses.first().and_then(|frame| frame.payload.as_ref()),
            Some(v1::frame::Payload::ConsumerAttached(attached))
                if attached.acknowledged_sequence == 10
        )
    ));
}

#[test]
fn installs_a_typescript_authorized_projection_baseline() {
    let limits = Limits::default();
    let mut session = OwnerSession::new(limits, "supervisor-1".to_owned());
    let mut supervisor = Supervisor::new(limits);
    session
        .handle_frame(&mut supervisor, hello(PROTOCOL_MAJOR), 0)
        .unwrap();
    session.handle_frame(&mut supervisor, attach(), 1).unwrap();

    let result = session
        .handle_frame(
            &mut supervisor,
            v1::Frame {
                payload: Some(v1::frame::Payload::InstallBaseline(v1::InstallBaseline {
                    recovery_id: "recovery-1".to_owned(),
                    consumer_id: "main".to_owned(),
                    consumer_generation: 1,
                    server_epoch: "epoch-1".to_owned(),
                    applied_projection_sequence: 100,
                })),
            },
            2,
        )
        .unwrap();

    assert!(matches!(
        result.responses.first().and_then(|frame| frame.payload.as_ref()),
        Some(v1::frame::Payload::BaselineInstalled(installed))
            if installed.recovery_id == "recovery-1"
                && installed.acknowledged_sequence == 100
                && installed.server_epoch == "epoch-1"
                && installed.applied_projection_sequence == 100
    ));
}

#[test]
fn replays_an_exact_framed_duplicate_while_in_flight() {
    let limits = Limits::default();
    let mut session = OwnerSession::new(limits, "supervisor-1".to_owned());
    let mut supervisor = Supervisor::new(limits);
    session
        .handle_frame(&mut supervisor, hello(PROTOCOL_MAJOR), 0)
        .unwrap();
    session.handle_frame(&mut supervisor, attach(), 1).unwrap();
    let first = framed(batch_frame(batch()));
    let first_result = session
        .handle_frame(&mut supervisor, first.clone(), 2)
        .unwrap();
    assert!(!first_result.responses.is_empty());
    assert!(matches!(
        first_result
            .responses
            .first()
            .and_then(|frame| frame.payload.as_ref()),
        Some(v1::frame::Payload::EventBatch(_))
    ));
    let duplicate_result = session
        .handle_frame(&mut supervisor, framed(first), 3)
        .unwrap();
    assert!(!duplicate_result.responses.is_empty());
    assert_eq!(duplicate_result.responses, first_result.responses);
}

#[test]
fn replays_an_exact_duplicate_after_acknowledgement() {
    let limits = Limits::default();
    let mut session = OwnerSession::new(limits, "supervisor-1".to_owned());
    let mut supervisor = Supervisor::new(limits);
    session
        .handle_frame(&mut supervisor, hello(PROTOCOL_MAJOR), 0)
        .unwrap();
    session.handle_frame(&mut supervisor, attach(), 1).unwrap();
    let event_batch = batch();
    let first_delivery = session
        .handle_frame(&mut supervisor, framed(batch_frame(event_batch.clone())), 2)
        .unwrap();
    assert!(!first_delivery.responses.is_empty());
    let acknowledged = session
        .handle_frame(
            &mut supervisor,
            framed(acknowledgement(event_batch.batch_id.clone())),
            3,
        )
        .unwrap();
    assert!(matches!(
        acknowledged
            .responses
            .first()
            .and_then(|frame| frame.payload.as_ref()),
        Some(v1::frame::Payload::ApplicationAckAccepted(_))
    ));
    let duplicate = session
        .handle_frame(&mut supervisor, framed(batch_frame(event_batch)), 4)
        .unwrap();
    assert!(!duplicate.responses.is_empty());
    assert_eq!(duplicate.responses, first_delivery.responses);
}

#[test]
fn conflicting_duplicate_identity_fatally_rejects_the_session() {
    let limits = Limits::default();
    let mut session = OwnerSession::new(limits, "supervisor-1".to_owned());
    let mut supervisor = Supervisor::new(limits);
    session
        .handle_frame(&mut supervisor, hello(PROTOCOL_MAJOR), 0)
        .unwrap();
    session.handle_frame(&mut supervisor, attach(), 1).unwrap();
    let original = batch();
    session
        .handle_frame(&mut supervisor, batch_frame(original.clone()), 2)
        .unwrap();
    let mut conflicting = original.clone();
    conflicting.events[0].canonical_payload = vec![9];
    let result = session
        .handle_frame(&mut supervisor, batch_frame(conflicting), 3)
        .unwrap();
    assert!(result.close);
    assert_eq!(
        protocol_error_code(&result),
        Some("batch_identity_conflict")
    );

    let rejected = session
        .handle_frame(&mut supervisor, v1::Frame { payload: None }, 4)
        .unwrap();
    assert!(rejected.close);
    assert_eq!(protocol_error_code(&rejected), Some("session_rejected"));
}

#[test]
fn rejects_duplicate_replay_when_epoch_does_not_match() {
    let limits = Limits::default();
    let mut session = OwnerSession::new(limits, "supervisor-1".to_owned());
    let mut supervisor = Supervisor::new(limits);
    session
        .handle_frame(&mut supervisor, hello(PROTOCOL_MAJOR), 0)
        .unwrap();
    session.handle_frame(&mut supervisor, attach(), 1).unwrap();
    let original = batch();
    session
        .handle_frame(&mut supervisor, batch_frame(original.clone()), 2)
        .unwrap();
    let mut wrong_epoch = batch();
    wrong_epoch.server_epoch = "epoch-2".to_owned();
    wrong_epoch.batch_id = original.batch_id;
    let result = session.handle_frame(&mut supervisor, batch_frame(wrong_epoch), 2);
    assert!(matches!(result, Err(SupervisorError::ServerEpochMismatch)));
}

#[test]
fn rejects_stale_attach_after_detach_but_accepts_verified_higher_generation() {
    let mut supervisor = Supervisor::new(Limits::default());
    assert_eq!(
        supervisor.attach("main".to_owned(), 1, "epoch-1".to_owned(), 10),
        Ok(10)
    );
    assert_eq!(supervisor.detach("main", 1), Ok(()));
    assert_eq!(
        supervisor.attach("main".to_owned(), 0, "epoch-1".to_owned(), 10),
        Err(SupervisorError::StaleConsumerGeneration)
    );
    assert_eq!(
        supervisor.attach("main".to_owned(), 1, "epoch-1".to_owned(), 10),
        Err(SupervisorError::StaleConsumerGeneration)
    );
    assert_eq!(
        supervisor.attach("main".to_owned(), 2, "epoch-1".to_owned(), 10),
        Ok(10)
    );
}

#[test]
fn rejects_unverified_cursor_on_higher_generation_reattach() {
    let mut supervisor = Supervisor::new(Limits::default());
    assert_eq!(
        supervisor.attach("main".to_owned(), 1, "epoch-1".to_owned(), 10),
        Ok(10)
    );
    assert_eq!(supervisor.detach("main", 1), Ok(()));
    assert_eq!(
        supervisor.attach("main".to_owned(), 2, "epoch-1".to_owned(), 11),
        Err(SupervisorError::AttachStateConflict)
    );
}
