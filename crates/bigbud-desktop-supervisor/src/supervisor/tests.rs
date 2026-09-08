use super::*;

macro_rules! require_ok {
    ($expression:expr) => {{
        let result = $expression;
        assert!(result.is_ok(), "unexpected error: {result:?}");
        let Ok(value) = result else {
            return;
        };
        value
    }};
}

fn batch(first: u64, count: u64) -> v1::EventBatch {
    let mut batch = v1::EventBatch {
        batch_id: String::new(),
        server_epoch: "epoch-1".to_owned(),
        subscription_generation: 1,
        consumer_id: "main".to_owned(),
        consumer_generation: 1,
        events: (first..first + count)
            .map(|sequence| v1::Event {
                event_id: format!("event-{sequence}"),
                sequence,
                canonical_payload: vec![1, 2, 3],
            })
            .collect(),
    };
    batch.batch_id = canonical_batch_id(&batch);
    batch
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
fn advances_only_after_an_application_acknowledgement() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 2)), Ok(None));
    let delivery = require_ok!(supervisor.next_delivery("main", 1, 100));
    assert!(delivery.is_some(), "delivery was not emitted");
    let Some(delivery) = delivery else {
        return;
    };
    assert_eq!(delivery.sent_sequence, 12);
    assert_eq!(
        supervisor.state("main", 1),
        Ok(ConsumerState::AwaitingAcknowledgement)
    );
    assert_eq!(
        supervisor.acknowledge(&v1::ApplicationAck {
            batch_id: delivery.batch.batch_id,
            consumer_id: "main".to_owned(),
            consumer_generation: 1,
            received_through_sequence: 12,
            applied_through_sequence: 12,
            application_duration_ms: 2,
        }),
        Ok(())
    );
    assert_eq!(supervisor.state("main", 1), Ok(ConsumerState::Ready));
    assert_eq!(supervisor.reset_for_replay("main", 1), Ok(12));
}

#[test]
fn acknowledgement_timeout_replays_from_last_applied() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    let _delivery = require_ok!(supervisor.next_delivery("main", 1, 100));
    let action = require_ok!(supervisor.check_timeout("main", 1, 15_100));
    assert!(action.is_some(), "recovery was not requested");
    let Some(action) = action else {
        return;
    };
    assert_eq!(action.from_sequence_exclusive, 10);
    assert_eq!(action.kind, v1::RecoveryKind::Replay);
    assert_eq!(supervisor.state("main", 1), Ok(ConsumerState::Stalled));
}

#[test]
fn lost_acknowledgement_can_be_replayed_without_advancing() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    let _delivery = require_ok!(supervisor.next_delivery("main", 1, 0));
    assert_eq!(supervisor.reset_for_replay("main", 1), Ok(10));
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    assert!(matches!(
        supervisor.next_delivery("main", 1, 1),
        Ok(Some(_))
    ));
}

#[test]
fn rejects_stale_windows_and_acknowledgements_beyond_sent() {
    let mut supervisor = supervisor();
    assert_eq!(
        supervisor.next_delivery("main", 2, 0),
        Err(SupervisorError::StaleConsumerGeneration)
    );
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    let delivery = require_ok!(supervisor.next_delivery("main", 1, 0));
    assert!(delivery.is_some(), "delivery was not emitted");
    let Some(delivery) = delivery else {
        return;
    };
    assert_eq!(
        supervisor.acknowledge(&v1::ApplicationAck {
            batch_id: delivery.batch.batch_id,
            consumer_id: "main".to_owned(),
            consumer_generation: 1,
            received_through_sequence: 12,
            applied_through_sequence: 12,
            application_duration_ms: 0,
        }),
        Err(SupervisorError::AckBeyondSent)
    );
}

#[test]
fn rejects_partial_batch_acknowledgements() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 2)), Ok(None));
    let delivery = require_ok!(supervisor.next_delivery("main", 1, 0));
    let Some(delivery) = delivery else {
        return;
    };
    assert_eq!(
        supervisor.acknowledge(&v1::ApplicationAck {
            batch_id: delivery.batch.batch_id,
            consumer_id: "main".to_owned(),
            consumer_generation: 1,
            received_through_sequence: 12,
            applied_through_sequence: 11,
            application_duration_ms: 0,
        }),
        Err(SupervisorError::IncompleteAck)
    );
    assert_eq!(
        supervisor.state("main", 1),
        Ok(ConsumerState::AwaitingAcknowledgement)
    );
}

#[test]
fn queue_overload_preserves_the_acknowledged_replay_cursor() {
    let mut supervisor = Supervisor::new(Limits {
        max_queue_events: 1,
        ..Limits::default()
    });
    assert_eq!(
        supervisor.attach("main".to_owned(), 1, "epoch-1".to_owned(), 10),
        Ok(10)
    );
    let action = require_ok!(supervisor.enqueue(batch(11, 2)));
    assert!(action.is_some(), "overload recovery was not requested");
    let Some(action) = action else {
        return;
    };
    assert_eq!(action.kind, v1::RecoveryKind::Overload);
    assert_eq!(action.from_sequence_exclusive, 10);
    assert_eq!(supervisor.state("main", 1), Ok(ConsumerState::Overloaded));
}

