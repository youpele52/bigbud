use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

#[cfg(unix)]
#[test]
fn duplicate_pty_create_reuses_the_existing_process() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("bigbud-agent-pty-create-{suffix}"));
    fs::create_dir_all(&root).unwrap();
    let mut session = AgentSession::new().unwrap();
    session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::ClientHello(v1::ClientHello {
                protocol_major: PROTOCOL_MAJOR,
                protocol_minor: PROTOCOL_MINOR,
                client_instance_id: "client-1".to_owned(),
                connection_id: "connection-1".to_owned(),
                server_nonce: "nonce".to_owned(),
                max_frame_bytes: 1024,
            })),
        })
        .unwrap();
    session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::WorkspaceOpenRequest(
                v1::WorkspaceOpenRequest {
                    request_id: "open-1".to_owned(),
                    workspace_handle: "workspace-1".to_owned(),
                    root: root.to_string_lossy().into_owned(),
                },
            )),
        })
        .unwrap();
    let request = v1::PtyCreateRequest {
        request_id: "create-1".to_owned(),
        pty_id: "pty-1".to_owned(),
        request_digest: vec![1],
        workspace_handle: "workspace-1".to_owned(),
        cwd: String::new(),
        shell: "sh".to_owned(),
        args: vec!["-c".to_owned(), "exit 0".to_owned()],
        cols: 80,
        rows: 24,
        environment: Vec::new(),
    };
    let (_, job) = session.prepare_pty_create(request.clone()).unwrap();
    let job = job.unwrap();
    let (duplicate, duplicate_job) = session.prepare_pty_create(request.clone()).unwrap();
    assert!(duplicate_job.is_none());
    assert!(matches!(
        duplicate.payload,
        Some(v1::frame::Payload::PtyCreateResponse(response)) if response.pid == job.handle.pid as u64
    ));
    let mut conflicting = request;
    conflicting.request_digest = vec![2];
    assert!(matches!(
        session.prepare_pty_create(conflicting),
        Err(SessionError::OperationIdConflict)
    ));

    let _ = pty::read_events(job.reader, job.handle.pid);
    let _ = fs::remove_dir_all(root);
}
