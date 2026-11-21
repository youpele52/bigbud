//! A full stream window pauses producers instead of dropping the peer, and drains resume them.

use super::super::budget;
use super::super::*;
use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, read_frame};

fn output(size: usize) -> v1::Frame {
    v1::Frame {
        payload: Some(v1::frame::Payload::PtyOutput(v1::PtyOutput {
            pty_id: "flow".to_owned(),
            sequence: 1,
            bytes: vec![b'x'; size],
        })),
    }
}

#[test]
fn a_full_window_waits_without_cancelling_and_resumes_when_the_peer_reads() {
    let (stream, mut peer) = UnixStream::pair().unwrap();
    let writer = OutboundWriter::start(stream).unwrap();
    let frame = output(16 * 1024);
    let room = 16 * 1024 + 512;
    let mut queued = 0;
    // The peer reads nothing: fill the socket buffer and then the 256 KiB window.
    while writer.wait_stream_room(room, Instant::now() + Duration::from_millis(50)) {
        let encoded = budget::encode(&frame, BYTE_LIMIT - 4).unwrap();
        writer
            .enqueue_stream_waiting(encoded, Instant::now() + Duration::from_secs(1))
            .unwrap();
        queued += 1;
        assert!(queued < 1000, "the window never filled");
    }
    assert!(!writer.is_closed(), "a paused peer keeps its connection");
    let before = writer.written_frames();
    std::thread::sleep(Duration::from_millis(300));
    assert!(!writer.is_closed());
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let reader = std::thread::spawn(move || {
        let mut frames = 0;
        while frames < queued + 1 {
            if read_frame(&mut peer, DEFAULT_MAX_FRAME_BYTES)
                .unwrap()
                .is_none()
            {
                break;
            }
            frames += 1;
        }
        frames
    });
    assert!(writer.wait_stream_room(room, Instant::now() + Duration::from_secs(5)));
    let encoded = budget::encode(&frame, BYTE_LIMIT - 4).unwrap();
    writer
        .enqueue_stream_waiting(encoded, Instant::now() + Duration::from_secs(5))
        .unwrap();
    assert_eq!(reader.join().unwrap(), queued + 1, "every frame arrives");
    assert!(writer.written_frames() > before);
    assert!(!writer.is_closed());
    writer.join().unwrap();
}
