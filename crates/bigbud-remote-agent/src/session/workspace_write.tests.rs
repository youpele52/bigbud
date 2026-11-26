use std::fs;

use super::test_helpers::hello;
use super::*;
use crate::workspace::content_sha256;

struct Fixture {
    session: AgentSession,
    root: std::path::PathBuf,
    next: u32,
}

impl Fixture {
    fn open() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-agent-create-only-{}-{}",
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
        Self {
            session,
            root,
            next: 0,
        }
    }

    fn write(
        &mut self,
        bytes: &[u8],
        expected_sha256: &str,
        create_only: bool,
    ) -> v1::WriteFileResponse {
        self.next += 1;
        let operation = self.next;
        self.send(operation, bytes, expected_sha256, create_only)
    }

    fn send(
        &mut self,
        operation: u32,
        bytes: &[u8],
        expected_sha256: &str,
        create_only: bool,
    ) -> v1::WriteFileResponse {
        let response = self
            .session
            .handle(v1::Frame {
                payload: Some(v1::frame::Payload::WriteFileRequest(v1::WriteFileRequest {
                    request_id: format!("write-{operation}"),
                    operation_id: format!("write-operation-{operation}"),
                    request_digest: vec![operation as u8],
                    workspace_handle: "workspace-1".to_owned(),
                    path: "config/hooks.json".to_owned(),
                    bytes: bytes.to_vec(),
                    expected_sha256: expected_sha256.to_owned(),
                    create_only,
                })),
            })
            .unwrap();
        let Some(v1::frame::Payload::WriteFileResponse(response)) = response.payload else {
            panic!("expected write response");
        };
        response
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn advertises_create_only_writes() {
    let mut session = AgentSession::new().unwrap();
    let Some(v1::frame::Payload::AgentHello(agent)) = session.handle(hello()).unwrap().payload
    else {
        panic!("expected agent hello");
    };
    assert!(agent.capabilities.iter().any(|capability| capability.name
        == "workspace.write-create-only"
        && capability.major == 1));
}

#[test]
fn create_only_writes_create_once_and_report_already_exists() {
    let mut fixture = Fixture::open();
    let created = fixture.write(b"{}", "", true);
    assert!(created.terminal);
    assert_eq!(created.error_code, "");
    assert_eq!(created.written_bytes, 2);

    let refused = fixture.write(b"replaced", "", true);
    assert!(refused.terminal);
    assert_eq!(refused.error_code, "ALREADY_EXISTS");
    assert_eq!(
        fs::read(fixture.root.join("config/hooks.json")).unwrap(),
        b"{}"
    );

    let conditional = fixture.write(b"x", &"0".repeat(64), true);
    assert_eq!(conditional.error_code, "INVALID_ARGUMENT");
    assert_eq!(
        fs::read(fixture.root.join("config/hooks.json")).unwrap(),
        b"{}"
    );
}

#[test]
fn advertises_write_result_hashes_and_receipts_as_workspace_write_minor_two() {
    let mut session = AgentSession::new().unwrap();
    let Some(v1::frame::Payload::AgentHello(agent)) = session.handle(hello()).unwrap().payload
    else {
        panic!("expected agent hello");
    };
    let write = agent
        .capabilities
        .iter()
        .find(|capability| capability.name == "workspace.write")
        .unwrap();
    assert_eq!((write.major, write.minor), (1, 2));
    let create_only = agent
        .capabilities
        .iter()
        .find(|capability| capability.name == "workspace.write-create-only")
        .unwrap();
    assert_eq!((create_only.major, create_only.minor), (1, 0));
}

#[test]
fn successful_writes_report_the_hash_of_the_written_bytes() {
    let mut fixture = Fixture::open();
    let created = fixture.write(b"{}", "", true);
    assert_eq!(created.error_code, "");
    assert_eq!(created.current_sha256, content_sha256(b"{}"));

    let guarded = fixture.write(b"{\"a\":1}", &content_sha256(b"{}"), false);
    assert_eq!(guarded.error_code, "");
    assert_eq!(guarded.current_sha256, content_sha256(b"{\"a\":1}"));

    let unguarded = fixture.write(b"plain", "", false);
    assert_eq!(unguarded.current_sha256, content_sha256(b"plain"));

    // A duplicate of an accepted operation reports the same result hash without rewriting.
    fs::write(fixture.root.join("config/hooks.json"), b"external").unwrap();
    let operation = fixture.next;
    let duplicate = fixture.send(operation, b"plain", "", false);
    assert_eq!(duplicate.error_code, "");
    assert_eq!(duplicate.current_sha256, content_sha256(b"plain"));
    assert_eq!(
        fs::read(fixture.root.join("config/hooks.json")).unwrap(),
        b"external"
    );

    let conflict = fixture.write(b"next", &content_sha256(b"plain"), false);
    assert_eq!(conflict.error_code, workspace_conflict_code());
    assert_eq!(conflict.current_sha256, content_sha256(b"external"));
}

#[test]
fn guarded_writes_to_a_missing_file_conflict_without_creating_parents() {
    let mut fixture = Fixture::open();
    let missing = fixture.write(b"x", &content_sha256(b"old"), false);
    assert_eq!(missing.error_code, workspace_conflict_code());
    assert_eq!(missing.current_sha256, "");
    assert!(!fixture.root.join("config").exists());
}

fn workspace_conflict_code() -> &'static str {
    workspace_error_code(&WorkspaceError::WriteConflict {
        expected: String::new(),
        actual: None,
    })
}

#[test]
fn write_lock_verification_and_unknown_outcomes_have_distinct_codes() {
    assert_eq!(
        workspace_error_code(&WorkspaceError::WriteLockTimeout),
        "WRITE_LOCK_TIMEOUT"
    );
    assert_eq!(
        workspace_error_code(&WorkspaceError::WriteVerificationFailed),
        "WRITE_VERIFICATION_FAILED"
    );
    assert_eq!(
        workspace_error_code(&WorkspaceError::UnknownOutcome(Box::new(
            WorkspaceError::WriteVerificationFailed
        ))),
        "UNKNOWN_OUTCOME"
    );
}

#[test]
fn an_unknown_workspace_handle_does_not_make_a_retry_report_success() {
    let mut fixture = Fixture::open();
    let request = |handle: &str| v1::Frame {
        payload: Some(v1::frame::Payload::WriteFileRequest(v1::WriteFileRequest {
            request_id: "write-unknown".to_owned(),
            operation_id: "write-operation-unknown".to_owned(),
            request_digest: vec![42],
            workspace_handle: handle.to_owned(),
            path: "config/hooks.json".to_owned(),
            bytes: b"never written".to_vec(),
            expected_sha256: String::new(),
            create_only: false,
        })),
    };
    assert!(
        fixture
            .session
            .handle(request("missing-workspace"))
            .is_err()
    );
    // The same operation retried must be processed for real, not answered as a duplicate.
    assert!(
        fixture
            .session
            .handle(request("missing-workspace"))
            .is_err()
    );
    assert!(!fixture.root.join("config/hooks.json").exists());
}