#[test]
fn duplicate_batch_identity_is_idempotent() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    assert!(matches!(
        supervisor.next_delivery("main", 1, 0),
        Ok(Some(_))
    ));
    assert_eq!(supervisor.next_delivery("main", 1, 0), Ok(None));
}

#[test]
fn rejects_a_duplicate_batch_id_with_different_content() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    let mut conflicting = batch(11, 1);
    let Some(event) = conflicting.events.first_mut() else {
        return;
    };
    event.canonical_payload = vec![9];

    assert_eq!(
        supervisor.enqueue(conflicting),
        Err(SupervisorError::BatchIdentityConflict)
    );
    assert!(matches!(
        supervisor.next_delivery("main", 1, 0),
        Ok(Some(_))
    ));
}

#[test]
fn rejects_stale_attach_generations_and_sequence_rollback() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    let delivery = require_ok!(supervisor.next_delivery("main", 1, 0));
    let Some(delivery) = delivery else {
        return;
    };
    assert_eq!(
        supervisor.acknowledge(&v1::ApplicationAck {
            batch_id: delivery.batch.batch_id,
            consumer_id: "main".to_owned(),
            consumer_generation: 1,
            received_through_sequence: 11,
            applied_through_sequence: 11,
            application_duration_ms: 0,
        }),
        Ok(())
    );

    assert_eq!(
        supervisor.attach("main".to_owned(), 0, "epoch-1".to_owned(), 11),
        Err(SupervisorError::StaleConsumerGeneration)
    );
    assert_eq!(
        supervisor.attach("main".to_owned(), 2, "epoch-1".to_owned(), 10),
        Err(SupervisorError::AttachSequenceRollback)
    );
    assert_eq!(supervisor.reset_for_replay("main", 1), Ok(11));
}

#[test]
fn preserves_state_for_an_idempotent_attach() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    assert!(matches!(
        supervisor.next_delivery("main", 1, 0),
        Ok(Some(_))
    ));
    assert_eq!(
        supervisor.attach("main".to_owned(), 1, "epoch-1".to_owned(), 10),
        Ok(10)
    );
    assert_eq!(
        supervisor.state("main", 1),
        Ok(ConsumerState::AwaitingAcknowledgement)
    );
}

#[test]
fn rejects_same_generation_attach_that_would_replace_live_state() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    assert!(matches!(
        supervisor.next_delivery("main", 1, 0),
        Ok(Some(_))
    ));

    assert_eq!(
        supervisor.attach("main".to_owned(), 1, "epoch-1".to_owned(), 11),
        Err(SupervisorError::AttachStateConflict)
    );
    assert_eq!(
        supervisor.state("main", 1),
        Ok(ConsumerState::AwaitingAcknowledgement)
    );
}

#[test]
fn ignores_a_replayed_batch_identity_after_acknowledgement() {
    let mut supervisor = supervisor();
    let replayed = batch(11, 1);
    assert_eq!(supervisor.enqueue(replayed.clone()), Ok(None));
    let delivery = require_ok!(supervisor.next_delivery("main", 1, 0));
    let Some(delivery) = delivery else {
        return;
    };
    assert_eq!(
        supervisor.acknowledge(&v1::ApplicationAck {
            batch_id: delivery.batch.batch_id,
            consumer_id: "main".to_owned(),
            consumer_generation: 1,
            received_through_sequence: 11,
            applied_through_sequence: 11,
            application_duration_ms: 0,
        }),
        Ok(())
    );
    assert_eq!(supervisor.enqueue(replayed), Ok(None));
    assert_eq!(supervisor.next_delivery("main", 1, 1), Ok(None));
}

#[test]
fn accepts_only_a_known_duplicate_acknowledgement_after_completion() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    let delivery = require_ok!(supervisor.next_delivery("main", 1, 0));
    let Some(delivery) = delivery else {
        return;
    };
    let ack = v1::ApplicationAck {
        batch_id: delivery.batch.batch_id,
        consumer_id: "main".to_owned(),
        consumer_generation: 1,
        received_through_sequence: 11,
        applied_through_sequence: 11,
        application_duration_ms: 0,
    };
    assert_eq!(supervisor.acknowledge(&ack), Ok(()));
    assert_eq!(supervisor.acknowledge(&ack), Ok(()));
    assert_eq!(
        supervisor.acknowledge(&v1::ApplicationAck {
            batch_id: "unknown-batch".to_owned(),
            ..ack
        }),
        Err(SupervisorError::UnknownBatch)
    );
}

#[test]
fn timeout_scan_emits_recovery_only_once() {
    let mut supervisor = supervisor();
    assert_eq!(supervisor.enqueue(batch(11, 1)), Ok(None));
    assert!(matches!(
        supervisor.next_delivery("main", 1, 100),
        Ok(Some(_))
    ));
    let actions = supervisor.check_timeouts(15_100);
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].from_sequence_exclusive, 10);
    assert!(supervisor.check_timeouts(15_200).is_empty());
}
