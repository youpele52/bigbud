use crate::{DEFAULT_MAX_FRAME_BYTES, decode_frame, encode_frame, v1};

fn identity(entry_type: v1::ResourceCleanupEntryType) -> v1::ResourceCleanupIdentity {
    v1::ResourceCleanupIdentity {
        device_or_volume: "1".to_owned(),
        inode_or_file_id: "2".to_owned(),
        entry_type: entry_type as i32,
    }
}

fn assert_golden(name: &str, frame: v1::Frame) {
    let encoded = encode_frame(&frame, DEFAULT_MAX_FRAME_BYTES).expect("encode");
    let expected = include_str!("../../../../protocol/remote-agent/v1.golden.frames")
        .lines()
        .find_map(|line| line.split_once('=').filter(|(key, _)| *key == name))
        .map(|(_, value)| {
            value
                .as_bytes()
                .chunks_exact(2)
                .map(|pair| {
                    u8::from_str_radix(std::str::from_utf8(pair).expect("hex"), 16).expect("byte")
                })
                .collect::<Vec<_>>()
        })
        .expect("golden frame");
    assert_eq!(encoded, expected);
    assert_eq!(
        decode_frame(&expected, DEFAULT_MAX_FRAME_BYTES).expect("decode"),
        frame
    );
}

#[test]
fn matches_resource_cleanup_golden_frames() {
    assert_golden(
        "resource_cleanup_root_bootstrap_request",
        v1::Frame {
            payload: Some(v1::frame::Payload::ResourceCleanupRootBootstrapRequest(
                v1::ResourceCleanupRootBootstrapRequest {
                    request_id: "root-request".to_owned(),
                    platform: "linux".to_owned(),
                    roots: vec![v1::ResourceCleanupRoot {
                        root_id: "0".to_owned(),
                        path: "/tmp/root".to_owned(),
                        identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
                    }],
                },
            )),
        },
    );
    assert_golden(
        "resource_cleanup_root_bootstrap_response",
        v1::Frame {
            payload: Some(v1::frame::Payload::ResourceCleanupRootBootstrapResponse(
                v1::ResourceCleanupRootBootstrapResponse {
                    request_id: "root-request".to_owned(),
                    accepted: true,
                    error_code: String::new(),
                    roots: vec![v1::ResourceCleanupRootHandle {
                        root_id: "0".to_owned(),
                        root_handle: "root-0".to_owned(),
                    }],
                },
            )),
        },
    );
    assert_golden(
        "resource_cleanup_request",
        v1::Frame {
            payload: Some(v1::frame::Payload::ResourceCleanupRequest(
                v1::ResourceCleanupRequest {
                    request_id: "request".to_owned(),
                    operation_id: "operation".to_owned(),
                    page_digest: vec![1; 32],
                    plan_digest: vec![2; 32],
                    finalize_proof_digest: vec![3; 32],
                    authorization_digest: vec![4; 32],
                    deadline_unix_ms: 123,
                    platform: "linux".to_owned(),
                    resources: vec![v1::ResourceCleanupResource {
                        resource_id: "resource".to_owned(),
                        root_handle: "root-0".to_owned(),
                        relative_path: "target".to_owned(),
                        quarantine_name: ".bigbud-cleanup-target".to_owned(),
                        identity: Some(identity(v1::ResourceCleanupEntryType::File)),
                        root_identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
                        parent_identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
                        action: v1::ResourceCleanupAction::Delete as i32,
                    }],
                },
            )),
        },
    );
    assert_golden(
        "resource_cleanup_response",
        v1::Frame {
            payload: Some(v1::frame::Payload::ResourceCleanupResponse(
                v1::ResourceCleanupResponse {
                    request_id: "request".to_owned(),
                    operation_id: "operation".to_owned(),
                    results: (1..=11)
                        .map(|outcome| v1::ResourceCleanupResult {
                            resource_id: outcome.to_string(),
                            outcome,
                            error_code: String::new(),
                        })
                        .collect(),
                },
            )),
        },
    );
}
