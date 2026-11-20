//! Real agent process over stdio: streaming search, cancellation while the walk runs, and the
//! frame reader staying responsive (search runs on a worker, not the frame thread).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::BufReader;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1, write_frame,
};

fn scratch_dir() -> std::path::PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "bigbud-search-stdio-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn send(child: &mut Child, payload: v1::frame::Payload) {
    let frame = v1::Frame {
        payload: Some(payload),
    };
    write_frame(
        child.stdin.as_mut().unwrap(),
        &frame,
        DEFAULT_MAX_FRAME_BYTES,
    )
    .unwrap();
}

fn next(reader: &mut BufReader<ChildStdout>) -> v1::frame::Payload {
    read_frame(reader, DEFAULT_MAX_FRAME_BYTES)
        .unwrap()
        .expect("agent frame")
        .payload
        .expect("frame payload")
}

fn start_agent() -> (Child, BufReader<ChildStdout>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bigbud-remote-agent"))
        .arg("--ephemeral")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    send(
        &mut child,
        v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: "search-test".to_owned(),
            connection_id: "connection-1".to_owned(),
            server_nonce: "nonce-1".to_owned(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
        }),
    );
    let v1::frame::Payload::AgentHello(hello) = next(&mut reader) else {
        panic!("expected agent hello");
    };
    assert!(
        hello
            .capabilities
            .iter()
            .any(|capability| capability.name == "workspace.search-stream" && capability.major == 1)
    );
    (child, reader)
}

fn search_request(root: &std::path::Path, query: &str, operation_id: &str) -> v1::frame::Payload {
    v1::frame::Payload::WorkspaceSearchRequest(v1::WorkspaceSearchRequest {
        request_id: format!("request-{operation_id}"),
        operation_id: operation_id.to_owned(),
        roots: vec![v1::WorkspaceSearchRoot {
            root_id: "root-1".to_owned(),
            root: root.to_string_lossy().into_owned(),
            relative_path: String::new(),
        }],
        query: query.to_owned(),
        mode: v1::WorkspaceSearchMode::Both as i32,
        deadline_ms: 10_000,
        ..Default::default()
    })
}

#[test]
fn streams_batches_then_exactly_one_completion() {
    let root = scratch_dir();
    for index in 0..150 {
        std::fs::write(root.join(format!("needle-{index}.txt")), "a needle\n").unwrap();
    }
    let (mut child, mut reader) = start_agent();
    send(&mut child, search_request(&root, "needle", "search-1"));
    let mut sequence = 0;
    let (mut names, mut contents) = (0, 0);
    let completed = loop {
        match next(&mut reader) {
            v1::frame::Payload::WorkspaceSearchBatch(batch) => {
                assert_eq!(batch.sequence, sequence + 1, "sequences are monotonic");
                sequence = batch.sequence;
                names += batch.names.len();
                contents += batch.contents.len();
            }
            v1::frame::Payload::WorkspaceSearchCompleted(completed) => break completed,
            other => panic!("unexpected frame {other:?}"),
        }
    };
    assert_eq!(completed.stop_reason, "complete");
    assert_eq!(completed.batches, sequence);
    assert_eq!((names, contents), (150, 150));
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    let _removed = std::fs::remove_dir_all(root);
}

#[test]
fn cancel_is_read_and_answered_while_a_search_is_walking() {
    let root = scratch_dir();
    let body = "nothing to find on this line\n".repeat(150);
    for index in 0..8_000 {
        let directory = root.join(format!("d{}", index % 64));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(format!("f{index}.txt")), &body).unwrap();
    }
    let (mut child, mut reader) = start_agent();
    send(
        &mut child,
        search_request(&root, "zz-never-present", "search-2"),
    );
    send(
        &mut child,
        v1::frame::Payload::CancelRequest(v1::CancelRequest {
            request_id: "cancel-1".to_owned(),
            operation_id: "search-2".to_owned(),
        }),
    );
    let mut cancel_seen = None;
    let completed = loop {
        match next(&mut reader) {
            v1::frame::Payload::CancelResponse(response) => cancel_seen = Some(response.cancelled),
            v1::frame::Payload::WorkspaceSearchCompleted(completed) => break completed,
            v1::frame::Payload::WorkspaceSearchBatch(_) => {}
            other => panic!("unexpected frame {other:?}"),
        }
    };
    // Before the fix the frame loop ran the walk itself, so the cancel could only be read after
    // the completion. Now the cancel is answered first and stops the walk.
    assert_eq!(
        cancel_seen,
        Some(true),
        "cancel answered before the search completed"
    );
    assert_eq!(completed.stop_reason, "cancelled");
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    let _removed = std::fs::remove_dir_all(root);
}
