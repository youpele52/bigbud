use std::sync::atomic::{AtomicU64, Ordering};

use super::*;
use crate::session::core::test_helpers;

static NEXT: AtomicU64 = AtomicU64::new(0);

fn scratch() -> std::path::PathBuf {
    let path = std::path::PathBuf::from(format!(
        "/tmp/bbth-retire-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    path
}

fn host_session(root: &std::path::Path) -> AgentSession {
    let mut session = AgentSession::new().unwrap();
    session.enable_terminal_host(
        Some(&root.join("state")),
        HostOptions {
            local_desktop_host: true,
            ..HostOptions::default()
        },
    );
    session.handle(test_helpers::hello()).unwrap();
    std::fs::create_dir_all(root.join("ws")).unwrap();
    session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::WorkspaceOpenRequest(
                v1::WorkspaceOpenRequest {
                    request_id: "open".to_owned(),
                    workspace_handle: "workspace".to_owned(),
                    root: root.join("ws").to_string_lossy().into_owned(),
                },
            )),
        })
        .unwrap();
    session
}

struct Pane {
    id: String,
    job: pty::PtyJob,
}

impl Pane {
    fn finish(self) {
        self.job.handle.write_input(1, b"x\n").unwrap();
        let _ = pty::read_events(self.job.reader, &self.job.handle);
    }
}

fn insert(session: &mut AgentSession, name: &str, kind: &str) -> Pane {
    let id = format!("{name}-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let job = pty::PtyHandle::spawn(
        id.clone(),
        &std::env::temp_dir(),
        "/bin/sh",
        &["-c".to_owned(), "read answer; exit 7".to_owned()],
        80,
        24,
        &[],
    )
    .expect("spawn bounded PTY fixture");
    session.pty_sessions.insert(
        id.clone(),
        PtySession {
            handle: Arc::clone(&job.handle),
            pane_identity: Some(pty_handlers::PtyPaneIdentity {
                thread_id: "thread-a".to_owned(),
                pane_id: format!("pane-{name}"),
                kind: kind.to_owned(),
            }),
            request_digest: id.as_bytes().to_vec(),
            expires_at: None,
            lifecycle: None,
            workspace_handle: "workspace".to_owned(),
        },
    );
    Pane { id, job }
}

fn inventory(session: &mut AgentSession, max: u32) -> v1::TerminalHostInventoryResponse {
    let frame = session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::TerminalHostInventoryRequest(Box::new(
                v1::TerminalHostInventoryRequest {
                    request_id: "inventory".to_owned(),
                    expected_epoch: session.agent_epoch.clone(),
                    max_panes: max,
                },
            ))),
        })
        .unwrap();
    match frame.payload {
        Some(v1::frame::Payload::TerminalHostInventoryResponse(value)) => *value,
        _ => panic!("expected inventory response"),
    }
}

fn retire(
    session: &mut AgentSession,
    leases: Vec<String>,
) -> v1::TerminalHostRetireSshSpawnResponse {
    let frame = session
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::TerminalHostRetireSshSpawnRequest(
                Box::new(v1::TerminalHostRetireSshSpawnRequest {
                    request_id: "retire".to_owned(),
                    expected_epoch: session.agent_epoch.clone(),
                    expected_build_digest: crate::identity::build_digest().to_owned(),
                    lease_ids: leases,
                }),
            )),
        })
        .unwrap();
    match frame.payload {
        Some(v1::frame::Payload::TerminalHostRetireSshSpawnResponse(value)) => *value,
        _ => panic!("expected retire response"),
    }
}

#[test]
fn inventory_is_sorted_bounded_and_names_exact_leases() {
    let root = scratch();
    let mut session = host_session(&root);
    let ssh = insert(&mut session, "ssh-a", "managed-ssh");
    let local = insert(&mut session, "local-a", "local");
    let all = inventory(&mut session, 64);
    assert!(all.accepted);
    assert_eq!(
        all.owner_artifact_id,
        format!(
            "{}@{}",
            crate::identity::build_version(),
            crate::identity::build_digest()
        )
    );
    assert_eq!(all.panes.len(), 2);
    assert_eq!(all.panes[0].pty_id, local.id);
    assert_eq!(all.panes[0].kind, "local");
    assert!(!all.panes[0].can_retire_ssh_spawn);
    assert_eq!(all.panes[1].pty_id, ssh.id);
    assert_eq!(all.panes[1].thread_id, "thread-a");
    assert_eq!(all.panes[1].pane_id, "pane-ssh-a");
    assert_eq!(all.panes[1].lease_id, ssh.id);
    assert!(all.panes[1].can_retire_ssh_spawn);
    let one = inventory(&mut session, 1);
    assert!(one.truncated);
    assert_eq!(one.panes.len(), 1);
    assert!(!inventory(&mut session, 65).accepted);
    assert!(!inventory(&mut session, 0).accepted);
    ssh.finish();
    local.finish();
}

