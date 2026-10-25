#![allow(clippy::unwrap_used, clippy::panic)]
use bigbud_protocol::{DEFAULT_MAX_FRAME_BYTES, read_frame, v1, write_frame};
use std::fs;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(super) fn lib_test_filter(name: &str) -> String {
    let module = module_path!()
        .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::"))
        .unwrap();
    format!("{module}::{name}")
}
pub(super) fn temp_root(_label: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    // macOS temp paths exceed sockaddr_un's 104-byte ceiling with test labels.
    fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .unwrap()
        .join("target")
        .join(format!("pty-{}-{suffix}", std::process::id()))
}
pub(super) fn wait_for_socket(socket: &Path) {
    for _ in 0..200 {
        // bind creates the filesystem entry before listen is ready on macOS.
        if UnixStream::connect(socket).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("supervisor socket unavailable");
}
pub(super) fn wait_for_exit(child: &mut Child) {
    for _ in 0..200 {
        if child.try_wait().unwrap().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("supervisor did not exit");
}
pub(super) fn write_request(stream: &mut UnixStream, payload: v1::frame::Payload) {
    write_frame(
        stream,
        &v1::Frame {
            payload: Some(payload),
        },
        DEFAULT_MAX_FRAME_BYTES,
    )
    .unwrap();
}
pub(super) fn read_until(
    stream: &mut UnixStream,
    matches: impl Fn(&v1::frame::Payload) -> bool,
) -> v1::frame::Payload {
    loop {
        let payload = read_frame(stream, DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .unwrap()
            .payload
            .unwrap();
        if matches(&payload) {
            return payload;
        }
    }
}
#[test]
fn real_supervisor_helper() {
    let Ok(root) = std::env::var("BIGBUD_TEST_REAL_SUPERVISOR_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let session = crate::AgentSession::with_epoch_and_journal(
        "real-supervisor-test",
        root.join("operations.journal"),
    )
    .unwrap();
    crate::supervisor::run_supervisor(session, &root.join("supervisor.sock")).unwrap();
    let _ = fs::remove_dir_all(root);
}
