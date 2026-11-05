#![allow(clippy::unwrap_used)]
use super::*;
use crate::{Role, owner::AuthenticatedPeer};
use std::{io::Write, num::NonZeroU32};

fn root() -> crate::worker::ExecutionRoot {
    let pid = NonZeroU32::new(std::process::id()).unwrap();
    crate::worker::ExecutionRoot {
        pid,
        creation_identity: crate::worker::unix::inspect(pid).unwrap().creation,
        generation: "test-lifeline".into(),
    }
}

// Same-process socket fixture deliberately bypasses the separately tested peer
// bootstrap. These tests exercise EOF/thread/cancellation, not owner death or
// cross-exec inheritance, blocked Driver work, or physical retirement.
fn watcher(role: Role) -> (IndependentLifeline, UnixStream, PriorityRetirement) {
    let (peer, stream) = UnixStream::pair().unwrap();
    let requests = PriorityRetirement::default();
    let watcher = IndependentLifeline::start(
        AuthenticatedPeer {
            stream,
            role,
            expected: root(),
        },
        requests.clone(),
    )
    .unwrap();
    (watcher, peer, requests)
}
fn completed(watcher: IndependentLifeline) -> WatcherOutcome {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !watcher.thread.as_ref().unwrap().is_finished() {
        assert!(Instant::now() < deadline, "watcher failed to finish");
        thread::sleep(Duration::from_millis(1));
    }
    match watcher.stop_and_join(Duration::from_secs(1)) {
        Ok(outcome) => outcome,
        Err(_) => panic!("completed thread failed to join"),
    }
}
#[test]
fn eof_independently_revokes_each_supervised_role() {
    for (role, cause) in [
        (Role::Guard, RetirementCause::GuardLost),
        (Role::Owner, RetirementCause::OwnerLost),
        (Role::Worker, RetirementCause::WorkerLost),
    ] {
        let (watcher, peer, requests) = watcher(role);
        drop(peer);
        assert_eq!(completed(watcher), WatcherOutcome::ParentLost);
        assert!(requests.admission_closed());
        assert_eq!(requests.take_causes(), cause as u8);
    }
}
#[test]
fn unexpected_data_is_not_a_heartbeat() {
    let (watcher, mut peer, requests) = watcher(Role::Guard);
    peer.write_all(&[1]).unwrap();
    assert_eq!(completed(watcher), WatcherOutcome::Malformed);
    assert_eq!(
        requests.take_causes(),
        RetirementCause::MalformedLifeline as u8
    );
}
#[test]
fn orderly_cancel_joins_idle_reader_without_waiting_for_peer() {
    let (watcher, _peer, requests) = watcher(Role::Guard);
    match watcher.stop_and_join(Duration::from_secs(1)) {
        Ok(outcome) => assert_eq!(outcome, WatcherOutcome::Cancelled),
        Err(_) => panic!("idle reader failed to join"),
    }
    assert!(requests.admission_closed());
    assert_eq!(requests.take_causes(), 0);
}
#[test]
fn invalid_join_budget_retains_handle_for_retry() {
    let (watcher, _peer, _) = watcher(Role::Guard);
    let watcher = match watcher.stop_and_join(MAX_JOIN + Duration::from_secs(1)) {
        Err(watcher) => watcher,
        Ok(_) => panic!("invalid join budget accepted"),
    };
    assert_eq!(completed(watcher), WatcherOutcome::Cancelled);
}
#[test]
fn broker_cannot_supply_guard_lifeline() {
    let (_peer, stream) = UnixStream::pair().unwrap();
    assert!(
        IndependentLifeline::start(
            AuthenticatedPeer {
                stream,
                role: Role::Broker,
                expected: root(),
            },
            PriorityRetirement::default()
        )
        .is_err()
    );
}