#[test]
fn retirement_is_exact_and_fences_only_managed_ssh_spawns() {
    let root = scratch();
    let mut session = host_session(&root);
    let ssh = insert(&mut session, "ssh-a", "managed-ssh");
    let local = insert(&mut session, "local-a", "local");
    let accepted = retire(&mut session, vec![ssh.id.clone()]);
    assert!(accepted.accepted && accepted.ssh_spawn_retired);
    assert_eq!(accepted.retired_lease_ids, vec![ssh.id.clone()]);
    assert!(retire(&mut session, vec![ssh.id.clone()]).accepted);
    assert!(matches!(
        session.prepare_pty_create(v1::PtyCreateRequest {
            request_id: "late-ssh".to_owned(),
            pty_id: "late-ssh".to_owned(),
            workspace_handle: "workspace".to_owned(),
            shell: "/bin/sh".to_owned(),
            local_launch: true,
            pane_kind: "managed-ssh".to_owned(),
            ..Default::default()
        }),
        Err(SessionError::Pty(message)) if message == "SSH_SPAWN_RETIRED"
    ));
    // A non-SSH pane still works.
    let (frame, job) = session
        .prepare_pty_create(v1::PtyCreateRequest {
            request_id: "local-b".to_owned(),
            pty_id: "local-b".to_owned(),
            request_digest: b"local-b".to_vec(),
            workspace_handle: "workspace".to_owned(),
            shell: "/bin/sh".to_owned(),
            args: vec!["-c".to_owned(), "read answer; exit 0".to_owned()],
            local_launch: true,
            pane_kind: "local".to_owned(),
            ..Default::default()
        })
        .unwrap();
    assert!(matches!(
        frame.payload,
        Some(v1::frame::Payload::PtyCreateResponse(response)) if response.accepted
    ));
    let job = job.unwrap();
    job.handle.write_input(1, b"x\n").unwrap();
    let _ = pty::read_events(job.reader, &job.handle);
    // The marker survives a host restart.
    let restarted = HostLifecycle::new(
        "epoch-2",
        Some(&root.join("state")),
        HostOptions {
            local_desktop_host: true,
            ..HostOptions::default()
        },
    );
    assert!(restarted.ssh_spawn_retired());
    ssh.finish();
    local.finish();
}

#[test]
fn foreign_or_tampered_leases_refuse_without_retiring() {
    let root = scratch();
    let mut session = host_session(&root);
    let ssh = insert(&mut session, "ssh-a", "managed-ssh");
    let local = insert(&mut session, "local-a", "local");
    assert_eq!(
        retire(&mut session, vec!["foreign".to_owned()]).error_code,
        "HOST_LEASE_MISMATCH"
    );
    assert_eq!(
        retire(&mut session, vec![local.id.clone()]).error_code,
        "HOST_LEASE_MISMATCH"
    );
    let duplicate = retire(&mut session, vec![ssh.id.clone(), ssh.id.clone()]);
    assert_eq!(duplicate.error_code, "HOST_RETIREMENT_INVALID");
    assert!(!duplicate.ssh_spawn_retired);
    assert!(retire(&mut session, vec![ssh.id.clone()]).accepted);
    ssh.finish();
    local.finish();
}

#[test]
fn a_missing_host_or_bad_epoch_is_typed_and_never_inferred() {
    let mut plain = AgentSession::new().unwrap();
    plain.handle(test_helpers::hello()).unwrap();
    let response = plain
        .handle(v1::Frame {
            payload: Some(v1::frame::Payload::TerminalHostRetireSshSpawnRequest(
                Box::new(v1::TerminalHostRetireSshSpawnRequest {
                    request_id: "retire".to_owned(),
                    expected_epoch: plain.agent_epoch.clone(),
                    expected_build_digest: crate::identity::build_digest().to_owned(),
                    lease_ids: vec!["x".to_owned()],
                }),
            )),
        })
        .unwrap();
    match response.payload {
        Some(v1::frame::Payload::TerminalHostRetireSshSpawnResponse(value)) => {
            assert_eq!(value.error_code, "HOST_RETIREMENT_UNAVAILABLE");
        }
        _ => panic!("expected retire response"),
    }
}
