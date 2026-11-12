use prost::Message;

use crate::{DEFAULT_MAX_FRAME_BYTES, decode_frame, encode_frame, v1};

fn golden(name: &str) -> Vec<u8> {
    let (_, hex) = include_str!("../../../../protocol/remote-agent/v1.golden.frames")
        .lines()
        .filter_map(|line| line.split_once('='))
        .find(|(key, _)| *key == name)
        .expect("shared PTY golden exists");
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("hex"), 16).expect("hex byte")
        })
        .collect()
}

#[test]
fn pty_launch_status_matches_shared_typescript_goldens() {
    for (name, status) in [
        ("pty_create_unknown", ""),
        ("pty_create_unconfirmed", "unconfirmed"),
    ] {
        let frame = v1::Frame {
            payload: Some(v1::frame::Payload::PtyCreateResponse(
                v1::PtyCreateResponse {
                    request_id: "create-1".to_owned(),
                    pty_id: "pty-1".to_owned(),
                    accepted: true,
                    pid: 42,
                    launch_status: status.to_owned(),
                    ..Default::default()
                },
            )),
        };
        let bytes = golden(name);
        assert_eq!(
            encode_frame(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            bytes
        );
        assert_eq!(
            decode_frame(&bytes, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            frame
        );
    }
    for (name, state, status) in [
        ("pty_attach_unknown", "running", ""),
        ("pty_attach_unconfirmed", "running", "unconfirmed"),
        ("pty_attach_exited_unconfirmed", "exited", "unconfirmed"),
    ] {
        let frame = v1::Frame {
            payload: Some(v1::frame::Payload::PtyAttachResponse(
                v1::PtyAttachResponse {
                    request_id: "attach-1".to_owned(),
                    pty_id: "pty-1".to_owned(),
                    state: state.to_owned(),
                    pid: 42,
                    next_sequence: 2,
                    first_retained_sequence: 1,
                    replay_gap: false,
                    launch_status: status.to_owned(),
                },
            )),
        };
        let bytes = golden(name);
        assert_eq!(
            encode_frame(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            bytes
        );
        assert_eq!(
            decode_frame(&bytes, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            frame
        );
    }
}

#[test]
fn exact_profile_marker_matches_shared_typescript_goldens() {
    for (name, profile_launch) in [("pty_profile_absent", false), ("pty_profile_true", true)] {
        let frame = v1::Frame {
            payload: Some(v1::frame::Payload::PtyCreateRequest(v1::PtyCreateRequest {
                request_id: "create-1".to_owned(),
                pty_id: "pty-1".to_owned(),
                request_digest: vec![1, 2, 3],
                workspace_handle: "workspace-1".to_owned(),
                shell: "/bin/zsh".to_owned(),
                args: vec!["-o".to_owned(), "nopromptsp".to_owned()],
                cols: 80,
                rows: 24,
                profile_launch,
                ..Default::default()
            })),
        };
        let bytes = golden(name);
        assert_eq!(
            encode_frame(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            bytes
        );
        assert_eq!(
            decode_frame(&bytes, DEFAULT_MAX_FRAME_BYTES).unwrap(),
            frame
        );
    }
    let explicit_false =
        decode_frame(&golden("pty_profile_false"), DEFAULT_MAX_FRAME_BYTES).unwrap();
    let Some(v1::frame::Payload::PtyCreateRequest(request)) = explicit_false.payload else {
        panic!("expected PTY request");
    };
    assert!(!request.profile_launch);
    for name in ["pty_profile_malformed_wire", "pty_profile_malformed_varint"] {
        assert!(decode_frame(&golden(name), DEFAULT_MAX_FRAME_BYTES).is_err());
    }
    let mut nonzero = golden("pty_profile_true");
    *nonzero.last_mut().unwrap() = 2;
    let decoded = decode_frame(&nonzero, DEFAULT_MAX_FRAME_BYTES).unwrap();
    let Some(v1::frame::Payload::PtyCreateRequest(request)) = decoded.payload else {
        panic!("expected PTY request");
    };
    assert!(request.profile_launch);
}

// A pre-1.5 reader ignores tag 11. Fields below it are still preserved.
#[derive(Clone, PartialEq, Message)]
struct LegacyCreateRequest {
    #[prost(string, tag = "1")]
    request_id: String,
    #[prost(string, tag = "2")]
    pty_id: String,
    #[prost(bytes = "vec", tag = "3")]
    request_digest: Vec<u8>,
    #[prost(string, tag = "4")]
    workspace_handle: String,
    #[prost(string, tag = "5")]
    cwd: String,
    #[prost(string, tag = "6")]
    shell: String,
    #[prost(string, repeated, tag = "7")]
    args: Vec<String>,
    #[prost(uint32, tag = "8")]
    cols: u32,
    #[prost(uint32, tag = "9")]
    rows: u32,
    #[prost(message, repeated, tag = "10")]
    environment: Vec<v1::ProcessEnvironment>,
}

#[test]
fn pre_1_5_readers_ignore_profile_marker_and_old_writers_default_false() {
    let decoded = decode_frame(&golden("pty_profile_true"), DEFAULT_MAX_FRAME_BYTES).unwrap();
    let Some(v1::frame::Payload::PtyCreateRequest(request)) = decoded.payload else {
        panic!("expected PTY request");
    };
    let legacy = LegacyCreateRequest::decode(request.encode_to_vec().as_slice()).unwrap();
    assert_eq!(legacy.shell, "/bin/zsh");
    assert_eq!(legacy.args, ["-o", "nopromptsp"]);
    let current = v1::PtyCreateRequest::decode(legacy.encode_to_vec().as_slice()).unwrap();
    assert!(!current.profile_launch);
    assert_eq!(current.request_digest, request.request_digest);
    assert_eq!(current.args, request.args);
}

// Model the pre-1.4 response schema to verify additive unknown-field behavior.
#[derive(Clone, PartialEq, Message)]
struct LegacyCreateResponse {
    #[prost(string, tag = "1")]
    request_id: String,
    #[prost(string, tag = "2")]
    pty_id: String,
    #[prost(bool, tag = "3")]
    accepted: bool,
    #[prost(uint64, tag = "4")]
    pid: u64,
    #[prost(string, tag = "5")]
    error_code: String,
    #[prost(string, tag = "6")]
    error_message: String,
}

#[derive(Clone, PartialEq, Message)]
struct LegacyAttachResponse {
    #[prost(string, tag = "1")]
    request_id: String,
    #[prost(string, tag = "2")]
    pty_id: String,
    #[prost(string, tag = "3")]
    state: String,
    #[prost(uint64, tag = "4")]
    pid: u64,
    #[prost(uint64, tag = "5")]
    next_sequence: u64,
    #[prost(uint64, tag = "6")]
    first_retained_sequence: u64,
    #[prost(bool, tag = "7")]
    replay_gap: bool,
}

#[test]
fn pre_1_4_readers_ignore_status_and_old_writers_leave_status_unknown() {
    let create = v1::PtyCreateResponse {
        request_id: "create".to_owned(),
        pty_id: "pty".to_owned(),
        accepted: true,
        pid: 42,
        launch_status: "unconfirmed".to_owned(),
        ..Default::default()
    };
    let legacy = LegacyCreateResponse::decode(create.encode_to_vec().as_slice()).unwrap();
    assert_eq!(legacy.pid, 42);
    assert!(legacy.accepted);
    let decoded = v1::PtyCreateResponse::decode(legacy.encode_to_vec().as_slice()).unwrap();
    assert!(decoded.launch_status.is_empty());
    assert_eq!(decoded.request_id, create.request_id);

    let attach = v1::PtyAttachResponse {
        request_id: "attach".to_owned(),
        pty_id: "pty".to_owned(),
        state: "exited".to_owned(),
        pid: 42,
        next_sequence: 2,
        first_retained_sequence: 1,
        replay_gap: true,
        launch_status: "unconfirmed".to_owned(),
    };
    let legacy = LegacyAttachResponse::decode(attach.encode_to_vec().as_slice()).unwrap();
    assert_eq!(legacy.state, "exited");
    assert!(legacy.replay_gap);
    let decoded = v1::PtyAttachResponse::decode(legacy.encode_to_vec().as_slice()).unwrap();
    assert!(decoded.launch_status.is_empty());
    assert_eq!(decoded.next_sequence, 2);
}
