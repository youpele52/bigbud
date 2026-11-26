//! Benches for the §13 budgets. Ignored by default; run in release:
//! `cargo test --release --locked -p bigbud-remote-agent terminal_screen::tests::bench -- --ignored --nocapture`.
//! Budgets are asserted only in optimized builds.

use super::super::{ScreenModel, SnapshotLimits};
use std::time::{Duration, Instant};

const MIB: f64 = 1024.0 * 1024.0;

/// Representative shell and agent output: coloured log lines, a redrawn status area, and
/// plain text, with CR LF line ends.
fn mixed_output(target: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(target + 4096);
    let mut line = 0u64;
    while out.len() < target {
        line += 1;
        let text = match line % 4 {
            0 => format!(
                "\x1b[38;5;{}m{line:08}\x1b[m plain log text that fills a typical terminal row ok\r\n",
                line % 200 + 16
            ),
            1 => format!(
                "\x1b[1;32m✓\x1b[0m test case {line} passed in {} ms\r\n",
                line % 97
            ),
            2 => format!(
                "\x1b[?2026h\r\x1b[2K\x1b[38;2;215;119;87m✻\x1b[39m Working… {line}\x1b[?2026l\r\n"
            ),
            _ => format!(
                "{}\r\n",
                "x".repeat(usize::try_from(line % 150).unwrap_or(10))
            ),
        };
        out.extend_from_slice(text.as_bytes());
    }
    out
}

fn throughput(bytes: &[u8]) -> f64 {
    let mut model = ScreenModel::new(200, 50, 1_000).expect("model");
    let started = Instant::now();
    for chunk in bytes.chunks(64 * 1024) {
        let _ = model.feed(chunk);
    }
    bytes.len() as f64 / MIB / started.elapsed().as_secs_f64()
}

fn p95(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    let index = (samples.len() * 95).div_ceil(100).saturating_sub(1);
    samples.get(index).copied().unwrap_or_default()
}

#[test]
#[ignore = "bench: run in release with --ignored"]
fn ingest_throughput_meets_the_budget() {
    let mixed = mixed_output(32 * 1024 * 1024);
    let rate = throughput(&mixed);
    let core_share = 100.0 * (100.0 * 1024.0 / MIB) / rate;
    let boxes = "╭──────╮│ 中文 │╰──────╯".repeat(4096).into_bytes();
    let background = format!("\x1b[44m{}\r\n", "y".repeat(180))
        .repeat(65_536)
        .into_bytes();
    let raw = {
        let mut parser = vt100::Parser::new(
            std::num::NonZeroU16::new(50).unwrap(),
            std::num::NonZeroU16::new(200).unwrap(),
            1_000,
        );
        let started = Instant::now();
        for chunk in mixed.chunks(64 * 1024) {
            parser.process(chunk);
        }
        mixed.len() as f64 / MIB / started.elapsed().as_secs_f64()
    };
    println!(
        "ingest mixed: {rate:.1} MiB/s ({core_share:.2}% of a core at 100 KB/s); raw vt100 {raw:.1} MiB/s"
    );
    println!(
        "ingest box drawing and CJK: {:.1} MiB/s",
        throughput(&boxes)
    );
    println!(
        "ingest with a background colour: {:.1} MiB/s",
        throughput(&background)
    );
    if !cfg!(debug_assertions) {
        assert!(
            rate >= 50.0,
            "screen ingest {rate:.1} MiB/s is below 50 MiB/s"
        );
        assert!(core_share < 2.0);
    }
}

/// Worst case: every row full, the colour changing every few cells.
fn dense_output() -> Vec<u8> {
    let mut out = String::new();
    for line in 0..1_100u32 {
        for cell in 0..50u32 {
            let colour = (line + cell) % 216 + 16;
            out.push_str(&format!(
                "\x1b[38;5;{colour};48;2;{};{};40mab中",
                cell * 5,
                line % 256
            ));
        }
        out.push_str("\x1b[m\r\n");
    }
    out.into_bytes()
}

#[test]
#[ignore = "bench: run in release with --ignored"]
fn snapshot_serialization_meets_the_budget() {
    for (name, input) in [
        ("mixed", mixed_output(4 * 1024 * 1024)),
        ("dense", dense_output()),
    ] {
        serialization_bench(name, &input);
    }
}

fn serialization_bench(name: &str, input: &[u8]) {
    let mut model = ScreenModel::new(200, 50, 1_000).expect("model");
    let _ = model.feed(input);
    let limits = SnapshotLimits::default();
    let (mut copies, mut serializations) = (Vec::new(), Vec::new());
    let mut size = 0;
    for _ in 0..40 {
        let started = Instant::now();
        let copy = model.copy(0);
        copies.push(started.elapsed());
        let started = Instant::now();
        let snapshot = copy.serialize(&limits).expect("serialize");
        serializations.push(started.elapsed());
        size = snapshot.ansi.len();
    }
    let (copy_p95, serialize_p95) = (p95(copies), p95(serializations));
    println!(
        "{name}: fence copy p95 {copy_p95:?}; serialize p95 {serialize_p95:?}; snapshot {size} \
         bytes; model ~{} bytes",
        model.estimated_bytes()
    );
    if !cfg!(debug_assertions) {
        assert!(
            serialize_p95 <= Duration::from_millis(15),
            "serialize p95 {serialize_p95:?}"
        );
    }
}
