//! Real supervisor process: a running search must not block another supervisor connection, nor a
//! file write on its own connection. Before searches ran on connection-owned workers, the walk
//! held the shared session lock and occupied the connection's frame reader until it finished.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1, write_frame,
};

/// Kept short: a Unix socket path must fit `sockaddr_un` (104 bytes on macOS).
fn scratch_dir() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "bbss-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    std::fs::canonicalize(path).unwrap()
}

struct Supervisor {
    child: Child,
    socket: PathBuf,
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        let _killed = self.child.kill();
        let _status = self.child.wait();
    }
}

fn start_supervisor(state: &Path) -> Supervisor {
    let child = Command::new(env!("CARGO_BIN_EXE_bigbud-remote-agent"))
        .arg("--supervisor")
        .env("BIGBUD_AGENT_STATE_DIR", state)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let socket = state.join("supervisor.sock");
    let deadline = Instant::now() + Duration::from_secs(10);
    // bind creates the filesystem entry before listen is ready on macOS, so poll a connect.
    while UnixStream::connect(&socket).is_err() {
        assert!(Instant::now() < deadline, "supervisor socket unavailable");
        std::thread::sleep(Duration::from_millis(10));
    }
    Supervisor { child, socket }
}

fn send(stream: &mut UnixStream, payload: v1::frame::Payload) {
    let frame = v1::Frame {
        payload: Some(payload),
    };
    write_frame(stream, &frame, DEFAULT_MAX_FRAME_BYTES).unwrap();
}

fn next(stream: &mut UnixStream) -> v1::frame::Payload {
    read_frame(stream, DEFAULT_MAX_FRAME_BYTES)
        .unwrap()
        .expect("supervisor frame")
        .payload
        .expect("frame payload")
}

fn connect(supervisor: &Supervisor, connection_id: &str) -> UnixStream {
    let mut stream = UnixStream::connect(&supervisor.socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    send(
        &mut stream,
        v1::frame::Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: "search-supervisor-test".to_owned(),
            connection_id: connection_id.to_owned(),
            server_nonce: format!("nonce-{connection_id}"),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
        }),
    );
    let v1::frame::Payload::AgentHello(_) = next(&mut stream) else {
        panic!("expected agent hello");
    };
    stream
}

/// Opens `root` and writes one file, returning every frame read before the write's response.
fn open_and_write(
    stream: &mut UnixStream,
    label: &str,
    root: &Path,
    path: &str,
) -> Vec<v1::frame::Payload> {
    let handle = format!("workspace-{label}");
    send(
        stream,
        v1::frame::Payload::WorkspaceOpenRequest(v1::WorkspaceOpenRequest {
            request_id: format!("open-{label}"),
            workspace_handle: handle.clone(),
            root: root.to_string_lossy().into_owned(),
        }),
    );
    send(
        stream,
        v1::frame::Payload::WriteFileRequest(v1::WriteFileRequest {
            request_id: format!("write-{label}"),
            operation_id: format!("write-operation-{label}"),
            request_digest: vec![1],
            workspace_handle: handle,
            path: path.to_owned(),
            bytes: label.as_bytes().to_vec(),
            ..Default::default()
        }),
    );
    let mut before = Vec::new();
    loop {
        match next(stream) {
            v1::frame::Payload::WorkspaceOpenResponse(opened) => {
                assert!(opened.accepted, "workspace open refused: {opened:?}");
            }
            v1::frame::Payload::WriteFileResponse(written) => {
                assert!(
                    written.terminal && written.error_code.is_empty(),
                    "{written:?}"
                );
                return before;
            }
            other => before.push(other),
        }
    }
}

#[test]
fn a_running_search_blocks_neither_other_connections_nor_writes_on_its_own() {
    let scratch = scratch_dir();
    let tree = scratch.join("tree");
    let body = "nothing to find on this line\n".repeat(150);
    for index in 0..10_000 {
        let directory = tree.join(format!("d{}", index % 64));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(format!("f{index}.txt")), &body).unwrap();
    }
    let writes = scratch.join("writes");
    std::fs::create_dir_all(&writes).unwrap();
    let supervisor = start_supervisor(&scratch.join("state"));

    let mut searching = connect(&supervisor, "connection-search");
    send(
        &mut searching,
        v1::frame::Payload::WorkspaceSearchRequest(v1::WorkspaceSearchRequest {
            request_id: "request-search".to_owned(),
            operation_id: "search-1".to_owned(),
            roots: vec![v1::WorkspaceSearchRoot {
                root_id: "root-1".to_owned(),
                root: tree.to_string_lossy().into_owned(),
                relative_path: String::new(),
            }],
            query: "zz-never-present".to_owned(),
            mode: v1::WorkspaceSearchMode::Content as i32,
            deadline_ms: 10_000,
            ..Default::default()
        }),
    );

    // Another connection: its hello, workspace open and write all take the session lock.
    let mut other = connect(&supervisor, "connection-other");
    assert!(open_and_write(&mut other, "other", &writes, "other.txt").is_empty());

    // The searching connection's own reader still serves a write while the walk runs.
    let before_write = open_and_write(&mut searching, "own", &writes, "own.txt");
    assert!(
        !before_write
            .iter()
            .any(|frame| matches!(frame, v1::frame::Payload::WorkspaceSearchCompleted(_))),
        "the search finished before the writes were served, so they waited for it"
    );

    send(
        &mut searching,
        v1::frame::Payload::CancelRequest(v1::CancelRequest {
            request_id: "cancel-1".to_owned(),
            operation_id: "search-1".to_owned(),
        }),
    );
    let mut cancelled = None;
    let completed = loop {
        match next(&mut searching) {
            v1::frame::Payload::CancelResponse(response) => cancelled = Some(response.cancelled),
            v1::frame::Payload::WorkspaceSearchCompleted(completed) => break completed,
            v1::frame::Payload::WorkspaceSearchBatch(_) => {}
            other => panic!("unexpected frame {other:?}"),
        }
    };
    // The search was still running after both writes, so the cancel stops it.
    assert_eq!(cancelled, Some(true));
    assert_eq!(completed.stop_reason, "cancelled");
    assert_eq!(std::fs::read(writes.join("other.txt")).unwrap(), b"other");
    assert_eq!(std::fs::read(writes.join("own.txt")).unwrap(), b"own");

    drop(searching);
    drop(other);
    drop(supervisor);
    let _removed = std::fs::remove_dir_all(scratch);
}
