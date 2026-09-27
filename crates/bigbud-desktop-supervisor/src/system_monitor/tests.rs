use super::*;

use v1::frame::Payload;

fn hello() -> v1::Frame {
    wrap(Payload::Hello(v1::Hello { major: 1, minor: 1 }))
}
fn subscribe(request_id: u64) -> v1::Frame {
    wrap(Payload::Subscribe(v1::Subscribe {
        request_id,
        demand: Some(v1::Demand {
            processes: false,
            disks: false,
            sensors: false,
        }),
    }))
}

#[test]
fn handshake_subscription_and_ack_deadline() {
    let now = Instant::now();
    let mut state = State::new();
    assert!(state.handle(subscribe(1), now).1);
    assert!(matches!(
        state.handle(hello(), now).0[0].payload,
        Some(Payload::HelloAck(ref ack)) if ack.minor == 1 && ack.architecture.as_deref().is_some_and(|arch| !arch.is_empty())
    ));
    let response = state.handle(subscribe(1), now).0;
    let id = match &response[0].payload {
        Some(Payload::SubscribeAck(ack)) => ack.subscription_id,
        _ => panic!("missing subscription"),
    };
    assert_eq!(id, 1);
    let frames = state.tick(now);
    let sequence = match &frames[0].payload {
        Some(Payload::Snapshot(snapshot)) => snapshot.sequence,
        _ => panic!("missing snapshot"),
    };
    assert_eq!(sequence, 1);
    assert!(state.tick(now + Duration::from_secs(1)).is_empty());
    let frames = state
        .handle(
            wrap(Payload::SnapshotAck(v1::SnapshotAck {
                subscription_id: id,
                epoch: state.epoch,
                sequence,
            })),
            now + Duration::from_secs(1),
        )
        .0;
    assert!(matches!(frames[0].payload, Some(Payload::Snapshot(_))));
    let frames = state.tick(now + Duration::from_secs(7));
    assert!(
        matches!(&frames[0].payload, Some(Payload::Error(error)) if error.code == "ack-timeout")
    );
    assert_eq!(state.service.subscription_count(), 0);
}

#[test]
fn old_minor_client_negotiates_without_new_identity_fields() {
    let now = Instant::now();
    let mut state = State::new();
    let frames = state
        .handle(wrap(Payload::Hello(v1::Hello { major: 1, minor: 0 })), now)
        .0;
    assert!(
        matches!(&frames[0].payload, Some(Payload::HelloAck(ack)) if ack.minor == 0 && ack.hostname.is_none() && ack.architecture.is_none())
    );
}

#[test]
fn subscription_lease_and_query_validation() {
    let now = Instant::now();
    let mut state = State::new();
    let _ = state.handle(hello(), now);
    let _ = state.handle(subscribe(1), now);
    let _ = state.tick(now + Duration::from_secs(16));
    assert_eq!(state.service.subscription_count(), 0);
    let query = v1::ProcessQuery {
        request_id: 2,
        name: "x".repeat(257),
        pid: None,
        status: String::new(),
        sort: "cpu".into(),
        descending: true,
        limit: 100,
        cursor_generation: 0,
        cursor_digest: 0,
        cursor_offset: 0,
    };
    let response = state.handle(wrap(Payload::ProcessQuery(query)), now).0;
    assert!(matches!(&response[0].payload, Some(Payload::Error(error)) if error.code == "invalid"));
}

#[test]
fn retry_resets_collection_and_starts_a_new_epoch() {
    let now = Instant::now();
    let mut state = State::new();
    let _ = state.handle(hello(), now);
    let _ = state.handle(subscribe(1), now);
    assert!(!state.tick(now).is_empty());
    assert!(state.service.latest().is_some());
    let epoch = state.epoch;
    let response = state
        .handle(
            wrap(Payload::RetryCollection(v1::RetryCollection {
                request_id: 2,
            })),
            now,
        )
        .0;
    assert!(matches!(&response[0].payload, Some(Payload::RetryAck(ack)) if ack.epoch != epoch));
    assert!(state.service.latest().is_none());
    assert_eq!(state.service.subscription_count(), 1);
    assert!(state.subscriptions.contains_key(&1));
    assert!(
        matches!(&state.tick(now)[0].payload, Some(Payload::Snapshot(snapshot)) if snapshot.baseline)
    );
}
