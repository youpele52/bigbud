use std::fs;

use super::test_helpers::hello;
use super::*;

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
        let response = self
            .session
            .handle(v1::Frame {
                payload: Some(v1::frame::Payload::WriteFileRequest(v1::WriteFileRequest {
                    request_id: format!("write-{}", self.next),
                    operation_id: format!("write-operation-{}", self.next),
                    request_digest: vec![self.next as u8],
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
