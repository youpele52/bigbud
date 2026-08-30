use std::fs;
use std::io::Cursor;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{PlatformExecutor, admit_cleanup_request, handle_cleanup_request, run};
use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1, write_frame,
};

#[cfg(unix)]
fn identity(path: &std::path::Path) -> v1::ResourceCleanupIdentity {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path).expect("metadata");
    v1::ResourceCleanupIdentity {
        device_or_volume: metadata.dev().to_string(),
        inode_or_file_id: metadata.ino().to_string(),
        entry_type: if metadata.is_dir() {
            v1::ResourceCleanupEntryType::Directory as i32
        } else {
            v1::ResourceCleanupEntryType::File as i32
        },
    }
}

#[cfg(windows)]
fn identity(path: &std::path::Path) -> v1::ResourceCleanupIdentity {
    use super::super::windows::{identity as windows_identity, open_verified};

    windows_identity(&open_verified(path).expect("open")).expect("identity")
}

#[test]
fn executes_cleanup_only_after_hello_and_root_bootstrap() {
    let _guard = super::super::CANCELLATION_TEST_LOCK
        .lock()
        .expect("cancellation lock");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("bigbud-session-{}-{nonce}", std::process::id()));
    fs::create_dir(&root).expect("root");
    let target = root.join("target");
    fs::write(&target, b"content").expect("target");
    let root_identity = identity(&root);
    let target_identity = identity(&target);
    let mut cleanup_request = v1::ResourceCleanupRequest {
        request_id: "cleanup".to_owned(),
        operation_id: "operation".to_owned(),
        page_digest: Vec::new(),
        plan_digest: vec![2; 32],
        finalize_proof_digest: vec![3; 32],
        authorization_digest: Vec::new(),
        deadline_unix_ms: u64::MAX,
        platform: std::env::consts::OS.to_owned(),
        resources: vec![v1::ResourceCleanupResource {
            resource_id: "resource".to_owned(),
            root_handle: "root-0".to_owned(),
            relative_path: "target".to_owned(),
            quarantine_name: ".bigbud-cleanup-target".to_owned(),
            identity: Some(target_identity),
            root_identity: Some(root_identity.clone()),
            parent_identity: Some(root_identity.clone()),
            action: v1::ResourceCleanupAction::Delete as i32,
        }],
    };
    cleanup_request.page_digest =
        super::super::contract::page_digest(&cleanup_request.resources).to_vec();
    cleanup_request.authorization_digest =
        super::super::contract::authorization_digest(&cleanup_request).to_vec();
    let cleanup = v1::Frame {
        payload: Some(v1::frame::Payload::ResourceCleanupRequest(cleanup_request)),
    };
    let mut conflicting_cleanup = cleanup.clone();
    let Some(v1::frame::Payload::ResourceCleanupRequest(request)) =
        conflicting_cleanup.payload.as_mut()
    else {
        panic!("expected cleanup request");
    };
    request.operation_id = "conflict".to_owned();
    let mut digest_conflict = cleanup.clone();
    let Some(v1::frame::Payload::ResourceCleanupRequest(request)) =
        digest_conflict.payload.as_mut()
    else {
        panic!("expected cleanup request");
    };
    request.request_id = "other-request".to_owned();
    request.plan_digest = vec![9; 32];
    let frames = [
        v1::Frame {
            payload: Some(v1::frame::Payload::ClientHello(v1::ClientHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                client_instance_id: "client".to_owned(),
                connection_id: "connection".to_owned(),
                server_nonce: "nonce".to_owned(),
                max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
            })),
        },
        v1::Frame {
            payload: Some(v1::frame::Payload::ResourceCleanupRootBootstrapRequest(
                v1::ResourceCleanupRootBootstrapRequest {
                    request_id: "bootstrap".to_owned(),
                    platform: std::env::consts::OS.to_owned(),
                    roots: vec![v1::ResourceCleanupRoot {
                        root_id: "root".to_owned(),
                        path: root.to_string_lossy().into_owned(),
                        identity: Some(root_identity.clone()),
                    }],
                },
            )),
        },
        v1::Frame {
            payload: Some(v1::frame::Payload::DiagnosticRequest(
                v1::DiagnosticRequest {
                    request_id: "wrong-mode".to_owned(),
                    operation_id: "wrong-mode".to_owned(),
                    request_digest: vec![0; 32],
                    workspace_handle: "workspace".to_owned(),
                    deadline_unix_ms: u64::MAX,
                    kind: "diagnostic".to_owned(),
                },
            )),
        },
        v1::Frame {
            payload: Some(v1::frame::Payload::ResourceCleanupKeepAliveRequest(
                v1::ResourceCleanupKeepAliveRequest {
                    request_id: "keep-alive".to_owned(),
                },
            )),
        },
        cleanup.clone(),
        cleanup,
        conflicting_cleanup,
        digest_conflict,
    ];
    let mut input = Vec::new();
    for frame in frames {
        write_frame(&mut input, &frame, DEFAULT_MAX_FRAME_BYTES).expect("encode");
    }
    let mut output = Vec::new();
    run(Cursor::new(input), &mut output, None).expect("session");

    let mut output = Cursor::new(output);
    let responses = (0..8)
        .map(|_| {
            read_frame(&mut output, DEFAULT_MAX_FRAME_BYTES)
                .expect("decode")
                .expect("frame")
        })
        .collect::<Vec<_>>();
    let Some(v1::frame::Payload::ResourceCleanupKeepAliveResponse(keep_alive)) =
        &responses[3].payload
    else {
        panic!("expected keep-alive response");
    };
    assert_eq!(keep_alive.request_id, "keep-alive");
    let Some(v1::frame::Payload::ProtocolError(wrong_mode)) = &responses[2].payload else {
        panic!("expected wrong-mode protocol error");
    };
    assert_eq!(wrong_mode.code, "UNEXPECTED_MESSAGE");
    let Some(v1::frame::Payload::ResourceCleanupResponse(response)) = &responses[4].payload else {
        panic!("expected cleanup response");
    };
    assert_eq!(
        response.results[0].outcome,
        v1::ResourceCleanupOutcome::Removed as i32
    );
    assert_eq!(responses[4], responses[5]);
    let Some(v1::frame::Payload::ProtocolError(conflict)) = &responses[6].payload else {
        panic!("expected request identity conflict");
    };
    assert_eq!(conflict.code, "REQUEST_ID_CONFLICT");
    let Some(v1::frame::Payload::ProtocolError(digest_conflict)) = &responses[7].payload else {
        panic!("expected operation digest conflict");
    };
    assert_eq!(digest_conflict.code, "OPERATION_DIGEST_CONFLICT");
    assert!(!target.exists());
    fs::remove_dir(root).expect("cleanup");
}

