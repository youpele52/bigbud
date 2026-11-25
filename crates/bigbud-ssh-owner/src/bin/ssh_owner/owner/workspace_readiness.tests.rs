use super::*;
use crate::{
    owner::{self, Operation, Outcome, Owner, OwnerStartup, Pipe},
    owner_pipe::encode_payload,
    v1::{
        Empty, ErrorCode, Hello, ProofStorageResult, ProofStorageSnapshot, ProofWorkspaceReadiness,
        ProofWorkspaceReadinessResult, Reply, Request, frame::Payload,
    },
};
use bigbud_ssh_owner::framing::Endpoint;
use prost::Message;
use std::{fs, os::unix::fs::DirBuilderExt, path::PathBuf};

const TARGET: &str = "readiness-fixture";

#[cfg(target_os = "macos")]
const PREFIX: &str = "/private/tmp/bigbud-picker-sshd-";
#[cfg(target_os = "linux")]
const PREFIX: &str = "/tmp/bigbud-picker-linux-";

fn config(root: &Path) -> TransportConfig {
    TransportConfig {
        ssh: "/test-no-ssh".into(),
        keyscan: "/test-no-keyscan".into(),
        host: Ipv4Addr::LOCALHOST.into(),
        port: 22222,
        user: "picker".into(),
        identity: root.join("identity"),
        known_hosts: root.join("known_hosts"),
        alias_config: None,
        system_config: None,
        workspace_root: Some(root.join("home/picker's folders; literal")),
        dev_interactive_terminal: cfg!(target_os = "macos"),
    }
}

