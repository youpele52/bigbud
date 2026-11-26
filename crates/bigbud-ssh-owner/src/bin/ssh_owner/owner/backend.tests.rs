use super::{BackendLanes, Worker, production_verb};
use crate::owner_backend::{deployment_worker::Settled, relay_worker::Outcome as RelayOutcome};
use crate::v1::{
    ClientRelayLease, ClientRelayLeaseOpen, DeploymentStepLease, DeploymentStepOpen, Empty,
    request::Operation,
};
use std::{
    thread,
    time::{Duration, Instant},
};

fn waiting_worker(token: u8) -> Result<Worker<RelayOutcome>, crate::v1::ErrorCode> {
    Worker::spawn(
        [token; 32],
        None,
        RelayOutcome::Unconfirmed,
        "test-relay",
        |signals| {
            signals.streaming();
            while !signals.cancelled() {
                thread::sleep(Duration::from_millis(1));
            }
            RelayOutcome::Closed
        },
    )
}

#[test]
fn only_the_backend_verbs_are_admitted_by_this_lane() {
    for operation in [
        Operation::DeploymentStepOpen(DeploymentStepOpen::default()),
        Operation::DeploymentStepStatus(DeploymentStepLease::default()),
        Operation::DeploymentStepCancel(DeploymentStepLease::default()),
        Operation::ClientRelayLeaseOpen(ClientRelayLeaseOpen::default()),
        Operation::ClientRelayLeaseStatus(ClientRelayLease::default()),
        Operation::ClientRelayLeaseClose(ClientRelayLease::default()),
    ] {
        assert!(production_verb(&operation), "{operation:?}");
    }
    assert!(!production_verb(&Operation::Connect(Empty {})));
}

#[test]
fn retire_settles_a_worker_and_revoke_reaps_every_lease() {
    let Ok(mut worker) = waiting_worker(1) else {
        panic!("spawn");
    };
    let started = Instant::now();
    while !worker.started() && started.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(worker.observe(), None);
    assert_eq!(worker.retire(), Some(RelayOutcome::Closed));
    // Settled results are retained and read again without re-running.
    assert_eq!(worker.observe(), Some(RelayOutcome::Closed));

    let mut lanes = BackendLanes::default();
    for token in 2..4 {
        let Ok(worker) = waiting_worker(token) else {
            panic!("spawn");
        };
        lanes.relays.push(worker);
    }
    assert_eq!(lanes.revoke(), Ok(()));
    assert!(
        lanes
            .relays
            .iter_mut()
            .all(|relay| relay.observe() == Some(RelayOutcome::Closed))
    );
}

#[test]
fn a_worker_that_never_settles_is_reported_unknown() {
    let Ok(worker) = Worker::spawn([9; 32], None, Settled::Unknown, "test-stuck", |_signals| {
        thread::sleep(Duration::from_secs(3));
        Settled::Cancelled
    }) else {
        panic!("spawn");
    };
    let mut lanes = BackendLanes {
        deployment: Some(super::DeploymentLease {
            worker,
            kind: 1,
            request_id: String::new(),
        }),
        relays: Vec::new(),
    };
    assert_eq!(lanes.revoke(), Err(crate::v1::ErrorCode::OutcomeUnknown));
}
