use super::*;
use crate::v1::{ProofPaneBinding, ProofRetirementEntry};
use std::process::{Child, Command, Stdio};

const EPOCH: &str = "aa";

fn child() -> Child {
    Command::new("/bin/sleep")
        .arg("5")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn reap(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn bound(target: &str, pid: u32, start: u64, namespace: Option<u64>) -> ProofRetirementEntry {
    ProofRetirementEntry {
        target_id: target.into(),
        kind: "owner".into(),
        state: "bound".into(),
        owner_epoch: "0".repeat(64),
        pid,
        start,
        namespace,
        detail: "prior owner".into(),
    }
}

fn snapshot(
    request_id: &[u8],
    retirements: Vec<ProofRetirementEntry>,
    panes: Vec<ProofPaneBinding>,
) -> ProofReconcileSnapshot {
    ProofReconcileSnapshot {
        request_id: request_id.to_vec(),
        digest: vec![7; 32],
        retirements,
        panes,
        error: ErrorCode::Unspecified as i32,
    }
}

fn verify(request_id: &[u8], retirements: Vec<ProofRetirementEntry>) -> Ack {
    verify_with_panes(request_id, retirements, Vec::new())
}

fn verify_with_panes(
    request_id: &[u8],
    retirements: Vec<ProofRetirementEntry>,
    panes: Vec<ProofPaneBinding>,
) -> Ack {
    super::verify(
        request_id.to_vec(),
        snapshot(request_id, retirements, panes),
        EPOCH,
    )
    .unwrap()
}

fn pane(state: &str, owner_epoch: &str) -> ProofPaneBinding {
    ProofPaneBinding {
        owner_key: format!("terminal:{}", "b".repeat(64)),
        thread_id: "thread-1".into(),
        terminal_id: "terminal-1".into(),
        owner_epoch: owner_epoch.into(),
        target_id: "ssh:host=a".into(),
        generation: String::new(),
        lease_id: "reservation-1".into(),
        state: state.into(),
        remote_shell_pid: None,
        terminated: false,
    }
}

#[test]
fn unresolved_retirement_entry_refuses_admission() {
    let intent = ProofRetirementEntry {
        target_id: "ssh:host=a".into(),
        kind: "owner".into(),
        state: "intent".into(),
        owner_epoch: String::new(),
        pid: 0,
        start: 0,
        namespace: None,
        detail: "pre-spawn".into(),
    };
    let ack = verify(&[1; 32], vec![intent]);
    assert_eq!(ack.error, RETIREMENT);
    assert!(!ack.acknowledged());
}

#[test]
fn pid_reuse_and_namespace_mismatch_refuse() {
    let child = child();
    let (pid, start, namespace) = retirement::test_identity(child.id()).unwrap();
    let reused = verify(
        &[2; 32],
        vec![bound("ssh:host=a", pid, start + 1, namespace)],
    );
    assert_eq!(reused.error, RETIREMENT);
    let mismatched = verify(
        &[3; 32],
        vec![bound(
            "ssh:host=a",
            pid,
            start,
            Some(namespace.unwrap_or(0) ^ 1),
        )],
    );
    assert_eq!(mismatched.error, RETIREMENT);
    // Refusal never signals or adopts the live instance.
    assert!(retirement::test_identity(pid).is_some());
    reap(child);
}

#[test]
fn verified_gone_entry_is_accepted_without_signalling() {
    let child = child();
    let (pid, start, namespace) = retirement::test_identity(child.id()).unwrap();
    reap(child);
    let ack = verify(&[4; 32], vec![bound("ssh:host=a", pid, start, namespace)]);
    assert!(ack.acknowledged());
    assert_eq!(ack.retirements, 1);
    assert_eq!(ack.panes, 0);
}

#[test]
fn pane_bindings_attach_only_host_lost_and_closed() {
    let attach = pane("prepared", EPOCH);
    assert_eq!(
        pane::check(&attach, EPOCH).unwrap(),
        Disposition::AttachOnly
    );
    assert_eq!(
        pane::check(&pane("prepared", "other"), EPOCH).unwrap(),
        Disposition::HostLost
    );
    // An uncertain reservation is retained, never closed and never respawned.
    assert_eq!(
        pane::check(&pane("may-have-been-sent", EPOCH), EPOCH).unwrap(),
        Disposition::HostLost
    );
    assert_eq!(
        pane::check(&pane("outcome-unknown", EPOCH), EPOCH).unwrap(),
        Disposition::HostLost
    );
    let mut closed = pane("may-have-been-sent", EPOCH);
    closed.terminated = true;
    assert_eq!(pane::check(&closed, EPOCH).unwrap(), Disposition::Closed);
    // A malformed identity or an unknown reservation state refuses admission.
    let mut malformed = pane("prepared", EPOCH);
    malformed.owner_key.clear();
    assert_eq!(pane::check(&malformed, EPOCH), Err(PANE));
    assert_eq!(pane::check(&pane("dispatched", EPOCH), EPOCH), Err(PANE));
}

#[test]
fn a_refused_set_reports_a_typed_pane_error() {
    let mut malformed = pane("prepared", EPOCH);
    malformed.lease_id.clear();
    let ack = verify_with_panes(&[5; 32], Vec::new(), vec![malformed]);
    assert_eq!(ack.error, PANE);
}

#[test]
fn a_previous_round_cannot_acknowledge_a_new_binding() {
    let current = [9; 32];
    let stale = snapshot(&[8; 32], Vec::new(), Vec::new());
    assert!(super::verify(current.to_vec(), stale, EPOCH).is_err());
}

#[test]
fn failed_hydration_is_typed_and_does_not_mutate_anything() {
    let request_id = [6; 32];
    let ack = super::verify(
        request_id.to_vec(),
        ProofReconcileSnapshot {
            request_id: request_id.to_vec(),
            digest: vec![1; 32],
            retirements: Vec::new(),
            panes: Vec::new(),
            error: ErrorCode::StorageUnavailable as i32,
        },
        EPOCH,
    )
    .unwrap();
    assert_eq!(ack.error, ErrorCode::StorageUnavailable);
    assert!(!ack.acknowledged());
    assert_eq!(ack.retirements, 0);
    assert_eq!(ack.panes, 0);
}