#[test]
fn acknowledged_cancellation_before_the_handler_is_not_reset() {
    let _guard = super::super::CANCELLATION_TEST_LOCK
        .lock()
        .expect("cancellation lock");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "bigbud-session-cancel-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&root).expect("root");
    let target = root.join("target");
    fs::write(&target, b"retain").expect("target");
    let root_identity = identity(&root);
    let mut executor = PlatformExecutor::new();
    let handles = executor
        .bootstrap(vec![v1::ResourceCleanupRoot {
            root_id: "root".to_owned(),
            path: root.to_string_lossy().into_owned(),
            identity: Some(root_identity.clone()),
        }])
        .expect("bootstrap");
    let mut request = v1::ResourceCleanupRequest {
        request_id: "cancel-request".to_owned(),
        operation_id: "cancel-operation".to_owned(),
        page_digest: Vec::new(),
        plan_digest: vec![2; 32],
        finalize_proof_digest: vec![3; 32],
        authorization_digest: Vec::new(),
        deadline_unix_ms: u64::MAX,
        platform: std::env::consts::OS.to_owned(),
        resources: vec![v1::ResourceCleanupResource {
            resource_id: "resource".to_owned(),
            root_handle: handles[0].root_handle.clone(),
            relative_path: "target".to_owned(),
            quarantine_name: ".bigbud-cleanup-target".to_owned(),
            identity: Some(identity(&target)),
            root_identity: Some(root_identity.clone()),
            parent_identity: Some(root_identity),
            action: v1::ResourceCleanupAction::Delete as i32,
        }],
    };
    request.page_digest = super::super::contract::page_digest(&request.resources).to_vec();
    request.authorization_digest = super::super::contract::authorization_digest(&request).to_vec();
    let mut accepted = std::collections::VecDeque::new();
    admit_cleanup_request(&request, &executor, &accepted).expect("admitted");
    super::super::reset_cancellation();
    super::super::request_cancellation();
    let response = handle_cleanup_request(request, &mut executor, &mut accepted);
    let Some(v1::frame::Payload::ResourceCleanupResponse(response)) = response.payload else {
        panic!("expected cleanup response");
    };
    assert_eq!(
        response.results[0].outcome,
        v1::ResourceCleanupOutcome::ProcessFailure as i32
    );
    assert!(target.exists());
    super::super::reset_cancellation();
    fs::remove_file(target).expect("target cleanup");
    fs::remove_dir(root).expect("root cleanup");
}
