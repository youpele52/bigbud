//! Actor: bounded `try_feed`, fenced copies (F1), invalidation, panics, rebuild fencing.

use super::super::{
    ActorEvent, DetectedQuery, FeedOutcome, FenceError, InvalidReason, ModelState, RebuildError,
    ScreenActor, ScreenActorConfig, ScreenModel, SnapshotLimits,
};
use super::dump::{diff, dump};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

type Events = Arc<Mutex<Vec<ActorEvent>>>;

fn spawn(config: ScreenActorConfig) -> (ScreenActor, Events) {
    let events: Events = Arc::default();
    let sink = Arc::clone(&events);
    let actor = ScreenActor::spawn(
        config,
        Box::new(move |event| sink.lock().unwrap().push(event)),
    )
    .expect("spawn");
    (actor, events)
}

fn soon() -> Instant {
    Instant::now() + Duration::from_secs(2)
}

fn chunk(sequence: u64) -> Vec<u8> {
    format!("\x1b[3{}mline {sequence}\x1b[m\r\n", sequence % 8).into_bytes()
}

fn wait_for(condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "condition not reached in time");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn fenced_copy_includes_every_accepted_chunk_and_reports_queries() {
    let (actor, events) = spawn(ScreenActorConfig::new(40, 5));
    let mut reference = ScreenModel::new(40, 5, 1_000).unwrap();
    for sequence in 1..=20 {
        assert_eq!(
            actor.try_feed(sequence, chunk(sequence), soon()),
            FeedOutcome::Queued
        );
        let _ = reference.feed(&chunk(sequence));
    }
    assert_eq!(
        actor.try_feed(20, chunk(20), soon()),
        FeedOutcome::Duplicate
    );
    let copy = actor.snapshot_fenced(soon()).expect("fence");
    assert_eq!(copy.through_sequence(), 20);
    let snapshot = copy
        .serialize(&SnapshotLimits::default())
        .expect("serialize");
    assert_eq!(
        snapshot,
        reference
            .copy(20)
            .serialize(&SnapshotLimits::default())
            .expect("reference")
    );
    assert_eq!(
        actor.try_feed(21, b"\x1b[6n".to_vec(), soon()),
        FeedOutcome::Queued
    );
    wait_for(|| actor.applied_sequence() == 21);
    let expected = ActorEvent::Queries {
        sequence: 21,
        queries: vec![DetectedQuery::CursorPosition { row: 5, col: 1 }],
    };
    assert_eq!(events.lock().unwrap().last(), Some(&expected));
}

#[test]
fn serializing_a_copy_never_blocks_feeding() {
    let (actor, _) = spawn(ScreenActorConfig::new(80, 24));
    for sequence in 1..=500 {
        assert_eq!(
            actor.try_feed(sequence, chunk(sequence), soon()),
            FeedOutcome::Queued
        );
    }
    let copy = actor.snapshot_fenced(soon()).expect("fence");
    // Feeding continues while the copy is held and serialized on another thread.
    let worker = std::thread::spawn(move || copy.serialize(&SnapshotLimits::default()));
    for sequence in 501..=1_000 {
        let started = Instant::now();
        let deadline = started + Duration::from_millis(50);
        assert_eq!(
            actor.try_feed(sequence, chunk(sequence), deadline),
            FeedOutcome::Queued
        );
        assert!(started.elapsed() < Duration::from_millis(50));
    }
    let snapshot = worker.join().unwrap().expect("serialize");
    assert_eq!(snapshot.through_sequence, 500);
    assert!(snapshot.ansi.contains("line 500") && !snapshot.ansi.contains("line 501"));
    assert_eq!(actor.state(), ModelState::Live);
}

#[test]
fn a_stalled_actor_invalidates_the_model_within_the_deadline() {
    let mut config = ScreenActorConfig::new(20, 5);
    config.queue_messages = 2;
    let (actor, events) = spawn(config);
    let (release, stalled) = mpsc::channel::<()>();
    actor.inspect(Box::new(move |_| {
        let _ = stalled.recv();
    }));
    let mut outcome = FeedOutcome::Queued;
    let started = Instant::now();
    for sequence in 1..=4 {
        outcome = actor.try_feed(
            sequence,
            chunk(sequence),
            Instant::now() + Duration::from_millis(50),
        );
        if outcome != FeedOutcome::Queued {
            break;
        }
    }
    assert_eq!(outcome, FeedOutcome::Invalid);
    assert!(
        started.elapsed() < Duration::from_millis(400),
        "reader never blocks past its deadline"
    );
    assert_eq!(actor.try_feed(5, chunk(5), soon()), FeedOutcome::Invalid);
    assert_eq!(
        actor.snapshot_fenced(soon()).err(),
        Some(FenceError::Invalid)
    );
    release.send(()).unwrap();
    wait_for(|| !events.lock().unwrap().is_empty());
    let expected = ActorEvent::ModelInvalid {
        reason: InvalidReason::FeedTimeout,
    };
    assert_eq!(events.lock().unwrap().first(), Some(&expected));
}

