use super::*;
use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, read_frame};

fn frame(size: usize) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::PtyOutput(v1::PtyOutput {
            pty_id: "synthetic".to_owned(),
            sequence: 1,
            bytes: vec![b'x'; size],
        })),
    }
}

#[test]
fn slow_socket_admission_is_bounded_and_does_not_block_another_writer() {
    let (slow_stream, slow_peer) = UnixStream::pair().unwrap();
    let slow = OutboundWriter::start(slow_stream).unwrap();
    let (healthy_stream, mut healthy_peer) = UnixStream::pair().unwrap();
    healthy_peer
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let healthy = OutboundWriter::start(healthy_stream).unwrap();
    let start = Instant::now();
    let output = frame(16 * 1024);
    let mut rejected = false;
    for _ in 0..256 {
        if slow.enqueue(&output).is_err() {
            rejected = true;
            break;
        }
    }
    assert!(rejected);
    assert!(slow.is_closed());
    healthy.enqueue(&frame(3)).unwrap();
    assert!(
        read_frame(&mut healthy_peer, DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .is_some()
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    slow.join().unwrap();
    healthy.join().unwrap();
    drop(slow_peer);
}

#[test]
fn duplicate_subscribers_and_connection_cleanup_are_bounded() {
    use crate::supervisor::core::io_helpers::{add_subscriber, remove_connection};
    let subscribers = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let (stream, _peer) = UnixStream::pair().unwrap();
    let writer = OutboundWriter::start(stream).unwrap();
    for _ in 0..1000 {
        add_subscriber(&subscribers, "pty", Arc::clone(&writer)).unwrap();
    }
    assert_eq!(subscribers.lock().unwrap().get("pty").unwrap().len(), 1);
    remove_connection(&subscribers, &writer).unwrap();
    assert!(subscribers.lock().unwrap().is_empty());
    writer.join().unwrap();
}

#[test]
fn legacy_large_replay_frames_are_paced_and_drained_before_connection_close() {
    let (stream, mut peer) = UnixStream::pair().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let writer = OutboundWriter::start(stream).unwrap();
    let reader = std::thread::spawn(move || {
        for _ in 0..8 {
            let response = read_frame(&mut peer, DEFAULT_MAX_FRAME_BYTES)
                .unwrap()
                .unwrap();
            assert!(
                matches!(response.payload, Some(v1::frame::Payload::PtyOutput(value)) if value.bytes.len() == 512 * 1024)
            );
        }
    });
    for _ in 0..8 {
        writer.enqueue_response(&frame(512 * 1024)).unwrap();
    }
    writer.drain().unwrap();
    reader.join().unwrap();
    writer.join().unwrap();
}

#[test]
fn expired_native_drain_cancels_queued_and_inflight_frames_and_joins_worker() {
    let (stream, _nonreading_peer) = UnixStream::pair().unwrap();
    let writer = OutboundWriter::start(stream).unwrap();
    writer.enqueue_response(&frame(900 * 1024)).unwrap();
    assert_eq!(
        writer.drain_until(Instant::now()).unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
    writer.cancel();
    writer.join().unwrap();
    assert!(writer.is_closed() && writer.worker_joined());
    let queue = writer.shared.queue.lock().unwrap();
    assert!(queue.frames.is_empty());
    assert_eq!((queue.bytes, queue.items), (0, 0));
}
