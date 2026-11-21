//! Terminal host load criteria (plan §13, §15 R5): input echo latency on other PTYs during
//! maximal snapshots, and host RSS within 256 MiB at 24 PTYs with two snapshots in flight
//! (F4 memory). The 10 MB/s snapshot criterion (F1) runs in-process
//! (`session/pty_lifecycle.tests.load.rs`): the PTY reader's existing fixed 5 ms back-off caps
//! a macOS PTY near 0.2 MB/s, so a real child cannot produce 10 MB/s through it.
//!
//! These are benchmarks: they are `#[ignore]`d because their budgets assume an optimized build
//! on a machine that is not saturated. Run them with:
//!
//! ```sh
//! cargo test --release --locked -p bigbud-remote-agent --test terminal_host_load -- --ignored --nocapture --test-threads=1
//! ```
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

use std::time::{Duration, Instant};

use bigbud_protocol::v1;
use fixture::{Client, Host, Payload, colourful_file, create_request, scratch};

/// Keeps `in_flight` snapshot requests of `pty_id` outstanding; returns completed transfers.
struct SnapshotPump {
    pty_id: String,
    outstanding: usize,
    completed: usize,
    bytes: usize,
}

impl SnapshotPump {
    fn new(client: &mut Client, pty_id: &str, in_flight: usize) -> Self {
        let mut pump = Self {
            pty_id: pty_id.to_owned(),
            outstanding: 0,
            completed: 0,
            bytes: 0,
        };
        for _ in 0..in_flight {
            pump.request(client);
        }
        pump
    }

    fn request(&mut self, client: &mut Client) {
        let request_id = client.request_id("pump");
        client.send(fixture::snapshot_request(&request_id, &self.pty_id));
        self.outstanding += 1;
    }

    /// Handles snapshot frames; returns true when the frame belonged to the pump.
    fn handle(&mut self, client: &mut Client, payload: &Payload) -> bool {
        match payload {
            Payload::PtyScreenSnapshotHeader(header) => {
                assert!(header.accepted, "{header:?}");
                true
            }
            Payload::PtyScreenSnapshotChunk(chunk) => {
                self.bytes += chunk.bytes.len();
                if chunk.last {
                    self.completed += 1;
                    self.outstanding -= 1;
                    self.request(client);
                }
                true
            }
            _ => false,
        }
    }
}

fn percentile(samples: &mut [Duration], percent: usize) -> Duration {
    samples.sort();
    samples[(samples.len() * percent / 100).min(samples.len() - 1)]
}

#[test]
#[ignore = "benchmark; see the module docs"]
fn input_echo_on_other_ptys_stays_under_50_ms_p99_during_maximal_snapshots() {
    let root = scratch();
    let host = Host::start(&root, &[]);
    let mut client = Client::connect(&host, "echo");
    client.open_workspace("workspace", &root);
    let big = root.join("big.txt");
    colourful_file(&big, 1100, 200);
    let script = format!("cat '{}'; sleep 300", big.display());
    assert!(
        client
            .create(create_request("big", "/bin/sh", &["-c", &script]))
            .accepted
    );
    assert!(
        client
            .create(create_request("echo", "/bin/cat", &[]))
            .accepted
    );
    std::thread::sleep(Duration::from_secs(2));
    let mut pump = SnapshotPump::new(&mut client, "big", 2);
    let mut samples = Vec::new();
    for sequence in 1..=300u64 {
        let sent = Instant::now();
        client.send(Payload::PtyInput(v1::PtyInput {
            request_id: format!("input-{sequence}"),
            pty_id: "echo".to_owned(),
            sequence,
            bytes: b"x".to_vec(),
        }));
        loop {
            let frame = client.recv(Duration::from_secs(5)).expect("echo arrives");
            let Some(payload) = frame.payload else {
                continue;
            };
            if pump.handle(&mut client, &payload) {
                continue;
            }
            if matches!(&payload, Payload::PtyOutput(output) if output.pty_id == "echo") {
                samples.push(sent.elapsed());
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let p50 = percentile(&mut samples, 50);
    let p99 = percentile(&mut samples, 99);
    eprintln!(
        "echo latency p50 {p50:?} p99 {p99:?}; {} snapshots of {} bytes avg meanwhile",
        pump.completed,
        pump.bytes / pump.completed.max(1)
    );
    assert!(pump.completed > 0, "snapshots ran during the measurement");
    assert!(p99 < Duration::from_millis(50), "p99 {p99:?}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
#[ignore = "benchmark; see the module docs"]
fn host_rss_stays_within_256_mib_at_24_ptys_with_two_snapshots_in_flight() {
    let root = scratch();
    let host = Host::start(&root, &[]);
    let mut client = Client::connect(&host, "rss");
    client.open_workspace("workspace", &root);
    let big = root.join("big.txt");
    colourful_file(&big, 1100, 200);
    let script = format!("cat '{}'; sleep 300", big.display());
    for index in 0..24 {
        let id = format!("pty-{index}");
        assert!(
            client
                .create(create_request(&id, "/bin/sh", &["-c", &script]))
                .accepted
        );
    }
    // Past the first memory sample (allocator relief) and with every screen full.
    let report = loop {
        let frame = client
            .recv(Duration::from_secs(20))
            .expect("resource report");
        if let Some(Payload::HostResourceReport(report)) = frame.payload
            && report.live_ptys == 24
            && report.screen_model_bytes > 24 * 6 * 1024 * 1024
        {
            break report;
        }
    };
    let idle_rss = host.rss_bytes();
    eprintln!(
        "screen models {} MiB across {} PTYs",
        report.screen_model_bytes >> 20,
        report.live_ptys
    );
    let mut pumps = (0..2)
        .map(|index| SnapshotPump::new(&mut client, &format!("pty-{index}"), 1))
        .collect::<Vec<_>>();
    let started = Instant::now();
    let mut peak = idle_rss;
    let mut last_sample = Instant::now();
    while started.elapsed() < Duration::from_secs(8) {
        if let Some(frame) = client.recv(Duration::from_millis(200))
            && let Some(payload) = frame.payload
        {
            for pump in &mut pumps {
                if pump.handle(&mut client, &payload) {
                    break;
                }
            }
        }
        if last_sample.elapsed() > Duration::from_millis(100) {
            peak = peak.max(host.rss_bytes());
            last_sample = Instant::now();
        }
    }
    let completed: usize = pumps.iter().map(|pump| pump.completed).sum();
    eprintln!(
        "host RSS idle {} MiB, peak {} MiB with {completed} snapshots",
        idle_rss >> 20,
        peak >> 20
    );
    assert!(completed >= 2);
    assert!(peak <= 256 * 1024 * 1024, "peak RSS {} MiB", peak >> 20);
    let _ = std::fs::remove_dir_all(root);
}
