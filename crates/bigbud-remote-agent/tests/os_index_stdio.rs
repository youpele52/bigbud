//! Real agent process over stdio: `os-index.search` is advertised and served only with
//! `--ephemeral --os-index` (the desktop-embedded local agent); every other mode refuses it.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::BufReader;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1, write_frame,
};

fn scratch_home() -> std::path::PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "bigbud-os-index-stdio-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(path.join("Documents")).unwrap();
    // Canonical, so containment checks compare like with like (`/var` vs `/private/var`).
    std::fs::canonicalize(path).unwrap()
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

fn start_agent(args: &[&str], home: &std::path::Path) -> (Child, BufReader<ChildStdout>, bool) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bigbud-remote-agent"))
        .args(args)
        .env("HOME", home)
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
            client_instance_id: "os-index-test".to_owned(),
            connection_id: "connection-1".to_owned(),
            server_nonce: "nonce-1".to_owned(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
        }),
    );
    let v1::frame::Payload::AgentHello(hello) = next(&mut reader) else {
        panic!("expected agent hello");
    };
    let advertised = hello
        .capabilities
        .iter()
        .any(|capability| capability.name == "os-index.search" && capability.major == 1);
    (child, reader, advertised)
}

fn request(operation_id: &str) -> v1::frame::Payload {
    v1::frame::Payload::OsIndexSearchRequest(v1::OsIndexSearchRequest {
        request_id: format!("request-{operation_id}"),
        operation_id: operation_id.to_owned(),
        query: "bigbud-unlikely-name-zzqqxx".to_owned(),
        scope_level: v1::OsIndexScopeLevel::CommonFolders as i32,
        max_results: 50,
        deadline_ms: 2_000,
    })
}

/// Reads frames until the completion for `operation_id`, returning the hits seen first.
fn finish(
    reader: &mut BufReader<ChildStdout>,
    operation_id: &str,
) -> (Vec<v1::OsIndexSearchHit>, v1::OsIndexSearchCompleted) {
    let mut hits = Vec::new();
    loop {
        match next(reader) {
            v1::frame::Payload::OsIndexSearchBatch(batch) if batch.operation_id == operation_id => {
                hits.extend(batch.hits);
            }
            v1::frame::Payload::OsIndexSearchCompleted(done)
                if done.operation_id == operation_id =>
            {
                return (hits, done);
            }
            v1::frame::Payload::CancelResponse(_) => {}
            other => panic!("unexpected frame {other:?}"),
        }
    }
}

#[test]
fn plain_ephemeral_agents_neither_advertise_nor_serve_os_index_search() {
    let home = scratch_home();
    let (mut child, mut reader, advertised) = start_agent(&["--ephemeral"], &home);
    assert!(!advertised);
    send(&mut child, request("plain-1"));
    let (hits, done) = finish(&mut reader, "plain-1");
    assert!(hits.is_empty());
    assert_eq!(done.stop_reason, "error");
    assert_eq!(done.error_code, "UNSUPPORTED");
    child.kill().unwrap();
    let _ = child.wait();
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn desktop_agent_serves_os_index_search_inside_the_scope_and_accepts_cancel() {
    let home = scratch_home();
    let (mut child, mut reader, advertised) = start_agent(&["--ephemeral", "--os-index"], &home);
    assert!(advertised);
    send(&mut child, request("desktop-1"));
    let (hits, done) = finish(&mut reader, "desktop-1");
    if cfg!(target_os = "macos") {
        assert_eq!(done.source, "spotlight");
        assert!(
            done.error_code.is_empty() || done.error_code == "UNAVAILABLE",
            "{done:?}"
        );
    } else {
        assert_eq!(done.error_code, "UNSUPPORTED");
    }
    let scope = home.join("Documents");
    assert!(
        hits.iter()
            .all(|hit| std::path::Path::new(&hit.path).starts_with(&scope))
    );

    send(&mut child, request("desktop-2"));
    send(
        &mut child,
        v1::frame::Payload::CancelRequest(v1::CancelRequest {
            request_id: "cancel-1".to_owned(),
            operation_id: "desktop-2".to_owned(),
        }),
    );
    // Exactly one completion follows whether the cancel or the answer won the race.
    let (_, done) = finish(&mut reader, "desktop-2");
    assert!(
        ["cancelled", "complete", "deadline", "error"].contains(&done.stop_reason.as_str()),
        "{done:?}"
    );
    child.kill().unwrap();
    let _ = child.wait();
    std::fs::remove_dir_all(home).unwrap();
}
