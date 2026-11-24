use std::fs;

use super::test_helpers::hello;
use super::*;

struct Fixture {
    session: AgentSession,
    root: std::path::PathBuf,
}

impl Fixture {
    fn open() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-agent-entries-session-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.txt"), "a").unwrap();
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

    fn mkdir(&mut self, operation: &str, digest: u8, path: &str) -> v1::CreateDirectoryResponse {
        let response = self
            .session
            .handle(v1::Frame {
                payload: Some(v1::frame::Payload::CreateDirectoryRequest(
                    v1::CreateDirectoryRequest {
                        request_id: format!("request-{operation}"),
                        operation_id: operation.to_owned(),
                        request_digest: vec![digest],
                        workspace_handle: "workspace-1".to_owned(),
                        path: path.to_owned(),
                    },
                )),
            })
            .unwrap();
        let Some(v1::frame::Payload::CreateDirectoryResponse(response)) = response.payload else {
            panic!("expected create directory response");
        };
        response
    }

    fn delete(&mut self, operation: &str, path: &str, kind: &str) -> v1::DeleteEntryResponse {
        let response = self
            .session
            .handle(v1::Frame {
                payload: Some(v1::frame::Payload::DeleteEntryRequest(
                    v1::DeleteEntryRequest {
                        request_id: format!("request-{operation}"),
                        operation_id: operation.to_owned(),
                        request_digest: vec![7],
                        workspace_handle: "workspace-1".to_owned(),
                        path: path.to_owned(),
                        expected_kind: kind.to_owned(),
                    },
                )),
            })
            .unwrap();
        let Some(v1::frame::Payload::DeleteEntryResponse(response)) = response.payload else {
            panic!("expected delete entry response");
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
fn advertises_mkdir_and_delete() {
    let mut session = AgentSession::new().unwrap();
    let Some(v1::frame::Payload::AgentHello(agent)) = session.handle(hello()).unwrap().payload
    else {
        panic!("expected agent hello");
    };
    for name in ["workspace.mkdir", "workspace.delete"] {
        assert!(
            agent
                .capabilities
                .iter()
                .any(|capability| capability.name == name && capability.major == 1),
            "{name}"
        );
    }
}

#[test]
fn creates_a_folder_once_and_answers_a_duplicate_without_acting() {
    let mut fixture = Fixture::open();
    let created = fixture.mkdir("mkdir-1", 1, "src/new");
    assert!(created.terminal);
    assert_eq!(created.error_code, "");
    assert!(fixture.root.join("src/new").is_dir());

    // Same identity and digest: reported as done, not re-run (a re-run would be ALREADY_EXISTS).
    let duplicate = fixture.mkdir("mkdir-1", 1, "src/new");
    assert_eq!(duplicate.error_code, "");
    // A different digest for the same identity is a protocol conflict.
    assert!(
        fixture
            .session
            .handle(v1::Frame {
                payload: Some(v1::frame::Payload::CreateDirectoryRequest(
                    v1::CreateDirectoryRequest {
                        request_id: "conflict".to_owned(),
                        operation_id: "mkdir-1".to_owned(),
                        request_digest: vec![2],
                        workspace_handle: "workspace-1".to_owned(),
                        path: "src/other".to_owned(),
                    },
                )),
            })
            .is_err()
    );

    let existing = fixture.mkdir("mkdir-2", 3, "src/new");
    assert_eq!(existing.error_code, "ALREADY_EXISTS");
    // A failed identity is forgotten, so a retry runs (and fails the same way) instead of lying.
    assert_eq!(
        fixture.mkdir("mkdir-2", 3, "src/new").error_code,
        "ALREADY_EXISTS"
    );
}

#[test]
fn deletes_entries_and_reports_their_kind() {
    let mut fixture = Fixture::open();
    let refused = fixture.delete("delete-0", "src", "file");
    assert_eq!(refused.error_code, "KIND_MISMATCH");
    assert!(fixture.root.join("src/a.txt").is_file());

    let deleted = fixture.delete("delete-1", "src", "directory");
    assert_eq!(deleted.error_code, "");
    assert_eq!(deleted.deleted_kind, "directory");
    assert!(!fixture.root.join("src").exists());

    assert_eq!(
        fixture.delete("delete-1", "src", "directory").error_code,
        ""
    );
    assert_eq!(
        fixture.delete("delete-2", "src", "directory").error_code,
        "NOT_FOUND"
    );
    assert_eq!(
        fixture.delete("delete-3", "", "directory").error_code,
        "ROOT_ENTRY"
    );
    assert_eq!(
        fixture.delete("delete-4", "../x", "file").error_code,
        "INVALID_PATH"
    );
    assert_eq!(
        fixture.delete("delete-5", "x", "symlink").error_code,
        "INVALID_PATH"
    );
    assert!(fixture.root.is_dir());
}

#[test]
fn an_unknown_workspace_does_not_leave_the_operation_accepted() {
    let mut fixture = Fixture::open();
    let request = |handle: &str| v1::Frame {
        payload: Some(v1::frame::Payload::DeleteEntryRequest(
            v1::DeleteEntryRequest {
                request_id: "r".to_owned(),
                operation_id: "delete-unknown".to_owned(),
                request_digest: vec![1],
                workspace_handle: handle.to_owned(),
                path: "src".to_owned(),
                expected_kind: "directory".to_owned(),
            },
        )),
    };
    assert!(fixture.session.handle(request("missing")).is_err());
    let response = fixture.session.handle(request("workspace-1")).unwrap();
    let Some(v1::frame::Payload::DeleteEntryResponse(response)) = response.payload else {
        panic!("expected delete entry response");
    };
    assert_eq!(response.error_code, "");
    assert!(!fixture.root.join("src").exists());
}
