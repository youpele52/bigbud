//! Successor recovery with the actual mobile gateway binary as the original child.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
#[path = "support/recovery.fixture.rs"]
mod fixture;
use bigbud_remote_agent::service_lease::{Controller, State};
use fixture::{Fixture, inode, kill, old_controller, wait_missing};
use std::path::PathBuf;

#[test]
#[ignore = "requires a separately built bigbud-mobile-gateway executable"]
fn actual_gateway_survives_controller_crash_and_attaches_successor_socket() {
    let binary = PathBuf::from(std::env::var_os("BIGBUD_MOBILE_GATEWAY_TEST_BINARY").unwrap());
    let f = Fixture::gateway("actual", &binary);
    let (mut old, old_identity) = old_controller();
    let mut owner = f.owner();
    let binding = f.binding("recovery-actual-gateway");
    let original = f.listen();
    let grant = owner
        .start(binding.clone(), old_identity, &[7; 32], f.launch())
        .unwrap();
    assert_eq!(grant.snapshot.state, State::Spawned);
    assert_eq!(
        f.receipt().unwrap()["upstream"]["socket"]["ino"],
        inode(&f.socket())
    );
    drop(original);
    kill(&mut old);

    let current = Controller::current().unwrap();
    let resumed = owner.resume(&binding, &[7; 32], current.clone()).unwrap();
    assert_eq!(resumed.snapshot.state, State::Attaching);
    assert!(!f.socket().exists());
    let successor = f.listen();
    let attached = owner.resume(&binding, &[7; 32], current.clone()).unwrap();
    assert_eq!(attached.snapshot.state, State::Spawned);
    assert_eq!(f.receipt().unwrap()["revision"], 3);
    owner
        .revoke(&binding, &[7; 32], &current, attached.generation())
        .unwrap();
    assert!(f.receipt().is_none());
    drop(successor);
    wait_missing(grant.snapshot.original_child_pid);
}
