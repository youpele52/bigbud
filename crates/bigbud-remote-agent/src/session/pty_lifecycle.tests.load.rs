//! F1/F4 regression (plan §15 R5): maximal snapshots taken while 10 MB/s of output reaches the
//! PTY's reader path produce no `model_invalid`, and every snapshot reports `fidelity = full`.
//! Output is driven through the same `append_output` + `on_output` path the PTY reader uses.
//!
//! A benchmark (the screen model's ingest rate needs an optimized build):
//!
//! ```sh
//! cargo test --release --locked -p bigbud-remote-agent --lib -- --ignored --nocapture snapshots_during_10_mb
//! ```

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::super::super::pty_lifecycle_host::kind;
use super::super::super::pty_screen::{SnapshotSource, produce};
use super::super::super::*;
use super::fixture::Host;

/// One 200-column row of 50 colour runs: about 750 serialized bytes, so a full screen plus
/// 1,000 scrollback rows stays under both snapshot caps (fidelity stays `full`).
fn colour_row(row: usize) -> String {
    let mut line = String::new();
    for group in 0..50 {
        line.push_str(&format!("\x1b[38;5;{}m", 16 + (row + group * 7) % 216));
        line.push_str("abcd");
    }
    line.push_str("\x1b[0m\r\n");
    line
}

#[test]
#[ignore = "benchmark; needs --release (see the module docs)"]
fn snapshots_during_10_mb_per_second_output_stay_live_and_full_fidelity() {
    let mut host = Host::new(false);
    let mut request = host.request("flood", true, "/bin/sleep", &["60"]);
    request.cols = 200;
    request.rows = 50;
    host.create(request);
    let lifecycle = host.lifecycle("flood");
    let running = Arc::new(AtomicBool::new(true));
    let feeder = {
        let lifecycle = Arc::clone(&lifecycle);
        let running = Arc::clone(&running);
        std::thread::spawn(move || {
            let rows = (0..256)
                .map(colour_row)
                .collect::<Vec<_>>()
                .concat()
                .into_bytes();
            let (started, mut written, mut slowest) = (Instant::now(), 0usize, Duration::ZERO);
            while started.elapsed() < Duration::from_secs(6) {
                for chunk in rows.chunks(16 * 1024) {
                    let appended = lifecycle.handle().append_output(chunk.to_vec()).unwrap();
                    let fed = Instant::now();
                    lifecycle.on_output(appended.sequence, appended.bytes);
                    slowest = slowest.max(fed.elapsed());
                    written += chunk.len();
                }
                let due = Duration::from_secs_f64(written as f64 / 10_000_000.0);
                if let Some(wait) = due.checked_sub(started.elapsed()) {
                    std::thread::sleep(wait);
                }
            }
            running.store(false, Ordering::Release);
            (
                written as f64 / started.elapsed().as_secs_f64() / 1_000_000.0,
                slowest,
            )
        })
    };
    let snapshotters = (0..2)
        .map(|worker| {
            let lifecycle = Arc::clone(&lifecycle);
            let running = Arc::clone(&running);
            let pty_id = host.id("flood");
            std::thread::spawn(move || {
                let mut headers = Vec::new();
                while running.load(Ordering::Acquire) {
                    let request = v1::PtyScreenSnapshotRequest {
                        request_id: format!("snap-{worker}-{}", headers.len()),
                        pty_id: pty_id.clone(),
                        ..Default::default()
                    };
                    let transfer = produce(SnapshotSource::Live(Arc::clone(&lifecycle)), &request);
                    headers.push(transfer.header);
                    std::thread::sleep(Duration::from_millis(250));
                }
                headers
            })
        })
        .collect::<Vec<_>>();
    let (rate, slowest) = feeder.join().unwrap();
    let headers = snapshotters
        .into_iter()
        .flat_map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    let largest = headers
        .iter()
        .map(|h| h.total_ansi_bytes)
        .max()
        .unwrap_or(0);
    eprintln!(
        "fed {rate:.1} MB/s (slowest feed {slowest:?}); {} snapshots, largest {largest} bytes",
        headers.len()
    );
    assert!(rate > 9.0, "fed only {rate:.1} MB/s");
    assert!(
        !host.has_notice("flood", kind::MODEL_INVALID),
        "the model went invalid"
    );
    assert!(headers.len() >= 8);
    for header in &headers {
        assert!(header.accepted, "{header:?}");
        assert_eq!(header.model_state, "live");
        assert_eq!(header.fidelity, "full", "{header:?}");
    }
    assert!(largest > 512 * 1024, "snapshots should be large");
}