#[test]
fn generic_workspace_and_wrong_startup_bindings_are_not_readiness_authority() {
    let root = PathBuf::from(format!("{PREFIX}readiness"));
    let lock = root.join("owner.lock");
    let mut config = config(&root);
    assert!(matches_fixture(&config, &lock));
    assert!(!matches_fixture(&config, &root.join("another.lock")));
    config.workspace_root = Some(root.join("workspace"));
    assert!(!matches_fixture(&config, &lock));
    config.workspace_root = None;
    assert!(!matches_fixture(&config, &lock));
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(format!("{PREFIX}readiness{}", std::process::id()));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }

    fn owner(&self, disconnected: bool, lock: &Path) -> Owner {
        let mut config = config(&self.0);
        config.identity = crate::transport::write_identity_fixture(&self.0);
        let initial = frames([
            Payload::Hello(Hello {
                major: 1,
                profile_binding: vec![1],
                ..Hello::default()
            }),
            Payload::ProofStorageSnapshot(ProofStorageSnapshot {
                target_id: TARGET.into(),
                writer_epoch: "writer".into(),
                seq: 1,
                disconnected,
                error: 0,
            }),
        ]);
        owner::bootstrap(
            &mut Pipe::new(initial.as_slice(), Vec::new()),
            OwnerStartup {
                profile: &[1],
                startup: crate::owner::TargetStartup::Pinned {
                    target: TARGET.into(),
                    config,
                },
                route_facts: Default::default(),
                profile_lock_path: lock,
                posix_picker: None,
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                workspace_snapshot_cancel: None,
                attach_path: None,
                agent_fixture: None,
                identity_agent_path: None,
                stage: None,
                #[cfg(target_os = "linux")]
                tracked_push: None,
                #[cfg(target_os = "linux")]
                opencode_recipe: None,
                #[cfg(target_os = "linux")]
                opencode_service: None,
            },
        )
        .unwrap()
        .0
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn frames(payloads: impl IntoIterator<Item = Payload>) -> Vec<u8> {
    let mut input = Vec::new();
    for payload in payloads {
        Endpoint::Client
            .write_frame(&mut input, &encode_payload(payload))
            .unwrap();
    }
    input
}

fn readiness(root: &str) -> Operation {
    Operation::ProofWorkspaceReadiness(ProofWorkspaceReadiness {
        workspace_root: root.into(),
    })
}

fn request(owner: &Owner, id: u8, operation: Operation) -> Request {
    Request {
        request_id: vec![id],
        target_id: TARGET.into(),
        owner_epoch: owner.epoch.to_vec(),
        target_generation: owner.generation.to_vec(),
        operation: Some(operation),
        ..Request::default()
    }
}

fn grant(owner: &mut Owner, request: &mut Request) {
    let reply = owner.issue(request.clone());
    assert_eq!(reply.error, i32::from(ErrorCode::Unspecified));
    request.grant = reply.grant;
}

fn assert_error(owner: &mut Owner, request: Request, code: ErrorCode) {
    let reply = owner
        .request(&mut Pipe::new(&[][..], Vec::new()), request)
        .unwrap();
    assert!(
        matches!(reply.outcome, Some(Outcome::Error(error)) if error.code == i32::from(code)),
        "{reply:?}"
    );
}

#[test]
fn owner_requires_fixture_grant_exact_scope_and_durable_connection() {
    let fixture = Fixture::new();
    let lock = fixture.0.join("owner.lock");
    let workspace = fixture.0.join("home/picker's folders; literal");
    let root = workspace.to_str().unwrap();
    let mut denied = fixture.owner(false, &fixture.0.join("wrong.lock"));
    let unqualified = request(&denied, 1, readiness(root));
    assert_eq!(
        denied.issue(unqualified).error,
        i32::from(ErrorCode::OperationDenied)
    );
    drop(denied);

    let mut owner = fixture.owner(false, &lock);
    let exact = request(&owner, 1, readiness(root));
    assert_error(&mut owner, exact, ErrorCode::OperationDenied);
    let mut unbound = request(&owner, 2, readiness(&format!("{root}/child")));
    grant(&mut owner, &mut unbound);
    let mut substituted = unbound.clone();
    substituted.operation = Some(readiness(root));
    assert_error(&mut owner, substituted, ErrorCode::OperationDenied);
    assert_error(&mut owner, unbound, ErrorCode::WorkspacePathDenied);
    #[cfg(target_os = "macos")]
    {
        let mut exact = request(&owner, 3, readiness(root));
        grant(&mut owner, &mut exact);
        assert_error(&mut owner, exact, ErrorCode::TrustRequired);
    }

    let mut pending = request(&owner, 4, readiness(root));
    grant(&mut owner, &mut pending);
    let mut disconnect = request(&owner, 5, Operation::Disconnect(Empty {}));
    grant(&mut owner, &mut disconnect);
    let ack = frames([Payload::ProofStorageResult(ProofStorageResult {
        request_id: disconnect.request_id.clone(),
        seq: 2,
        committed: true,
        error: 0,
    })]);
    let reply = owner
        .request(&mut Pipe::new(ack.as_slice(), Vec::new()), disconnect)
        .unwrap();
    assert!(matches!(reply.outcome, Some(Outcome::Connection(_))));
    assert_error(&mut owner, pending, ErrorCode::StaleGeneration);
    let mut disconnected = request(&owner, 6, readiness(root));
    grant(&mut owner, &mut disconnected);
    assert_error(&mut owner, disconnected, ErrorCode::TargetDisconnected);

    drop(owner);
    let mut restarted = fixture.owner(true, &lock);
    let mut disconnected = request(&restarted, 1, readiness(root));
    grant(&mut restarted, &mut disconnected);
    assert_error(&mut restarted, disconnected, ErrorCode::TargetDisconnected);
}

#[test]
fn wire_tags_and_nested_fields_match_v1_contract() {
    let request = Request {
        operation: Some(readiness("/scope")),
        ..Request::default()
    };
    assert_eq!(request.encode_to_vec(), b"\xb2\x03\x08\x0a\x06/scope");
    let reply = Reply {
        outcome: Some(Outcome::ProofWorkspaceReadiness(
            ProofWorkspaceReadinessResult {
                os: "linux".into(),
                architecture: "x86_64".into(),
            },
        )),
        ..Reply::default()
    };
    assert_eq!(
        reply.encode_to_vec(),
        b"\x9a\x02\x0f\x0a\x05linux\x12\x06x86_64"
    );
}
