#![allow(clippy::unwrap_used)]
use super::*;
fn binding(nonce: &str) -> Binding {
    Binding {
        authority: "a".repeat(32),
        installation: format!("sha256:{}", "b".repeat(64)),
        native_epoch: "epoch".into(),
        nonce: nonce.into(),
        publication_sha256: [1; 32],
        executable_sha256: [2; 32],
        assets_sha256: [3; 32],
        configuration_sha256: [4; 32],
        guard_sha256: [0; 32],
    }
}
#[test]
fn original_cancel_fence_is_idempotent_bounded_and_cannot_be_confused_with_exit() {
    let mut rows = Retained::default();
    let cancelled = rows.cancel(binding("original"), &[7; 32]).unwrap();
    assert_eq!(cancelled.state, State::Cancelled);
    assert_eq!(cancelled.original_child_pid, 0);
    assert!(cancelled.original_controller.is_none());
    assert_eq!(
        rows.cancel(binding("original"), &[7; 32]).unwrap(),
        cancelled
    );
    assert!(rows.read(&binding("original"), &[8; 32]).is_err());
    let mut changed = binding("original");
    changed.assets_sha256 = [9; 32];
    assert!(rows.cancel(changed, &[7; 32]).is_err());
    for index in 1..64 {
        rows.cancel(binding(&format!("other-{index}")), &[7; 32])
            .unwrap();
    }
    assert!(rows.full());
    assert!(rows.cancel(binding("overflow"), &[7; 32]).is_err());
    assert!(rows.contains("original"));
    assert_eq!(
        rows.read(&binding("original"), &[7; 32])
            .unwrap()
            .unwrap()
            .state,
        State::Cancelled
    );
}
#[cfg(target_os = "linux")]
#[test]
fn atomic_cancel_prevents_late_queued_original_start_without_any_execution() {
    use std::sync::{Arc, Barrier, Mutex};
    let owner = Arc::new(Mutex::new(
        crate::service_lease::LeaseOwner::new("epoch".into()).unwrap(),
    ));
    let gate = Arc::new(Barrier::new(2));
    let worker = std::thread::spawn({
        let owner = Arc::clone(&owner);
        let gate = Arc::clone(&gate);
        move || {
            let controller = crate::service_lease::Controller::current().unwrap();
            gate.wait();
            owner.lock().unwrap().start(
                binding("original"),
                controller,
                &[7; 32],
                crate::service_lease::Launch {
                    executable: "/must-never-be-opened-or-executed".into(),
                    args: vec![],
                    environment: crate::service_lease::SecretEnvironment(vec![]),
                    guard: None,
                    assets: None,
                },
            )
        }
    });
    let proof = owner
        .lock()
        .unwrap()
        .cancel_start(binding("original"), &[7; 32])
        .unwrap();
    assert_eq!(proof.state, State::Cancelled);
    gate.wait();
    assert!(matches!(worker.join().unwrap(), Err(Error::Occupied)));
    assert!(!owner.lock().unwrap().present());
}
