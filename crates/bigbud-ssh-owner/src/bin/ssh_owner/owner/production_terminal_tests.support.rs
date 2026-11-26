//! Shared owner + target fixtures for the production terminal admission tests.

use super::*;
use crate::{
    owner::{self, OwnerStartup, Pipe, TargetAuthority, TargetStartup},
    owner_pipe::encode_payload,
    v1::{
        Hello, ProofPrepareTerminal, TargetAuthMode, TargetDescriptor, TargetKind, frame::Payload,
    },
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

pub(in crate::owner) struct Fixture {
    pub(super) root: PathBuf,
    identity: PathBuf,
    known_hosts: PathBuf,
    state: PathBuf,
}

impl Fixture {
    pub(in crate::owner) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-production-term-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let identity = private_file(&root, "identity", 0o600);
        let known_hosts = private_file(&root, "known_hosts", 0o600);
        let state = root.join("ssh-owner");
        fs::DirBuilder::new().mode(0o700).create(&state).unwrap();
        Self {
            identity,
            known_hosts,
            state,
            root,
        }
    }

    pub(super) fn authority(&self, workspace_root: Option<&Path>) -> TargetAuthority {
        TargetAuthority::new(
            "/test-no-ssh".into(),
            "/test-no-keyscan".into(),
            None,
            None,
            workspace_root.map(Path::to_path_buf),
        )
    }

    pub(in crate::owner) fn owner(&self, workspace_root: Option<&Path>) -> Owner {
        let payload = encode_payload(Payload::Hello(Hello {
            major: 1,
            minor: 0,
            profile_binding: vec![1],
            ..Hello::default()
        }));
        let mut input = Vec::new();
        Endpoint::Client.write_frame(&mut input, &payload).unwrap();
        // A scripted pipe cannot know the random reconciliation round, so the
        // test pins it and answers with an empty, acknowledged set.
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
        owner::bootstrap(
            &mut Pipe::new(input.as_slice(), Vec::new()),
            OwnerStartup {
                profile: &[1],
                startup: TargetStartup::Unpinned(self.authority(workspace_root)),
                route_facts: crate::config::RouteFacts::default().with_production(),
                profile_lock_path: &lock,
                posix_picker: None,
                workspace_snapshot_cancel: None,
                attach_path: None,
                agent_fixture: None,
                #[cfg(any(target_os = "macos", target_os = "linux"))]
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

    pub(super) fn descriptor(&self, target: &str, port: u16) -> TargetDescriptor {
        TargetDescriptor {
            target_id: target.into(),
            kind: TargetKind::Structured as i32,
            host: Ipv4Addr::LOCALHOST.to_string(),
            port: u32::from(port),
            user: "tester".into(),
            auth_mode: TargetAuthMode::Key as i32,
            identity_reference: self.identity.to_str().unwrap().into(),
            host_key_alias: String::new(),
            trust_reference: self.known_hosts.to_str().unwrap().into(),
            generation: Vec::new(),
        }
    }

    /// Resolves one target and binds it for the current request.
    pub(in crate::owner) fn bind(&self, owner: &mut Owner, target: &str, port: u16) {
        let request = crate::v1::Request {
            request_id: vec![1],
            target_id: target.into(),
            target_descriptor: Some(self.descriptor(target, port)),
            ..crate::v1::Request::default()
        };
        let preview = owner
            .targets
            .resolve(owner.authority.as_ref(), &request, None)
            .unwrap();
        owner.enter_target(&preview.target_id).unwrap();
    }

    /// The same one-target fixture owner the pinned fixture tests use, for a
    /// direct admission-parity comparison.
    pub(super) fn fixture_owner(&self, workspace_root: &Path) -> Owner {
        let lock = self.root.join("fixture-owner");
        fs::DirBuilder::new().mode(0o700).create(&lock).unwrap();
        let hello = encode_payload(Payload::Hello(Hello {
            major: 1,
            minor: 0,
            profile_binding: vec![1],
            ..Hello::default()
        }));
        let snapshot = encode_payload(Payload::ProofStorageSnapshot(
            crate::v1::ProofStorageSnapshot {
                target_id: "fixture-target".into(),
                writer_epoch: "writer".into(),
                seq: 1,
                disconnected: false,
                error: 0,
            },
        ));
        let mut input = Vec::new();
        Endpoint::Client.write_frame(&mut input, &hello).unwrap();
        Endpoint::Client.write_frame(&mut input, &snapshot).unwrap();
        owner::bootstrap(
            &mut Pipe::new(input.as_slice(), Vec::new()),
            OwnerStartup {
                profile: &[1],
                startup: TargetStartup::Pinned {
                    target: "fixture-target".into(),
                    config: crate::transport::TransportConfig {
                        ssh: "/test-no-ssh".into(),
                        keyscan: "/test-no-keyscan".into(),
                        host: Ipv4Addr::LOCALHOST.into(),
                        port: 22222,
                        user: "tester".into(),
                        identity: self.identity.clone(),
                        known_hosts: self.known_hosts.clone(),
                        alias_config: None,
                        system_config: None,
                        workspace_root: Some(workspace_root.to_path_buf()),
                        dev_interactive_terminal: false,
                        host_identity: Default::default(),
                    },
                },
                route_facts: crate::config::RouteFacts::default(),
                profile_lock_path: &lock.join("owner.lock"),
                posix_picker: None,
                workspace_snapshot_cancel: None,
                attach_path: None,
                agent_fixture: None,
                #[cfg(any(target_os = "macos", target_os = "linux"))]
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
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn private_file(root: &Path, name: &str, mode: u32) -> PathBuf {
    let path = root.join(name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(&path)
        .unwrap();
    if name == "known_hosts" {
        file.write_all(format!("[127.0.0.1]:22222 {PIN}").as_bytes())
            .unwrap();
    } else {
        file.write_all(b"synthetic production identity").unwrap();
    }
    path
}

pub(super) fn request(cwd: &str) -> ProofPrepareTerminal {
    ProofPrepareTerminal {
        cwd: cwd.into(),
        thread_id: "thread".into(),
        terminal_id: "terminal".into(),
        cols: 80,
        rows: 24,
        shell: None,
    }
}
