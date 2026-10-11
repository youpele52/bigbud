use super::*;

#[test]
fn reservation_covers_allocated_frame_until_drop_including_paced_wait_ownership() {
    let frame = v1::Frame {
        payload: Some(v1::frame::Payload::PtyOutput(v1::PtyOutput {
            pty_id: "budget".to_owned(),
            sequence: 1,
            bytes: vec![0; 512 * 1024],
        })),
    };
    // This charge remains attached to the buffer when it moves to a waiting
    // control producer or replay suffix. There is no second payload allocation.
    let before = PROFILE_BYTES.load(Ordering::Acquire);
    let encoded = encode(&frame, 1024 * 1024).unwrap();
    assert!(PROFILE_BYTES.load(Ordering::Acquire) >= encoded.len());
    assert_eq!(encoded.bytes.capacity(), encoded.len());
    drop(encoded);
    // Other tests may own charges concurrently; never assert a global zero.
    assert!(PROFILE_BYTES.load(Ordering::Acquire) <= MAX_BYTES);
    assert!(before <= MAX_BYTES);
}

#[test]
fn oversized_encoding_is_refused_before_any_byte_reservation_or_allocation() {
    let frame = v1::Frame {
        payload: Some(v1::frame::Payload::PtyOutput(v1::PtyOutput {
            pty_id: "oversized".to_owned(),
            sequence: 1,
            bytes: vec![0; 1024],
        })),
    };
    assert!(encode(&frame, 10).is_err());
}

#[test]
fn allocated_paced_waiters_and_inflight_buffers_share_the_bounded_profile_charge() {
    if std::env::var("BIGBUD_TEST_BUDGET_ISOLATED").is_err() {
        let module = module_path!()
            .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::"))
            .unwrap();
        let _gate = crate::spawn_gate::lock().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &format!("{module}::allocated_paced_waiters_and_inflight_buffers_share_the_bounded_profile_charge"), "--nocapture"])
            .env("BIGBUD_TEST_BUDGET_ISOLATED", "1").status().unwrap();
        assert!(status.success());
        return;
    }
    let frame = v1::Frame {
        payload: Some(v1::frame::Payload::PtyOutput(v1::PtyOutput {
            pty_id: "budget".into(),
            sequence: 1,
            bytes: vec![0; 512 * 1024],
        })),
    };
    let size = encoded_frame_length(&frame, 1024 * 1024).unwrap();
    let (socket, peer) = std::os::unix::net::UnixStream::pair().unwrap();
    let writer = super::super::OutboundWriter::start(socket).unwrap();
    writer.enqueue_response(&frame).unwrap();
    let queued = v1::Frame {
        payload: Some(v1::frame::Payload::PtyOutput(v1::PtyOutput {
            pty_id: "queued".into(),
            sequence: 2,
            bytes: vec![0; 64 * 1024],
        })),
    };
    let queued_size = encoded_frame_length(&queued, 1024 * 1024).unwrap();
    writer.enqueue_response(&queued).unwrap();
    let waiting = std::sync::Arc::clone(&writer);
    let waiter = std::thread::spawn(move || {
        waiting.enqueue_response(&frame)?;
        waiting.enqueue_response(&frame)
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while PROFILE_BYTES.load(Ordering::Acquire) < size * 2 + queued_size
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(
        PROFILE_BYTES.load(Ordering::Acquire),
        size * 2 + queued_size,
        "one native write, one queued reply and one paced waiter must all retain credit"
    );
    drop(peer);
    assert!(waiter.join().unwrap().is_err());
    writer.join().unwrap();
    assert_eq!(PROFILE_BYTES.load(Ordering::Acquire), 0);
    let frame = v1::Frame {
        payload: Some(v1::frame::Payload::PtyOutput(v1::PtyOutput {
            pty_id: "profile".into(),
            sequence: 1,
            bytes: vec![0; 64 * 1024],
        })),
    };
    let mut retained = Vec::new();
    while let Ok(buffer) = encode(&frame, 1024 * 1024) {
        retained.push(buffer);
    }
    let sum = retained.iter().map(EncodedFrame::len).sum::<usize>();
    assert_eq!(PROFILE_BYTES.load(Ordering::Acquire), sum);
    assert!(sum <= MAX_BYTES);
    assert!(sum + encoded_frame_length(&frame, 1024 * 1024).unwrap() > MAX_BYTES);
    drop(retained);
    assert_eq!(PROFILE_BYTES.load(Ordering::Acquire), 0);
}
