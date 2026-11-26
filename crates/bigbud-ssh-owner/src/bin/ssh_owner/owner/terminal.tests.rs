//! Per-target PTY lease identity at the owner boundary (W3.7 follow-up).
//!
//! These run without SSH: they exercise reservation identity and the
//! generation/target fences before any launch. Live open/replay stays in the
//! host-gated fixture tests.

use super::*;
use crate::{
    owner::{self, OwnerStartup, Pipe, TargetStartup},
    owner_pipe::encode_payload,
    transport::TransportConfig,
    v1::{ErrorCode, Hello, ProofStorageSnapshot, ProofTerminalReservation, frame::Payload},
};
use bigbud_ssh_owner::framing::Endpoint;
use std::{fs, net::Ipv4Addr, os::unix::fs::DirBuilderExt, path::PathBuf};

const TARGET: &str = "terminal-fixture";
const WORKSPACE: &str = "/home/picker/workspace";

struct Fixture(PathBuf);

/// Parallel tests in one process need distinct roots; a timestamp can collide.
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-terminal-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        // A previous run with the same pid may have left this root behind.
        let _leftover = fs::remove_dir_all(&root);
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut identity = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(root.join("identity"))
            .unwrap();
        identity.write_all(b"fixture").unwrap();
        fs::write(root.join("known_hosts"), b"fixture").unwrap();
        Self(root)
    }

    fn config(&self) -> TransportConfig {
        TransportConfig {
            ssh: "/test-no-ssh".into(),
            keyscan: "/test-no-keyscan".into(),
            host: Ipv4Addr::LOCALHOST.into(),
            port: 22222,
            user: "picker".into(),
            identity: self.0.join("identity"),
            known_hosts: self.0.join("known_hosts"),
            alias_config: None,
            system_config: None,
            workspace_root: Some(WORKSPACE.into()),
            dev_interactive_terminal: false,
            host_identity: Default::default(),
        }
    }

    fn owner(&self) -> Owner {
        let frame = |payload: Payload| {
            let mut bytes = Vec::new();
            Endpoint::Client
                .write_frame(&mut bytes, &encode_payload(payload))
                .unwrap();
            bytes
        };
        let mut input = frame(Payload::Hello(Hello {
            major: 1,
            profile_binding: vec![1],
            ..Hello::default()
        }));
        input.extend(frame(Payload::ProofStorageSnapshot(ProofStorageSnapshot {
            target_id: TARGET.into(),
            writer_epoch: "writer".into(),
            seq: 1,
            disconnected: false,
            error: 0,
        })));
        let lock = self.0.join("owner.lock");
        owner::bootstrap(
            &mut Pipe::new(input.as_slice(), Vec::new()),
            OwnerStartup {
                profile: &[1],
                startup: TargetStartup::Pinned {
                    target: TARGET.into(),
                    config: self.config(),
                },
                route_facts: Default::default(),
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
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn prepare(owner: &mut Owner) -> ProofTerminalReservation {
    owner
        .prepare_terminal(ProofPrepareTerminal {
            cwd: WORKSPACE.into(),
            thread_id: "thread".into(),
            terminal_id: "terminal".into(),
            cols: 80,
            rows: 24,
            shell: None,
        })
        .unwrap()
}

#[test]
fn a_stale_generation_cannot_cancel_or_attach_a_reserved_terminal() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    let reservation = prepare(&mut owner);
    let old_generation = owner.generation;

    // A generation change for this target fences the reservation.
    owner.generation = [0x5a; 32];
    assert_eq!(
        owner.cancel_terminal_reservation(&reservation.lease).err(),
        Some(ErrorCode::OperationDenied)
    );
    assert_eq!(
        owner.open_terminal(&reservation.lease).err(),
        Some(ErrorCode::OperationDenied)
    );
    assert_eq!(
        owner.terminal_status(&reservation.lease).err(),
        Some(ErrorCode::OperationDenied)
    );
    assert_eq!(
        owner.close_terminal(&reservation.lease).err(),
        Some(ErrorCode::OperationDenied)
    );

    // Restoring the exact generation makes the same reservation usable again.
    owner.generation = old_generation;
    owner
        .cancel_terminal_reservation(&reservation.lease)
        .unwrap();
}

#[test]
fn a_reservation_belongs_to_one_target() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    let reservation = prepare(&mut owner);
    // A request for another target would bind another slot; the pinned target's
    // reservation must not answer it. The lanes never cross target boundaries.
    let other = owner
        .target_lanes("ssh:other")
        .and_then(|lanes| lanes.terminal_uncertain.then_some(()));
    assert!(other.is_none());
    assert!(
        owner
            .target_lanes(TARGET)
            .is_some_and(|lanes| !lanes.terminal_uncertain)
    );
    owner
        .cancel_terminal_reservation(&reservation.lease)
        .unwrap();
}

#[test]
fn a_terminal_presence_for_one_target_does_not_block_another() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    // Simulate an ambiguous write on the pinned target.
    owner.lanes.terminal_uncertain = true;
    assert!(owner.target_lanes(TARGET).unwrap().terminal_uncertain());
    // An unknown target's lanes are simply absent, not inherited.
    assert!(owner.target_lanes("ssh:other").is_none());
}
