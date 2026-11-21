//! PTY output flow control on a real terminal host (terminal lifecycle R6): floods arrive
//! complete and in order, a client that stops reading throttles the child instead of being
//! dropped, a stalled connection does not hold back another one, and RSS stays bounded.
#![cfg(unix)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreachable,
    clippy::indexing_slicing
)]

#[path = "support/terminal_host.fixture.rs"]
mod fixture;

use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use bigbud_protocol::{
    DEFAULT_MAX_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, read_frame, v1, write_frame,
};
use fixture::{Client, Host, Payload, create_request, scratch, sha256};

/// `lines` deterministic lines. The children run `stty -opost` first, so the tty passes the
/// bytes through unchanged and the received stream must equal the file exactly.
fn flood_file(path: &Path, lines: usize) -> Vec<u8> {
    let mut text = Vec::with_capacity(lines * 80);
    for line in 0..lines {
        text.extend_from_slice(
            format!("line {line:010} the quick brown fox jumps over the lazy dog 0123456789\n")
                .as_bytes(),
        );
    }
    std::fs::write(path, &text).unwrap();
    text
}

/// A client whose socket is read only when the test reads it, so it can really stall.
struct RawClient {
    stream: UnixStream,
}

impl RawClient {
    fn connect(host: &Host, name: &str) -> Self {
        let stream = UnixStream::connect(&host.socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let mut client = Self { stream };
        client.send(Payload::ClientHello(v1::ClientHello {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            client_instance_id: format!("raw-{name}"),
            connection_id: format!("raw-{name}"),
            server_nonce: "nonce".to_owned(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES as u64,
        }));
        assert!(matches!(client.next(), Payload::AgentHello(_)));
        client
    }

    fn send(&mut self, payload: Payload) {
        let frame = v1::Frame {
            payload: Some(payload),
        };
        write_frame(&mut self.stream, &frame, DEFAULT_MAX_FRAME_BYTES).unwrap();
    }

    fn next(&mut self) -> Payload {
        read_frame(&mut self.stream, DEFAULT_MAX_FRAME_BYTES)
            .unwrap()
            .expect("connection open")
            .payload
            .unwrap()
    }
}

/// Collected output of one PTY: bytes, contiguous sequences, and whether it exited.
#[derive(Default)]
struct Output {
    bytes: Vec<u8>,
    last_sequence: u64,
    exited: bool,
}

impl Output {
    fn take(&mut self, pty_id: &str, payload: Payload) {
        match payload {
            Payload::PtyOutput(output) if output.pty_id == pty_id => {
                assert_eq!(
                    output.sequence,
                    self.last_sequence + 1,
                    "sequences stay contiguous"
                );
                self.last_sequence = output.sequence;
                self.bytes.extend_from_slice(&output.bytes);
            }
            Payload::PtyExited(exit) if exit.pty_id == pty_id => self.exited = true,
            Payload::ProtocolError(error) => panic!("{error:?}"),
            _ => {}
        }
    }
}

fn next_sequence(host: &Host, pty_id: &str) -> u64 {
    let mut probe = Client::connect(host, "probe");
    let request_id = probe.request_id("list");
    probe.send(Payload::PtyListRequest(v1::PtyListRequest {
        request_id: request_id.clone(),
        expected_epoch: probe.hello.agent_epoch.clone(),
        limit: 100,
        ..Default::default()
    }));
    match probe.wait_for(|p| matches!(p, Payload::PtyListResponse(r) if r.request_id == request_id))
    {
        Payload::PtyListResponse(list) => list
            .entries
            .iter()
            .find(|entry| entry.pty_id == pty_id)
            .map(|entry| entry.next_sequence)
            .unwrap(),
        _ => unreachable!(),
    }
}

fn rss_mib(host: &Host) -> u64 {
    host.rss_bytes() >> 20
}

#[test]
fn a_flood_arrives_complete_in_order_and_fast_for_unmanaged_and_managed_ptys() {
    let root = scratch();
    let original = flood_file(&root.join("flood.txt"), 720_000); // about 51 MB
    let host = Host::start(&root, &[]);
    for managed in [false, true] {
        let mut client = Client::connect(&host, if managed { "managed" } else { "legacy" });
        client.open_workspace("workspace", &root);
        let id = if managed {
            "flood-managed"
        } else {
            "flood-legacy"
        };
        let script = format!("stty -opost; cat '{}'", root.join("flood.txt").display());
        let mut request = create_request(id, "/bin/sh", &["-c", &script]);
        if !managed {
            // An older client's create: no lifecycle fields at all.
            request.lifecycle_managed = false;
            request.spool = false;
        }
        assert!(client.create(request).accepted);
        let started = Instant::now();
        let mut output = Output::default();
        for frame in std::mem::take(&mut client.backlog) {
            if let Some(payload) = frame.payload {
                output.take(id, payload);
            }
        }
        while !output.exited {
            assert!(
                started.elapsed() < Duration::from_secs(300),
                "flood stalled"
            );
            if let Some(frame) = client.recv(Duration::from_secs(10))
                && let Some(payload) = frame.payload
            {
                output.take(id, payload);
            }
        }
        let elapsed = started.elapsed();
        let rate = output.bytes.len() as f64 / elapsed.as_secs_f64() / 1_000_000.0;
        eprintln!(
            "{id}: {} bytes in {elapsed:?} = {rate:.1} MB/s, {} chunks",
            output.bytes.len(),
            output.last_sequence
        );
        assert_eq!(
            sha256(&output.bytes),
            sha256(&original),
            "every byte, in order"
        );
        // Batched reads: a 1 KiB-per-read macOS flood must still yield large frames (R7).
        assert!(
            output.last_sequence <= (original.len() / (10 * 1024)) as u64,
            "{} frames for {} bytes",
            output.last_sequence,
            original.len()
        );
        if managed {
            let (header, _) = client.snapshot(id);
            assert_eq!(
                header.model_state, "live",
                "the screen model saw every byte"
            );
            assert!(!client.backlog.iter().any(|frame| matches!(&frame.payload,
                Some(Payload::PtyLifecycleNotice(n)) if n.kind == "model_invalid")));
        }
        if !cfg!(debug_assertions) {
            assert!(rate >= 20.0, "{id} reached only {rate:.1} MB/s");
        }
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_client_that_stops_reading_throttles_the_child_and_then_receives_everything() {
    let root = scratch();
    let original = flood_file(&root.join("flood.txt"), 280_000); // about 20 MB
    let host = Host::start(&root, &[]);
    let mut client = RawClient::connect(&host, "stall");
    let request_id = "open".to_owned();
    client.send(Payload::WorkspaceOpenRequest(v1::WorkspaceOpenRequest {
        request_id,
        workspace_handle: "workspace".to_owned(),
        root: root.to_string_lossy().into_owned(),
    }));
    let script = format!("stty -opost; cat '{}'", root.join("flood.txt").display());
    client.send(Payload::PtyCreateRequest(create_request(
        "stall",
        "/bin/sh",
        &["-c", &script],
    )));
    let mut output = Output::default();
    while output.bytes.len() < 1024 * 1024 {
        let payload = client.next();
        output.take("stall", payload);
    }
    // Stop reading. The window fills, then the PTY stops being read.
    let rss_before = rss_mib(&host);
    std::thread::sleep(Duration::from_secs(2));
    let paused_at = next_sequence(&host, "stall");
    std::thread::sleep(Duration::from_secs(3));
    let still = next_sequence(&host, "stall");
    let rss_stalled = rss_mib(&host);
    eprintln!("stalled at sequence {paused_at} -> {still}; RSS {rss_before} -> {rss_stalled} MiB");
    assert_eq!(
        paused_at, still,
        "the PTY is not read while the client stalls"
    );
    assert!(
        (output.bytes.len() as u64) + 4 * 1024 * 1024 < original.len() as u64,
        "the child was throttled, not finished"
    );
    assert!(
        rss_stalled <= rss_before + 16,
        "RSS stays bounded while stalled"
    );
    // Resume: the same connection receives the rest, intact.
    while !output.exited {
        let payload = client.next();
        output.take("stall", payload);
    }
    assert_eq!(sha256(&output.bytes), sha256(&original));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_stalled_connection_does_not_hold_back_another_one_or_other_ptys() {
    let root = scratch();
    flood_file(&root.join("flood.txt"), 450_000); // about 32 MB
    let host = Host::start(&root, &[]);
    let mut stalled = RawClient::connect(&host, "stalled");
    stalled.send(Payload::WorkspaceOpenRequest(v1::WorkspaceOpenRequest {
        request_id: "open".to_owned(),
        workspace_handle: "workspace".to_owned(),
        root: root.to_string_lossy().into_owned(),
    }));
    let script = format!(
        "stty -opost; cat '{}'; sleep 30",
        root.join("flood.txt").display()
    );
    stalled.send(Payload::PtyCreateRequest(create_request(
        "shared",
        "/bin/sh",
        &["-c", &script],
    )));
    while !matches!(stalled.next(), Payload::PtyCreateResponse(_)) {}
    // A second connection attaches to the same PTY and keeps reading; it also owns an echo PTY.
    let mut reader = Client::connect(&host, "reader");
    reader.send(Payload::PtyAttachRequest(v1::PtyAttachRequest {
        request_id: "attach".to_owned(),
        pty_id: "shared".to_owned(),
        after_sequence: 0,
    }));
    assert!(
        reader
            .create(create_request("echo", "/bin/cat", &[]))
            .accepted
    );
    let started = Instant::now();
    let (mut shared_bytes, mut samples, mut sequence) = (0usize, Vec::new(), 0u64);
    while started.elapsed() < Duration::from_secs(12) {
        sequence += 1;
        let sent = Instant::now();
        reader.send(Payload::PtyInput(v1::PtyInput {
            request_id: format!("input-{sequence}"),
            pty_id: "echo".to_owned(),
            sequence,
            bytes: b"x".to_vec(),
        }));
        loop {
            let frame = reader
                .recv(Duration::from_secs(10))
                .expect("frames keep flowing");
            match frame.payload {
                Some(Payload::PtyOutput(output)) if output.pty_id == "shared" => {
                    shared_bytes += output.bytes.len();
                }
                Some(Payload::PtyOutput(output)) if output.pty_id == "echo" => {
                    samples.push(sent.elapsed());
                    break;
                }
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    samples.sort();
    let p99 = samples[(samples.len() * 99 / 100).min(samples.len() - 1)];
    eprintln!(
        "reader got {shared_bytes} bytes of the shared PTY while the other connection stalled; \
         echo p99 {p99:?} over {} samples",
        samples.len()
    );
    assert!(
        shared_bytes > 8 * 1024 * 1024,
        "the stalled connection held the PTY back"
    );
    assert!(p99 < Duration::from_millis(5), "echo p99 {p99:?}");
    let _ = std::fs::remove_dir_all(root);
}
