use super::*;
use std::io::Write;
use std::thread;

#[test]
fn socket_no_hello_prefix_and_payload_deadlines_do_not_reset_on_progress() {
    for prefix in [vec![], vec![0, 0], vec![0, 0, 0, 32, 1, 2]] {
        let (server, mut peer) = UnixStream::pair().unwrap();
        peer.write_all(&prefix).unwrap();
        let mut reader = FrameReader::with_timeout(server, Duration::from_millis(100));
        let began = Instant::now();
        assert!(reader.next(false).is_err());
        assert!(began.elapsed() < Duration::from_secs(1));
    }
}

#[test]
fn established_idle_socket_remains_valid_beyond_incomplete_frame_timeout() {
    let (server, mut peer) = UnixStream::pair().unwrap();
    let worker = thread::spawn(move || {
        FrameReader::with_timeout(server, Duration::from_millis(50)).next(true)
    });
    thread::sleep(Duration::from_millis(150));
    let frame = v1::Frame {
        payload: Some(v1::frame::Payload::PtyResizeRequest(v1::PtyResizeRequest {
            request_id: "still-idle".to_owned(),
            pty_id: "synthetic".to_owned(),
            cols: 80,
            rows: 24,
        })),
    };
    bigbud_protocol::write_frame(&mut peer, &frame, DEFAULT_MAX_FRAME_BYTES).unwrap();
    assert_eq!(worker.join().unwrap().unwrap(), Some(frame));
}
