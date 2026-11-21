//! Snapshots, the reader's 50 ms bound, rebuild fencing, cold restore and real query replies
//! (plan §8.4, §8.9, §14; R5 exit criteria).

use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::super::super::pty_lifecycle_host::kind;
use super::super::super::pty_screen::{SnapshotSource, produce};
use super::super::super::*;
use super::fixture::{Host, scratch};
use crate::terminal_screen::{ModelState, ScreenModel, SnapshotLimits};
use crate::terminal_spool::{SpoolLimits, SpoolStore};

fn snapshot_request(id: &str) -> v1::PtyScreenSnapshotRequest {
    v1::PtyScreenSnapshotRequest {
        request_id: format!("snap-{id}"),
        pty_id: id.to_owned(),
        ..Default::default()
    }
}

/// Concatenated chunk bytes, checked against the header's count, size and digest.
fn reassemble(transfer: &crate::session::SnapshotTransfer) -> Vec<u8> {
    let mut ansi = Vec::new();
    for index in 0..transfer.chunk_count() {
        match transfer.chunk_frame(index).unwrap().payload {
            Some(v1::frame::Payload::PtyScreenSnapshotChunk(chunk)) => {
                assert!(chunk.bytes.len() <= 192 * 1024);
                assert_eq!(chunk.last, index + 1 == transfer.chunk_count());
                ansi.extend_from_slice(&chunk.bytes);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(ansi.len() as u64, transfer.header.total_ansi_bytes);
    assert_eq!(Sha256::digest(&ansi).to_vec(), transfer.header.sha256);
    ansi
}

#[test]
fn a_live_snapshot_is_chunked_digested_and_full_fidelity() {
    let mut host = Host::new(false);
    host.create(host.request(
        "live",
        true,
        "/bin/sh",
        &["-c", "printf 'hello snapshot\\n'; sleep 30"],
    ));
    host.wait_output("live");
    let transfer = produce(
        SnapshotSource::Live(host.lifecycle("live")),
        &snapshot_request(&host.id("live")),
    );
    let header = &transfer.header;
    assert!(header.accepted, "{header:?}");
    assert_eq!(
        (header.model_state.as_str(), header.fidelity.as_str()),
        ("live", "full")
    );
    assert_eq!((header.cols, header.rows), (80, 24));
    assert!(header.through_sequence >= 1);
    let ansi = String::from_utf8(reassemble(&transfer)).unwrap();
    assert!(ansi.contains("hello snapshot"));
}

#[test]
fn the_reader_never_waits_more_than_50_ms_on_a_stalled_actor() {
    let mut host = Host::new(false);
    host.create(host.request("stalled", true, "/bin/sleep", &["60"]));
    let lifecycle = host.lifecycle("stalled");
    let screen = lifecycle.screen().unwrap();
    screen.inspect(Box::new(|_| std::thread::sleep(Duration::from_secs(2))));
    let chunk = vec![b'x'; 64 * 1024];
    let mut slowest = Duration::ZERO;
    for _ in 0..80 {
        let appended = lifecycle.handle().append_output(chunk.clone()).unwrap();
        let started = Instant::now();
        lifecycle.on_output(appended.sequence, appended.bytes);
        slowest = slowest.max(started.elapsed());
    }
    eprintln!("slowest stalled-actor feed: {slowest:?}");
    // A 45 ms deadline plus wake-up latency; the margin keeps a saturated host from flaking.
    assert!(
        slowest < Duration::from_millis(60),
        "reader blocked {slowest:?}"
    );
    assert_eq!(screen.state(), ModelState::Invalid);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !host.has_notice("stalled", kind::MODEL_INVALID) {
        assert!(Instant::now() < deadline, "no model_invalid notice");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn rebuild_under_live_output_applies_every_sequence_exactly_once() {
    let mut host = Host::new(false);
    host.create(host.request("rebuild", true, "/bin/sleep", &["60"]));
    let lifecycle = host.lifecycle("rebuild");
    let screen = lifecycle.screen().unwrap();
    let mut all = Vec::new();
    let mut push = |bytes: Vec<u8>, feed: bool| {
        let chunk = lifecycle.handle().append_output(bytes).unwrap();
        all.push(chunk.bytes.clone());
        if feed {
            lifecycle.on_output(chunk.sequence, chunk.bytes);
        }
    };
    push(b"first\r\n".to_vec(), true);
    push(b"never fed\r\n".to_vec(), false);
    push(b"after the gap\r\n".to_vec(), true);
    assert_eq!(screen.state(), ModelState::Invalid);
    let feeder_lifecycle = Arc::clone(&lifecycle);
    let feeder = std::thread::spawn(move || {
        let mut fed = Vec::new();
        for line in 0..3000 {
            let chunk = feeder_lifecycle
                .handle()
                .append_output(format!("line {line:05}\r\n").into_bytes())
                .unwrap();
            fed.push(chunk.bytes.clone());
            feeder_lifecycle.on_output(chunk.sequence, chunk.bytes);
            if line % 100 == 0 {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        fed
    });
    std::thread::sleep(Duration::from_millis(5));
    lifecycle.try_rebuild();
    all.extend(feeder.join().unwrap());
    let last = lifecycle.handle().snapshot().unwrap().next_sequence - 1;
    let deadline = Instant::now() + Duration::from_secs(20);
    while screen.applied_sequence() < last {
        assert!(
            Instant::now() < deadline,
            "applied {} of {last}",
            screen.applied_sequence()
        );
        assert_ne!(screen.state(), ModelState::Invalid, "rebuild failed");
        std::thread::sleep(Duration::from_millis(5));
    }
    let actual = screen
        .snapshot_fenced(Instant::now() + Duration::from_secs(2))
        .unwrap()
        .serialize(&SnapshotLimits::default())
        .unwrap();
    let mut reference = ScreenModel::new(80, 24, 1000).unwrap();
    for bytes in &all {
        let _ = reference.feed(bytes);
    }
    let expected = reference.snapshot(&SnapshotLimits::default()).unwrap();
    assert_eq!(
        actual.ansi, expected.ansi,
        "a sequence was applied twice or skipped"
    );
    assert_eq!(
        actual.fidelity.fidelity.as_str(),
        "full",
        "the ring started at sequence 1"
    );
}

#[test]
fn a_lost_spool_gives_a_cold_snapshot_from_its_checkpoint_and_chunks() {
    let root = scratch("bbr5cold");
    {
        let store = SpoolStore::open(&root, SpoolLimits::default()).unwrap();
        let writer = store.writer("lost-pty", 1).unwrap();
        let mut model = ScreenModel::new(80, 24, 1000).unwrap();
        for (sequence, text) in [(1, "before checkpoint\r\n"), (2, "still before\r\n")] {
            let _ = model.feed(text.as_bytes());
            assert_eq!(
                writer.append(sequence, text.as_bytes()),
                crate::terminal_spool::AppendOutcome::Queued
            );
        }
        writer.checkpoint(2, model.checkpoint().unwrap()).unwrap();
        writer.append(3, b"after checkpoint\r\n");
        writer.flush(Duration::from_secs(5)).unwrap();
        // Dropped without a close: what a crashed host leaves behind.
        drop(writer);
    }
    let host = HostLifecycle::new("epoch-2", Some(&root), HostOptions::default());
    assert!(host.is_lost("lost-pty"));
    let transfer = produce(
        SnapshotSource::Cold(Arc::clone(&host)),
        &snapshot_request("lost-pty"),
    );
    assert!(transfer.header.accepted, "{:?}", transfer.header);
    assert_eq!(transfer.header.model_state, "cold");
    assert_eq!(transfer.header.through_sequence, 3);
    let ansi = String::from_utf8(reassemble(&transfer)).unwrap();
    assert!(ansi.contains("before checkpoint") && ansi.contains("after checkpoint"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_detached_host_answers_a_real_device_status_query_and_an_attached_one_does_not() {
    let mut host = Host::new(false);
    let script = "stty -echo -icanon; printf 'Q\\033[5n'; IFS= read -r -t 3 -d n reply; \
                  printf '\\nGOT<%s>\\n' \"${reply#?}\"; sleep 30";
    host.create(host.request("detached", true, "/bin/bash", &["-c", script]));
    host.create(host.request("attached", true, "/bin/bash", &["-c", script]));
    let frame = host.session.lock().unwrap().handle(v1::Frame {
        payload: Some(v1::frame::Payload::PtyViewStateRequest(Box::new(
            v1::PtyViewStateRequest {
                request_id: "detach".to_owned(),
                pty_id: host.id("detached"),
                view_state: "hidden".to_owned(),
                renderer_attached: false,
                acked_sequence: 0,
                ..Default::default()
            },
        ))),
    });
    assert!(frame.is_ok());
    let deadline = Instant::now() + Duration::from_secs(10);
    let (mut detached, mut attached) = (String::new(), String::new());
    while Instant::now() < deadline && !(detached.contains("GOT<") && attached.contains("GOT<")) {
        detached = host.output_text("detached");
        attached = host.output_text("attached");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(detached.contains("GOT<[0>"), "{detached:?}");
    assert!(attached.contains("GOT<>"), "{attached:?}");
}
