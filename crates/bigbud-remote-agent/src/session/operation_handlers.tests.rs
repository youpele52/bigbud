use bigbud_protocol::pty_lifecycle;
use v1::frame::Payload;

use super::*;

fn ready_session() -> (AgentSession, v1::AgentHello) {
    let mut session = AgentSession::with_epoch("epoch-1");
    let hello = session
        .handle(v1::Frame {
            payload: Some(Payload::ClientHello(v1::ClientHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                client_instance_id: "client-1".to_owned(),
                connection_id: "connection-1".to_owned(),
                server_nonce: "nonce".to_owned(),
                max_frame_bytes: 1024,
            })),
        })
        .unwrap();
    let Some(Payload::AgentHello(hello)) = hello.payload else {
        panic!("expected agent hello");
    };
    (session, hello)
}

fn refusal(session: &mut AgentSession, payload: Payload) -> Payload {
    session
        .handle(v1::Frame {
            payload: Some(payload),
        })
        .expect("lifecycle requests are refused with a typed response")
        .payload
        .expect("refusal payload")
}

#[test]
fn lifecycle_capabilities_are_not_advertised_before_they_are_implemented() {
    let (_, hello) = ready_session();
    for name in [
        pty_lifecycle::SCREEN_CAPABILITY,
        pty_lifecycle::LIFECYCLE_CAPABILITY,
        pty_lifecycle::SPOOL_CAPABILITY,
        pty_lifecycle::QUERY_RESPONDER_CAPABILITY,
        pty_lifecycle::LOCAL_LAUNCH_CAPABILITY,
    ] {
        assert!(hello.capabilities.iter().all(|cap| cap.name != name));
    }
}

#[test]
fn lifecycle_requests_get_typed_unsupported_refusals() {
    let (mut session, _) = ready_session();
    let unsupported = pty_lifecycle::UNSUPPORTED;

    let header = refusal(
        &mut session,
        Payload::PtyScreenSnapshotRequest(v1::PtyScreenSnapshotRequest {
            request_id: "snap-1".to_owned(),
            pty_id: "pty-1".to_owned(),
            attach_renderer: true,
            ..Default::default()
        }),
    );
    let Payload::PtyScreenSnapshotHeader(header) = header else {
        panic!("expected snapshot header");
    };
    assert_eq!(
        (header.request_id.as_str(), header.pty_id.as_str()),
        ("snap-1", "pty-1")
    );
    assert!(!header.accepted);
    assert_eq!(header.error_code, unsupported);
    assert_eq!(header.chunk_count, 0);

    let policy = refusal(
        &mut session,
        Payload::HostPolicyUpdateRequest(Box::new(v1::HostPolicyUpdateRequest {
            request_id: "policy-1".to_owned(),
            policy: Some(v1::HostPolicy {
                lifecycle_enabled: true,
                ..Default::default()
            }),
        })),
    );
    assert!(matches!(policy, Payload::HostPolicyUpdateResponse(response)
        if response.request_id == "policy-1" && !response.accepted
            && response.error_code == unsupported && response.effective.is_none()));

    let view = refusal(
        &mut session,
        Payload::PtyViewStateRequest(Box::new(v1::PtyViewStateRequest {
            request_id: "view-1".to_owned(),
            pty_id: "pty-1".to_owned(),
            view_state: "hidden".to_owned(),
            ..Default::default()
        })),
    );
    assert!(matches!(view, Payload::PtyViewStateResponse(response)
        if response.request_id == "view-1" && response.pty_id == "pty-1"
            && !response.accepted && response.error_code == unsupported));

    let keep = refusal(
        &mut session,
        Payload::PtyKeepOpenRequest(v1::PtyKeepOpenRequest {
            request_id: "keep-1".to_owned(),
            pty_id: "pty-1".to_owned(),
        }),
    );
    assert!(matches!(keep, Payload::PtyKeepOpenResponse(response)
        if response.request_id == "keep-1" && !response.accepted
            && response.error_code == unsupported));

    let close_all = refusal(
        &mut session,
        Payload::PtyCloseAllRequest(v1::PtyCloseAllRequest {
            request_id: "close-all-1".to_owned(),
            reason: "quit".to_owned(),
            managed_only: true,
        }),
    );
    assert!(matches!(close_all, Payload::PtyCloseAllResponse(response)
        if response.request_id == "close-all-1" && !response.accepted
            && response.closed_count == 0 && response.error_code == unsupported));

    let replay = refusal(
        &mut session,
        Payload::HostNoticeReplayRequest(v1::HostNoticeReplayRequest {
            request_id: "replay-1".to_owned(),
            expected_epoch: "epoch-1".to_owned(),
            after_notice_id: 3,
        }),
    );
    assert!(matches!(replay, Payload::HostNoticeReplayResponse(response)
        if response.request_id == "replay-1" && response.agent_epoch == "epoch-1"
            && !response.accepted && response.notices.is_empty()
            && response.error_code == unsupported));
}

#[test]
fn lifecycle_requests_still_require_hello() {
    let mut session = AgentSession::with_epoch("epoch-1");
    let error = session
        .handle(v1::Frame {
            payload: Some(Payload::PtyKeepOpenRequest(v1::PtyKeepOpenRequest {
                request_id: "keep-1".to_owned(),
                pty_id: "pty-1".to_owned(),
            })),
        })
        .unwrap_err();
    assert!(matches!(error, SessionError::HelloRequired));
}

#[test]
fn agent_to_client_lifecycle_frames_stay_unexpected() {
    let (mut session, _) = ready_session();
    let error = session
        .handle(v1::Frame {
            payload: Some(Payload::PtyActivity(v1::PtyActivity {
                pty_id: "pty-1".to_owned(),
                ..Default::default()
            })),
        })
        .unwrap_err();
    assert!(matches!(error, SessionError::UnexpectedMessage));
}
