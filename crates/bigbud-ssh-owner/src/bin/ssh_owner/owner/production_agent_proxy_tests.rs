//! Per-target production agent-proxy admission and lane ownership.
//!
//! These run without SSH: admission, generation fences and the provider refusal
//! are exercised at the owner boundary, and lane teardown uses an independent
//! fake-mux proxy per target.

use super::targets::Lanes;
use super::{Owner, OwnerStartup, Pipe, TargetAuthority, TargetStartup, bootstrap};
use crate::owner_agent_proxy::{AgentProxy, ServiceRecipe, test_support::echo_proxy};
use crate::owner_pipe::encode_payload;
use crate::v1::{
    self, ErrorCode, Hello, ProofAgentProxyOpen, ProofTerminalLease, TargetAuthMode,
    TargetDescriptor, TargetKind, frame::Payload, request::Operation,
};
use bigbud_ssh_owner::framing::Endpoint;
use std::{
    fs,
    io::Write,
    net::Ipv4Addr,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
const PIN: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
const TARGET: &str = "ssh:production-a";

struct Fixture {
    root: PathBuf,
    identity: PathBuf,
    known_hosts: PathBuf,
    state: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-production-agent-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let identity = private_file(&root, "identity", b"synthetic identity");
        let known_hosts = private_file(
            &root,
            "known_hosts",
            format!("[127.0.0.1]:22222 {PIN}").as_bytes(),
        );
        let state = root.join("ssh-owner");
        fs::DirBuilder::new().mode(0o700).create(&state).unwrap();
        Self {
            identity,
            known_hosts,
            state,
            root,
        }
    }

    fn owner(&self) -> Owner {
        let hello = encode_payload(Payload::Hello(Hello {
            major: 1,
            minor: 0,
            profile_binding: vec![1],
            ..Hello::default()
        }));
        let mut input = Vec::new();
        Endpoint::Client.write_frame(&mut input, &hello).unwrap();
        crate::owner::reconciliation::pin_test_request_id([9; 32]);
        let reconcile = encode_payload(Payload::ProofReconcileSnapshot(
            crate::v1::ProofReconcileSnapshot {
                request_id: vec![9; 32],
                digest: vec![0; 32],
                error: 0,
                ..crate::v1::ProofReconcileSnapshot::default()
            },
        ));
        Endpoint::Client
            .write_frame(&mut input, &reconcile)
            .unwrap();
        let lock = self.state.join("owner.lock");
        bootstrap(
            &mut Pipe::new(input.as_slice(), Vec::new()),
            OwnerStartup {
                profile: &[1],
                startup: TargetStartup::Unpinned(TargetAuthority::new(
                    "/test-no-ssh".into(),
                    "/test-no-keyscan".into(),
                    None,
                    None,
                    None,
                )),
                route_facts: crate::config::RouteFacts::default().with_production(),
                profile_lock_path: &lock,
                posix_picker: None,
                workspace_snapshot_cancel: None,
                attach_path: None,
                agent_fixture: None,
                agent_service: None,
                identity_agent_path: None,
                stage: None,
                #[cfg(target_os = "linux")]
                tracked_push: None,
                #[cfg(any(target_os = "macos", target_os = "linux"))]
                opencode_v2: None,
            },
        )
        .unwrap()
        .0
    }

    fn bind(&self, owner: &mut Owner) {
        let request = crate::v1::Request {
            request_id: vec![1],
            target_id: TARGET.into(),
            target_descriptor: Some(TargetDescriptor {
                target_id: TARGET.into(),
                kind: TargetKind::Structured as i32,
                host: Ipv4Addr::LOCALHOST.to_string(),
                port: 22222,
                user: "tester".into(),
                auth_mode: TargetAuthMode::Key as i32,
                identity_reference: self.identity.to_str().unwrap().into(),
                host_key_alias: String::new(),
                trust_reference: self.known_hosts.to_str().unwrap().into(),
                generation: Vec::new(),
            }),
            ..crate::v1::Request::default()
        };
        let preview = owner
            .targets
            .resolve(owner.authority.as_ref(), &request, None)
            .unwrap();
        owner.enter_target(&preview.target_id).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn private_file(root: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = root.join(name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    file.write_all(bytes).unwrap();
    path
}

fn envelope(operation: Operation) -> v1::Request {
    v1::Request {
        request_id: vec![1],
        target_id: TARGET.into(),
        operation: Some(operation),
        ..v1::Request::default()
    }
}

#[test]
fn production_admits_agent_proxy_and_refuses_a_stale_generation() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    fixture.bind(&mut owner);
    let epoch = owner.epoch.to_vec();
    let current = owner.generation;
    let mut request = envelope(Operation::AgentProxyOpen(ProofAgentProxyOpen::default()));
    request.owner_epoch = epoch.clone();
    request.target_generation = current.to_vec();
    assert!(owner.validate(&request).is_ok());

    let mut stale = envelope(Operation::AgentProxyStatus(ProofTerminalLease::default()));
    stale.owner_epoch = epoch;
    stale.target_generation = vec![0x99; 32];
    assert_eq!(
        stale_generation(&owner, &stale),
        Some(ErrorCode::StaleGeneration)
    );
}

fn stale_generation(owner: &Owner, request: &v1::Request) -> Option<ErrorCode> {
    owner.validate(request).err()
}

#[test]
fn production_refuses_an_unbound_provider_before_touching_the_master() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    fixture.bind(&mut owner);
    // No owner-selected agent binding: the target's master is never opened and
    // no lease is stored or left ambiguous.
    assert_eq!(
        owner
            .open_agent_proxy(&ProofAgentProxyOpen::default())
            .err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    assert!(owner.lanes.agent_proxy.is_none());
    assert!(!owner.lanes.agent_close_uncertain);
    // Another target still resolves and keeps its own empty lanes.
    assert!(owner.lanes.master.is_some());
}

#[test]
fn production_rejects_a_wire_selected_agent_executable() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    fixture.bind(&mut owner);
    owner.agent_service = Some(std::sync::Arc::new(
        ServiceRecipe::new(
            Path::new("/test-agent"),
            &"0".repeat(64),
            Path::new("/test-state"),
        )
        .unwrap(),
    ));
    let selected = ProofAgentProxyOpen {
        binary_path: "/tmp/attacker".into(),
        sha256: "0".repeat(64),
    };
    assert_eq!(
        owner.open_agent_proxy(&selected).err(),
        Some(ErrorCode::OperationDenied)
    );
    // The bound recipe still goes through the target master, which refuses the
    // non-system image before any spawn.
    assert_eq!(
        owner
            .open_agent_proxy(&ProofAgentProxyOpen::default())
            .err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    assert!(owner.lanes.agent_proxy.is_none());
}

fn lane(token: [u8; 32], pid: u32) -> (Lanes, crate::owner_agent_proxy::test_support::ProxyPeer) {
    let (proxy, peer) = echo_proxy(token, pid, b"", b"");
    let lanes = Lanes {
        agent_proxy: Some(AgentProxy::Production(proxy)),
        ..Lanes::default()
    };
    (lanes, peer)
}

#[test]
fn two_target_lanes_close_only_their_own_agent_proxy() {
    let (mut first, first_peer) = lane([1; 32], 101);
    let (mut second, second_peer) = lane([2; 32], 102);
    assert!(!first.agent_proxy.as_mut().unwrap().status().unwrap().closed);
    assert!(
        !second
            .agent_proxy
            .as_mut()
            .unwrap()
            .status()
            .unwrap()
            .closed
    );
    assert_eq!(first.revoke_agent_proxy(), Ok(()));
    assert!(!first.agent_close_uncertain);
    let second_status = second.agent_proxy.as_mut().unwrap().status().unwrap();
    assert!(!second_status.closed);
    assert_eq!(second_status.pid, 102);
    assert_eq!(second.revoke_agent_proxy(), Ok(()));
    first_peer.join();
    second_peer.join();
}

#[test]
fn invalidating_one_target_leaves_the_other_agent_proxy_live() {
    let (mut first, first_peer) = lane([9; 32], 301);
    let (mut second, second_peer) = lane([10; 32], 302);
    // A changed policy/trust input drops only the affected target's lanes.
    first.invalidate_transport();
    assert!(!first.agent_close_uncertain);
    assert!(first.agent_proxy.as_mut().unwrap().status().unwrap().closed);
    let second_status = second.agent_proxy.as_mut().unwrap().status().unwrap();
    assert!(!second_status.closed);
    assert_eq!(second_status.pid, 302);
    assert_eq!(second.revoke_agent_proxy(), Ok(()));
    first_peer.join();
    second_peer.join();
}

#[test]
fn an_ambiguous_close_stays_on_its_own_lane() {
    let (mut first, first_peer) = lane([3; 32], 201);
    let (mut second, second_peer) = lane([4; 32], 202);
    first.agent_proxy = None;
    first.agent_close_uncertain = true;
    assert_eq!(first.revoke_agent_proxy(), Err(ErrorCode::OutcomeUnknown));
    assert!(!second.agent_close_uncertain);
    assert_eq!(
        second.agent_proxy.as_mut().unwrap().status().unwrap().pid,
        202
    );
    assert_eq!(second.revoke_agent_proxy(), Ok(()));
    first_peer.join();
    second_peer.join();
}
