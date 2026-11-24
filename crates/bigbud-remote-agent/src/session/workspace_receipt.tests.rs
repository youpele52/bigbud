use std::fs;

use super::test_helpers::hello;
use super::*;
use crate::workspace::content_sha256;

struct Fixture {
    session: AgentSession,
    root: std::path::PathBuf,
}

impl Fixture {
    fn open() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-agent-write-receipt-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut session = AgentSession::new().unwrap();
        session.handle(hello()).unwrap();
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
        Self { session, root }
    }

    fn write(&mut self, operation_id: &str, bytes: &[u8], expected: &str) -> v1::WriteFileResponse {
        let response = self
            .session
            .handle(v1::Frame {
                payload: Some(v1::frame::Payload::WriteFileRequest(v1::WriteFileRequest {
                    request_id: format!("write-{operation_id}"),
                    operation_id: operation_id.to_owned(),
                    request_digest: vec![7],
                    workspace_handle: "workspace-1".to_owned(),
                    path: "file.txt".to_owned(),
                    bytes: bytes.to_vec(),
                    expected_sha256: expected.to_owned(),
                    create_only: false,
                })),
            })
            .unwrap();
        let Some(v1::frame::Payload::WriteFileResponse(response)) = response.payload else {
            panic!("expected write response");
        };
        response
    }

    fn receipt(&mut self, operation_id: &str, request_digest: Vec<u8>) -> v1::WriteReceiptResponse {
        let response = self
            .session
            .handle(v1::Frame {
                payload: Some(v1::frame::Payload::WriteReceiptRequest(
                    v1::WriteReceiptRequest {
                        request_id: format!("receipt-{operation_id}"),
                        operation_id: operation_id.to_owned(),
                        request_digest,
                    },
                )),
            })
            .unwrap();
        let Some(v1::frame::Payload::WriteReceiptResponse(response)) = response.payload else {
            panic!("expected write receipt response");
        };
        assert_eq!(response.request_id, format!("receipt-{operation_id}"));
        assert_eq!(response.operation_id, operation_id);
        response
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn write_receipt_reports_an_applied_write_with_its_result_hash() {
    let mut fixture = Fixture::open();
    assert_eq!(fixture.write("op-applied", b"saved", "").error_code, "");
    // An external change afterwards does not alter what this operation wrote.
    fs::write(fixture.root.join("file.txt"), b"external").unwrap();

    let receipt = fixture.receipt("op-applied", vec![7]);
    assert!(receipt.applied);
    assert_eq!(receipt.result_sha256, content_sha256(b"saved"));
    assert_eq!(receipt.error_code, "");
    // The query never rewrites the file.
    assert_eq!(
        fs::read(fixture.root.join("file.txt")).unwrap(),
        b"external"
    );
}

#[test]
fn write_receipt_is_not_applied_for_an_unknown_operation() {
    let mut fixture = Fixture::open();
    let receipt = fixture.receipt("op-unknown", vec![7]);
    assert!(!receipt.applied);
    assert_eq!(receipt.result_sha256, "");
    assert_eq!(receipt.error_code, "");
    assert!(!fixture.root.join("file.txt").exists());
}

#[test]
fn write_receipt_is_not_applied_after_a_failed_write() {
    let mut fixture = Fixture::open();
    let failed = fixture.write("op-conflict", b"mine", &content_sha256(b"missing-base"));
    assert_ne!(failed.error_code, "");

    let receipt = fixture.receipt("op-conflict", vec![7]);
    assert!(!receipt.applied);
    assert_eq!(receipt.result_sha256, "");
    assert_eq!(receipt.error_code, "");
}

#[test]
fn write_receipt_is_not_applied_for_an_accepted_operation_without_a_write() {
    let mut fixture = Fixture::open();
    fixture
        .session
        .accept_operation("op-pending", vec![7])
        .unwrap();
    let receipt = fixture.receipt("op-pending", vec![7]);
    assert!(!receipt.applied);
    assert_eq!(receipt.error_code, "");
}

#[test]
fn write_receipt_with_a_different_digest_is_an_operation_id_conflict() {
    let mut fixture = Fixture::open();
    assert_eq!(fixture.write("op-digest", b"saved", "").error_code, "");

    let receipt = fixture.receipt("op-digest", vec![8]);
    assert!(!receipt.applied);
    assert_eq!(receipt.result_sha256, "");
    assert_eq!(receipt.error_code, "OPERATION_ID_CONFLICT");
}
