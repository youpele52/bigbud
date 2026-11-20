use sha2::{Digest, Sha256};

use super::*;

const SCOPE: &str = "0123456789abcdef0123456789abcdef";
const UPLOAD: &str = "0123456789abcdef";

fn hello_capabilities(session: &mut AgentSession) -> Vec<String> {
    match session
        .handle(test_helpers::hello())
        .expect("hello")
        .payload
    {
        Some(v1::frame::Payload::AgentHello(hello)) => hello
            .capabilities
            .into_iter()
            .map(|capability| capability.name)
            .collect(),
        _ => panic!("expected agent hello"),
    }
}

fn send(session: &mut AgentSession, payload: v1::frame::Payload) -> v1::frame::Payload {
    session
        .handle(v1::Frame {
            payload: Some(payload),
        })
        .expect("paste frame")
        .payload
        .expect("response payload")
}

#[test]
fn capability_is_advertised_only_with_a_paste_folder() {
    let mut without = AgentSession::with_epoch("epoch");
    assert!(!hello_capabilities(&mut without).contains(&"terminal.paste-staging".to_owned()));
    let root = std::env::temp_dir().join(format!("bigbud-paste-session-{}", std::process::id()));
    let mut with = AgentSession::with_epoch("epoch");
    with.enable_paste_staging(root.join("paste"))
        .expect("paste folder");
    assert!(hello_capabilities(&mut with).contains(&"terminal.paste-staging".to_owned()));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn stages_over_frames_and_returns_an_absolute_path() {
    let root = std::env::temp_dir().join(format!("bigbud-paste-frames-{}", std::process::id()));
    let mut session = AgentSession::with_epoch("epoch");
    session
        .enable_paste_staging(root.join("paste"))
        .expect("paste folder");
    let _ = hello_capabilities(&mut session);
    let bytes = b"%PDF-1.7 example";
    let begin = send(
        &mut session,
        v1::frame::Payload::PasteStageBeginRequest(v1::PasteStageBeginRequest {
            request_id: "b".to_owned(),
            scope: SCOPE.to_owned(),
            upload_id: UPLOAD.to_owned(),
            total_bytes: bytes.len() as u64,
            extension: "pdf".to_owned(),
            image_mime_type: String::new(),
        }),
    );
    assert!(matches!(begin, v1::frame::Payload::PasteStageBeginResponse(ref r) if r.accepted));
    let chunk = send(
        &mut session,
        v1::frame::Payload::PasteStageChunkRequest(v1::PasteStageChunkRequest {
            request_id: "c".to_owned(),
            upload_id: UPLOAD.to_owned(),
            offset: 0,
            data: bytes.to_vec(),
        }),
    );
    assert!(
        matches!(chunk, v1::frame::Payload::PasteStageChunkResponse(ref r) if r.received_bytes == bytes.len() as u64)
    );
    let commit = send(
        &mut session,
        v1::frame::Payload::PasteStageCommitRequest(v1::PasteStageCommitRequest {
            request_id: "m".to_owned(),
            upload_id: UPLOAD.to_owned(),
            sha256: Sha256::digest(bytes).to_vec(),
        }),
    );
    let v1::frame::Payload::PasteStageCommitResponse(committed) = commit else {
        panic!("expected commit response");
    };
    assert_eq!(committed.error_code, "");
    assert_eq!(
        committed.clipboard, "skipped",
        "non-images never touch the clipboard"
    );
    let path = std::path::PathBuf::from(&committed.path);
    assert!(path.is_absolute() && path.ends_with(path.file_name().unwrap()));
    assert!(!committed.path.contains('~'));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let discard = send(
        &mut session,
        v1::frame::Payload::PasteStageDiscardRequest(v1::PasteStageDiscardRequest {
            request_id: "d".to_owned(),
            scope: SCOPE.to_owned(),
            upload_id: String::new(),
        }),
    );
    assert!(
        matches!(discard, v1::frame::Payload::PasteStageDiscardResponse(ref r) if r.removed == 1)
    );
    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn reports_unavailable_without_a_paste_folder() {
    let mut session = AgentSession::with_epoch("epoch");
    let _ = hello_capabilities(&mut session);
    let response = send(
        &mut session,
        v1::frame::Payload::PasteStageBeginRequest(v1::PasteStageBeginRequest {
            request_id: "b".to_owned(),
            scope: SCOPE.to_owned(),
            upload_id: UPLOAD.to_owned(),
            total_bytes: 1,
            extension: "png".to_owned(),
            image_mime_type: "image/png".to_owned(),
        }),
    );
    assert!(
        matches!(response, v1::frame::Payload::PasteStageBeginResponse(ref r) if !r.accepted && r.error_code == "UNAVAILABLE")
    );
}