#[test]
fn gaps_and_panics_invalidate_without_affecting_the_caller() {
    let (actor, events) = spawn(ScreenActorConfig::new(20, 5));
    assert_eq!(actor.try_feed(1, chunk(1), soon()), FeedOutcome::Queued);
    assert_eq!(actor.try_feed(3, chunk(3), soon()), FeedOutcome::Invalid);
    wait_for(|| !events.lock().unwrap().is_empty());
    let gap = InvalidReason::SequenceGap {
        expected: 2,
        actual: 3,
    };
    assert_eq!(
        events.lock().unwrap().first(),
        Some(&ActorEvent::ModelInvalid { reason: gap })
    );

    let (actor, events) = spawn(ScreenActorConfig::new(20, 5));
    actor.inspect(Box::new(|_| std::panic::panic_any("injected screen panic")));
    wait_for(|| !events.lock().unwrap().is_empty());
    let panic = ActorEvent::ModelInvalid {
        reason: InvalidReason::Panic,
    };
    assert_eq!(events.lock().unwrap().first(), Some(&panic));
    assert_eq!(actor.state(), ModelState::Invalid);
}

/// Feeds `1..=through`, then skips one chunk; returns the newest sequence fed.
fn invalidate(actor: &ScreenActor, through: u64) -> u64 {
    for sequence in 1..=through {
        let _ = actor.try_feed(sequence, chunk(sequence), soon());
    }
    let _ = actor.try_feed(through + 2, chunk(through + 2), soon());
    wait_for(|| actor.state() == ModelState::Invalid);
    through + 2
}

#[test]
fn rebuild_replays_the_ring_then_buffered_live_output_exactly_once() {
    let (actor, events) = spawn(ScreenActorConfig::new(40, 6));
    let newest = invalidate(&actor, 30);
    assert_eq!(
        actor.begin_rebuild(newest - 1).err(),
        Some(RebuildError::RingBehindFeed { accepted: newest })
    );
    let ticket = actor.begin_rebuild(40).expect("begin");
    let ring: Vec<(u64, Vec<u8>)> = (1..=40).map(|s| (s, chunk(s))).collect();
    let actor = Arc::new(actor);
    let live = {
        let actor = Arc::clone(&actor);
        std::thread::spawn(move || {
            for sequence in 35..=120 {
                let _ = actor.try_feed(sequence, chunk(sequence), soon());
            }
        })
    };
    actor.submit_rebuild(ticket, ring, true).expect("submit");
    live.join().unwrap();
    wait_for(|| actor.applied_sequence() == 120);
    let copy = actor.snapshot_fenced(soon()).expect("fence");
    let mut reference = ScreenModel::new(40, 6, 1_000).unwrap();
    for sequence in 1..=120 {
        let _ = reference.feed(&chunk(sequence));
    }
    let snapshot = copy
        .serialize(&SnapshotLimits::default())
        .expect("serialize");
    let mut rebuilt = ScreenModel::new(40, 6, 1_000).unwrap();
    let _ = rebuilt.feed(snapshot.ansi.as_bytes());
    assert!(
        diff(&dump(&reference), &dump(&rebuilt)).is_empty(),
        "no chunk applied twice or skipped"
    );
    let rebuilt_event = events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, ActorEvent::Rebuilt { partial: false, .. }));
    assert!(rebuilt_event);
}

#[test]
fn rebuild_buffer_overflow_stays_invalid_until_the_retry_delay() {
    let mut config = ScreenActorConfig::new(40, 6);
    config.rebuild_buffer_bytes = 64;
    let (actor, _) = spawn(config);
    let newest = invalidate(&actor, 5);
    let ticket = actor.begin_rebuild(newest).expect("begin");
    for sequence in newest + 1..=20 {
        let _ = actor.try_feed(sequence, chunk(sequence), soon());
    }
    let ring = (1..=newest).map(|s| (s, chunk(s))).collect();
    actor.submit_rebuild(ticket, ring, false).expect("submit");
    wait_for(|| actor.state() == ModelState::Invalid);
    assert!(matches!(
        actor.begin_rebuild(20),
        Err(RebuildError::TooSoon(_))
    ));
}

#[test]
fn partial_rings_mark_the_model_partial() {
    let (actor, _) = spawn(ScreenActorConfig::new(40, 6));
    let newest = invalidate(&actor, 10);
    let ticket = actor.begin_rebuild(newest).expect("begin");
    let ring = (6..=newest).map(|s| (s, chunk(s))).collect();
    actor.submit_rebuild(ticket, ring, false).expect("submit");
    wait_for(|| actor.state() == ModelState::Live);
    let snapshot = actor
        .snapshot_fenced(soon())
        .expect("fence")
        .serialize(&SnapshotLimits::default());
    assert_eq!(
        snapshot.expect("serialize").fidelity.fidelity.as_str(),
        "partial"
    );
}

#[test]
fn stop_rejects_new_work() {
    let (actor, _) = spawn(ScreenActorConfig::new(20, 5));
    actor.stop();
    assert_eq!(actor.try_feed(1, chunk(1), soon()), FeedOutcome::Stopped);
    assert_eq!(
        actor.snapshot_fenced(soon()).err(),
        Some(FenceError::Stopped)
    );
    actor.join();
}

#[test]
fn a_panicking_event_sink_does_not_stop_the_actor() {
    let sink = Box::new(|_event: ActorEvent| std::panic::panic_any("sink panic"));
    let actor = ScreenActor::spawn(ScreenActorConfig::new(20, 5), sink).expect("spawn");
    assert_eq!(
        actor.try_feed(1, b"\x1b[6n".to_vec(), soon()),
        FeedOutcome::Queued
    );
    assert_eq!(actor.try_feed(2, chunk(2), soon()), FeedOutcome::Queued);
    let copy = actor
        .snapshot_fenced(soon())
        .expect("actor still answers fences");
    assert_eq!(copy.through_sequence(), 2);
    assert_eq!(actor.state(), ModelState::Live);
}
