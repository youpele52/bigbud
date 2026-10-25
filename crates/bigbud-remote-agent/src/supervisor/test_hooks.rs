#![allow(clippy::unwrap_used)]

use std::path::PathBuf;
use std::time::Duration;

pub(super) fn after_restart_seal(
    writer: &super::Writer,
) -> Vec<super::writer::budget::EncodedFrame> {
    barrier("BIGBUD_TEST_SHUTDOWN_SEAL_BARRIER", "sealed");
    if let Ok(root) = std::env::var("BIGBUD_TEST_SHUTDOWN_SEAL_BARRIER") {
        let root = PathBuf::from(root);
        if root.join("lost-requester").exists() {
            writer.cancel();
        }
        if root.join("encoded-budget").exists() {
            let mut held = Vec::new();
            for size in [bigbud_protocol::DEFAULT_MAX_FRAME_BYTES - 20, 0] {
                let frame = bigbud_protocol::v1::Frame {
                    payload: Some(bigbud_protocol::v1::frame::Payload::PtyOutput(
                        bigbud_protocol::v1::PtyOutput {
                            bytes: vec![0; size],
                            ..Default::default()
                        },
                    )),
                };
                while let Ok(encoded) =
                    super::writer::budget::encode(&frame, bigbud_protocol::DEFAULT_MAX_FRAME_BYTES)
                {
                    held.push(encoded);
                }
            }
            std::fs::write(root.join("profile-exhausted"), b"reserved").unwrap();
            return held;
        }
    }
    Vec::new()
}

pub(super) fn shutdown_drain_result(result: std::io::Result<()>) -> std::io::Result<()> {
    let Ok(root) = std::env::var("BIGBUD_TEST_SHUTDOWN_SEAL_BARRIER") else {
        return result;
    };
    let root = PathBuf::from(root);
    for (name, kind) in [
        ("failed-drain", std::io::ErrorKind::BrokenPipe),
        ("expired-drain", std::io::ErrorKind::TimedOut),
    ] {
        // The first registered writer is the established sibling, not the
        // shutdown requester. Inject the drain outcome, not the exit path.
        if root.join(name).exists() && !root.join("drain-failed").exists() {
            std::fs::write(root.join("drain-failed"), name).unwrap();
            return Err(kind.into());
        }
    }
    result
}

pub(super) fn shutdown_writers_disposed(writers: &[super::Writer]) {
    if let Ok(root) = std::env::var("BIGBUD_TEST_SHUTDOWN_SEAL_BARRIER") {
        assert!(
            writers
                .iter()
                .all(|writer| writer.is_closed() && writer.worker_joined())
        );
        assert_eq!(super::writer::OutboundWriter::retained_encoded_bytes(), 0);
        std::fs::write(PathBuf::from(root).join("disposed"), b"closed-and-joined").unwrap();
    }
}

pub(super) fn wait_before_process_spawn(operation_id: &str) {
    let Ok(root) = std::env::var("BIGBUD_TEST_PROCESS_SPAWN_BARRIER") else {
        return;
    };
    let root = PathBuf::from(root);
    std::fs::write(root.join("accepted"), operation_id).unwrap();
    while !root.join("release").exists() {
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub(super) fn replay_barrier(id: &str, index: usize) {
    if id == "replay-race" && index == 2 {
        barrier("BIGBUD_TEST_REPLAY_BARRIER", id);
    }
}

pub(super) fn completion_barrier(id: &str) {
    if id == "completion-race" {
        barrier("BIGBUD_TEST_COMPLETION_BARRIER", id);
    }
}

fn barrier(variable: &str, id: &str) {
    let Ok(root) = std::env::var(variable) else {
        return;
    };
    let root = PathBuf::from(root);
    std::fs::write(root.join("accepted"), id).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while !root.join("release").exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
}
