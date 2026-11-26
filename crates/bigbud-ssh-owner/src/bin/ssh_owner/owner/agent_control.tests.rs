#![allow(clippy::expect_used)]

use super::{AgentControlLanes, MAX_RETAINED, MAX_RUNNING, production_verb};
use crate::{
    owner::lease_worker::Worker,
    owner_backend::deployment_worker::Settled,
    v1::{AgentControlLease, ErrorCode, request::Operation},
};

fn settled_lease(lanes: &mut AgentControlLanes, byte: u8) {
    let mut worker = Worker::spawn("test-agent-control", Settled::Unknown, |_| {
        Settled::Cancelled
    })
    .expect("worker");
    while worker.settled().is_none() {
        std::thread::yield_now();
    }
    lanes.leases.push_back(super::Lease {
        token: [byte; 32],
        kind: 2,
        socket_path: None,
        worker,
    });
}

#[test]
fn the_u25_control_and_proxy_lease_verbs_are_admitted() {
    assert!(production_verb(
        &Operation::AgentControlOpen(Box::default())
    ));
    assert!(production_verb(&Operation::AgentControlStatus(
        AgentControlLease::default()
    )));
    assert!(production_verb(&Operation::AgentControlCancel(
        AgentControlLease::default()
    )));
    assert!(production_verb(&Operation::AgentProxyLeaseOpen(
        crate::v1::AgentProxyLeaseOpen::default()
    )));
    assert!(production_verb(&Operation::AgentProxyLeaseClose(
        crate::v1::ClientRelayLease::default()
    )));
    assert!(!production_verb(&Operation::ClientRelayLeaseOpen(
        crate::v1::ClientRelayLeaseOpen::default()
    )));
}

#[test]
fn a_retained_outcome_is_read_back_without_running_again() {
    let mut lanes = AgentControlLanes::default();
    settled_lease(&mut lanes, 1);
    let lease = lanes.find(&[1; 32]).expect("retained");
    assert!(lease.reply().is_ok());
    assert!(lanes.find(&[2; 32]).is_none());
}

#[test]
fn the_retained_set_drops_its_oldest_settled_outcome() {
    let mut lanes = AgentControlLanes::default();
    for byte in 0..u8::try_from(MAX_RETAINED).expect("bound") {
        settled_lease(&mut lanes, byte);
    }
    assert!(lanes.admit().is_ok());
    assert_eq!(lanes.leases.len(), MAX_RETAINED - 1);
    assert!(lanes.find(&[0; 32]).is_none());
}

#[test]
fn a_full_running_set_is_a_quota_refusal() {
    let mut lanes = AgentControlLanes::default();
    let gate = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    for byte in 0..u8::try_from(MAX_RUNNING).expect("bound") {
        let gate = std::sync::Arc::clone(&gate);
        let worker = Worker::spawn("test-agent-control", Settled::Unknown, move |signals| {
            while !signals.cancelled() && !gate.load(std::sync::atomic::Ordering::Acquire) {
                std::thread::yield_now();
            }
            Settled::Cancelled
        })
        .expect("worker");
        lanes.leases.push_back(super::Lease {
            token: [byte; 32],
            kind: 2,
            socket_path: None,
            worker,
        });
    }
    assert_eq!(lanes.admit().err(), Some(ErrorCode::SessionQuota));
    assert!(lanes.revoke().is_ok());
}
