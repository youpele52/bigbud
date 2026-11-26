use std::fs;
use std::time::{Duration, Instant};

use super::layout;
use super::store_tests::{QueuedExt, small_limits, spool_dir, temp_root};
use super::{AppendOutcome, SpoolContinuity, SpoolLimits, SpoolStore};

const WAIT: Duration = Duration::from_secs(5);

fn segment_lengths(root: &std::path::Path, pty_id: &str) -> [u64; 2] {
    let dir = spool_dir(root, pty_id);
    ["seg-0.raw", "seg-1.raw"].map(|name| fs::metadata(dir.join(name)).unwrap().len())
}

#[test]
fn rotation_reuses_the_older_segment_and_requests_checkpoints() {
    let root = temp_root("rotate");
    let limits = small_limits();
    let store = SpoolStore::open(&root, limits).unwrap();
    let writer = store.writer("pty-r", 1).unwrap();
    assert!(!writer.checkpoint_wanted());
    // 40 records of 13 + 50 bytes = 2,520 bytes: more than two 1 KiB segments.
    for sequence in 1..=40u64 {
        writer.append(sequence, &[b'a'; 50]).unwrap_queued();
    }
    writer.flush(WAIT).unwrap();
    assert!(
        writer.checkpoint_wanted(),
        "half-full and rotated segments ask for a checkpoint"
    );
    for length in segment_lengths(&root, "pty-r") {
        assert!(length <= limits.segment_bytes, "{length}");
    }
    let cold = store.read_cold("pty-r").unwrap();
    assert_eq!(
        cold.continuity,
        SpoolContinuity::Partial,
        "rotated data has no checkpoint"
    );
    assert_eq!(cold.chunks.last().unwrap().sequence, 40);
    assert!(cold.chunks.first().unwrap().sequence > 1);
    let first = cold.chunks.first().unwrap().sequence;

    writer.checkpoint(40, b"screen@40".to_vec()).unwrap();
    writer.flush(WAIT).unwrap();
    assert!(!writer.checkpoint_wanted());
    for sequence in 41..=43u64 {
        writer.append(sequence, b"tail").unwrap_queued();
    }
    writer.flush(WAIT).unwrap();
    let cold = store.read_cold("pty-r").unwrap();
    assert_eq!(cold.continuity, SpoolContinuity::Full);
    assert_eq!(cold.checkpoint.as_ref().unwrap().through_sequence, 40);
    let sequences: Vec<u64> = cold.chunks.iter().map(|chunk| chunk.sequence).collect();
    assert_eq!(sequences, vec![41, 42, 43]);
    assert!(first > 1);
    writer.close(true).unwrap();
}

#[test]
fn a_checkpoint_older_than_the_rotated_data_is_not_used() {
    let root = temp_root("stale");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    let writer = store.writer("pty-s", 1).unwrap();
    writer.append(1, &[b'b'; 50]).unwrap_queued();
    writer.checkpoint(1, b"early".to_vec()).unwrap();
    for sequence in 2..=60u64 {
        writer.append(sequence, &[b'b'; 50]).unwrap_queued();
    }
    writer.flush(WAIT).unwrap();
    let cold = store.read_cold("pty-s").unwrap();
    assert!(cold.checkpoint.is_none());
    assert_eq!(cold.continuity, SpoolContinuity::Partial);
    writer.close(true).unwrap();
}

#[test]
fn per_terminal_disk_use_stays_within_budget_under_heavy_output() {
    let root = temp_root("budget");
    let limits = SpoolLimits {
        segment_bytes: 64 * 1024,
        checkpoint_max_bytes: 16 * 1024,
        buffer_bytes: 4 * 1024,
        queue_messages: 4096,
        queue_bytes: 8 * 1024 * 1024,
        ..small_limits()
    };
    let store = SpoolStore::open(&root, limits).unwrap();
    let writer = store.writer("pty-b", 1).unwrap();
    let chunk = [b'z'; 1024];
    for sequence in 1..=2_000u64 {
        assert_eq!(writer.append(sequence, &chunk), AppendOutcome::Queued);
        if sequence % 200 == 0 {
            writer.checkpoint(sequence, vec![7; 16 * 1024]).unwrap();
            writer.flush(WAIT).unwrap();
        }
    }
    writer.flush(WAIT).unwrap();
    let usage = layout::dir_usage(&spool_dir(&root, "pty-b"));
    assert!(usage <= limits.per_terminal_bytes() + 1024, "{usage}");
    assert!(SpoolLimits::default().per_terminal_bytes() <= 10 * 1024 * 1024 + 4096);
    writer.close(true).unwrap();
}

