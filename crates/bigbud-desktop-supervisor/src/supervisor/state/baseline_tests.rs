use super::*;
use crate::v1;

fn baseline(recovery_id: &str, sequence: u64) -> v1::InstallBaseline {
    v1::InstallBaseline {
        recovery_id: recovery_id.to_owned(),
        consumer_id: "main".to_owned(),
        consumer_generation: 1,
        server_epoch: "epoch-1".to_owned(),
        applied_projection_sequence: sequence,
    }
}

fn supervisor() -> Supervisor {
    let mut supervisor = Supervisor::new(Limits::default());
    assert_eq!(
        supervisor.attach("main".to_owned(), 1, "epoch-1".to_owned(), 10),
        Ok(10)
    );
    supervisor
}

#[test]
fn installs_an_authorized_projection_baseline_idempotently() {
    let mut supervisor = supervisor();
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-1", 100)),
        Ok(100)
    );
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-1", 100)),
        Ok(100)
    );
    assert_eq!(supervisor.reset_for_replay("main", 1), Ok(100));
}

#[test]
fn rejects_a_baseline_rewind() {
    let mut supervisor = supervisor();
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-reset", 3)),
        Err(SupervisorError::BaselineMovedBackward)
    );
    assert_eq!(supervisor.reset_for_replay("main", 1), Ok(10));
}

#[test]
fn rejects_conflicting_or_non_quiescent_baselines() {
    let mut supervisor = supervisor();
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-1", 100)),
        Ok(100)
    );
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-1", 101)),
        Err(SupervisorError::BaselineIdentityConflict)
    );

    let mut queued = v1::EventBatch {
        batch_id: String::new(),
        server_epoch: "epoch-1".to_owned(),
        subscription_generation: 1,
        consumer_id: "main".to_owned(),
        consumer_generation: 1,
        events: vec![v1::Event {
            event_id: "event-101".to_owned(),
            sequence: 101,
            canonical_payload: vec![1],
        }],
    };
    queued.batch_id = canonical_batch_id(&queued);
    assert_eq!(supervisor.enqueue(queued), Ok(None));
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-2", 200)),
        Err(SupervisorError::BaselineStateConflict)
    );
}

#[test]
fn rejects_a_delayed_conflict_after_a_successive_baseline() {
    let mut supervisor = supervisor();
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-1", 100)),
        Ok(100)
    );
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-2", 200)),
        Ok(200)
    );
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-1", 300)),
        Err(SupervisorError::BaselineIdentityConflict)
    );
    assert_eq!(supervisor.reset_for_replay("main", 1), Ok(200));
}

#[test]
fn rejects_new_baseline_identities_instead_of_evicting_deduplication_state() {
    let mut supervisor = supervisor();
    for sequence in 11..=266 {
        assert_eq!(
            supervisor.install_baseline(&baseline(&format!("recovery-{sequence}"), sequence)),
            Ok(sequence)
        );
    }
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-overflow", 267)),
        Err(SupervisorError::BaselineIdentityCapacity)
    );
    assert_eq!(
        supervisor.install_baseline(&baseline("recovery-11", 267)),
        Err(SupervisorError::BaselineIdentityConflict)
    );
    assert_eq!(supervisor.reset_for_replay("main", 1), Ok(266));
}
