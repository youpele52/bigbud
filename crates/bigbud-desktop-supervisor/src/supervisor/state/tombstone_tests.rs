use super::{ConsumerState, Limits, Supervisor, SupervisorError};

fn limits() -> Limits {
    Limits {
        max_consumers: 2,
        max_consumer_identities: 2,
        ..Limits::default()
    }
}

#[test]
fn detached_generation_fences_stay_bounded_under_churn() {
    let mut supervisor = Supervisor::new(limits());
    for index in 0..128 {
        let id = format!("consumer-{index}");
        assert_eq!(
            supervisor.attach(id.clone(), index + 1, "epoch-1".to_owned(), 0),
            Ok(0)
        );
        assert_eq!(supervisor.detach(&id, index + 1), Ok(()));
        assert!(supervisor.generation_fences.len() <= 2);
    }
}

#[test]
fn evicts_only_detached_fences_and_preserves_a_live_replacement() {
    let mut supervisor = Supervisor::new(limits());
    assert_eq!(
        supervisor.attach("old".into(), 1, "epoch-1".into(), 0),
        Ok(0)
    );
    assert_eq!(supervisor.detach("old", 1), Ok(()));
    assert_eq!(
        supervisor.attach("live".into(), 2, "epoch-1".into(), 0),
        Ok(0)
    );
    assert_eq!(
        supervisor.attach("new".into(), 3, "epoch-1".into(), 0),
        Ok(0)
    );

    assert_eq!(supervisor.state("live", 2), Ok(ConsumerState::Ready));
    assert_eq!(supervisor.detach("live", 1), Ok(()));
    assert_eq!(supervisor.state("live", 2), Ok(ConsumerState::Ready));
}

#[test]
fn retained_and_evicted_detaches_remain_idempotent() {
    let mut supervisor = Supervisor::new(limits());
    assert_eq!(supervisor.detach("missing", 1), Ok(()));
    assert!(supervisor.generation_fences.is_empty());

    for (id, generation) in [("first", 1), ("second", 2), ("third", 3)] {
        assert_eq!(
            supervisor.attach(id.into(), generation, "epoch-1".into(), 0),
            Ok(0)
        );
        assert_eq!(supervisor.detach(id, generation), Ok(()));
    }
    assert_eq!(supervisor.detach("first", 1), Ok(()));
    assert_eq!(supervisor.generation_fences.len(), 2);
    assert_eq!(
        supervisor.attach("third".into(), 3, "epoch-1".into(), 0),
        Err(SupervisorError::StaleConsumerGeneration)
    );
    assert_eq!(
        supervisor.attach("first".into(), 4, "epoch-1".into(), 0),
        Ok(0),
        "an evicted tombstone must not poison a later owner"
    );
}