#[test]
fn queue_overflow_degrades_once_and_never_blocks() {
    let root = temp_root("degrade");
    let limits = SpoolLimits {
        queue_bytes: 100,
        ..small_limits()
    };
    let store = SpoolStore::open(&root, limits).unwrap();
    let writer = store.writer("pty-d", 1).unwrap();
    writer.append(1, b"ok").unwrap_queued();
    let started = Instant::now();
    assert_eq!(writer.append(2, &[0; 200]), AppendOutcome::Degraded);
    assert_eq!(writer.append(3, b"more"), AppendOutcome::Disabled);
    assert!(started.elapsed() < Duration::from_millis(50));
    assert!(writer.is_degraded());
    assert!(!writer.checkpoint_wanted());
    assert!(writer.checkpoint(1, Vec::new()).is_err());
    // The flag reaches the meta while the PTY is still live, so a crash cannot hide the gap.
    let deadline = Instant::now() + WAIT;
    while store.read_cold("pty-d").unwrap().continuity != SpoolContinuity::Partial {
        assert!(Instant::now() < deadline, "degraded flag never persisted");
        std::thread::sleep(Duration::from_millis(5));
    }
    writer.close(false).unwrap();
    let cold = store.read_cold("pty-d").unwrap();
    assert_eq!(
        cold.continuity,
        SpoolContinuity::Partial,
        "a degraded spool is never full"
    );
}

#[test]
fn out_of_order_sequences_are_ignored() {
    let root = temp_root("order");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    let writer = store.writer("pty-o", 1).unwrap();
    writer.append(5, b"five").unwrap_queued();
    assert_eq!(writer.append(5, b"again"), AppendOutcome::OutOfOrder);
    assert_eq!(writer.append(4, b"four"), AppendOutcome::OutOfOrder);
    writer.append(6, b"six").unwrap_queued();
    writer.flush(WAIT).unwrap();
    let cold = store.read_cold("pty-o").unwrap();
    let sequences: Vec<u64> = cold.chunks.iter().map(|chunk| chunk.sequence).collect();
    assert_eq!(sequences, vec![5, 6]);
    writer.close(true).unwrap();
}

#[test]
fn buffered_output_reaches_disk_on_the_flush_cadence() {
    let root = temp_root("cadence");
    let limits = SpoolLimits {
        buffer_bytes: 64 * 1024,
        flush_interval: Duration::from_millis(30),
        ..small_limits()
    };
    let store = SpoolStore::open(&root, limits).unwrap();
    let writer = store.writer("pty-f", 1).unwrap();
    writer.append(1, b"buffered").unwrap_queued();
    let deadline = Instant::now() + WAIT;
    while segment_lengths(&root, "pty-f")[0] == 0 {
        assert!(Instant::now() < deadline, "timer flush never happened");
        std::thread::sleep(Duration::from_millis(5));
    }
    writer.close(true).unwrap();
}

#[test]
fn checkpoint_interval_requests_a_checkpoint_only_after_output() {
    let root = temp_root("interval");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    let writer = store.writer("pty-i", 1).unwrap();
    std::thread::sleep(Duration::from_millis(80));
    assert!(!writer.checkpoint_wanted(), "no output, no checkpoint");
    writer.append(1, b"x").unwrap_queued();
    writer.flush(WAIT).unwrap();
    std::thread::sleep(Duration::from_millis(80));
    assert!(writer.checkpoint_wanted());
    writer.close(true).unwrap();
}
