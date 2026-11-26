use std::fs;
use std::time::Duration;

use super::store_tests::{QueuedExt, small_limits, spool_dir, temp_root};
use super::{LostSpool, SpoolLimits, SpoolState, SpoolStore};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const WAIT: Duration = Duration::from_secs(5);

/// A spool left `live` by a host that died without closing it.
fn crashed_spool(store: &SpoolStore, pty_id: &str) {
    let writer = store.writer(pty_id, 1).unwrap();
    writer.append(1, b"before the crash").unwrap_queued();
    writer.close(false).unwrap();
}

#[test]
fn startup_sweep_marks_crashed_spools_lost_and_expires_them_after_seven_days() {
    let root = temp_root("lost");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    crashed_spool(&store, "pty-lost");
    let report = store.sweep(1_000).unwrap();
    assert_eq!(
        report.lost,
        vec![LostSpool {
            pty_id: "pty-lost".into(),
            lost_at_ms: 1_000
        }]
    );
    assert_eq!(store.read_cold("pty-lost").unwrap().state, SpoolState::Lost);
    // A later sweep keeps the original loss time and still reports it.
    let report = store.sweep(1_000 + DAY_MS).unwrap();
    assert_eq!(report.lost.len(), 1);
    assert_eq!(report.lost[0].lost_at_ms, 1_000);
    let report = store.sweep(1_000 + 7 * DAY_MS).unwrap();
    assert!(report.lost.is_empty());
    assert_eq!(report.removed, 1);
    assert!(!spool_dir(&root, "pty-lost").exists());
}

#[test]
fn sweep_removes_closed_spools_garbage_and_temp_files_but_not_active_writers() {
    let root = temp_root("garbage");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    crashed_spool(&store, "pty-closed");
    store.mark("pty-closed", SpoolState::Closed, 2).unwrap();
    crashed_spool(&store, "pty-keep");
    let terminals = root.join("terminals");
    fs::write(terminals.join("stray-file"), b"x").unwrap();
    fs::create_dir(terminals.join("not-a-hash")).unwrap();
    fs::create_dir(terminals.join("0123456789abcdef0123456789abcdef")).unwrap();
    fs::write(spool_dir(&root, "pty-keep").join("meta.json.tmp"), b"torn").unwrap();
    let active = store.writer("pty-active", 3).unwrap();
    active.append(1, b"still running").unwrap_queued();
    active.flush(WAIT).unwrap();

    let report = store.sweep(5).unwrap();
    assert_eq!(report.removed, 4, "{report:?}");
    assert_eq!(report.lost.len(), 1);
    assert_eq!(report.lost[0].pty_id, "pty-keep");
    assert!(!spool_dir(&root, "pty-closed").exists());
    assert!(!spool_dir(&root, "pty-keep").join("meta.json.tmp").exists());
    assert_eq!(
        store.read_cold("pty-active").unwrap().state,
        SpoolState::Live
    );
    let mut names: Vec<String> = fs::read_dir(&terminals)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names.len(), 2);
    active.close(true).unwrap();
}

#[test]
fn host_budget_evicts_lost_spools_oldest_first() {
    let root = temp_root("hostbudget");
    let limits = SpoolLimits {
        host_budget_bytes: 1_500,
        ..small_limits()
    };
    let store = SpoolStore::open(&root, limits).unwrap();
    for (index, pty_id) in ["old", "new"].into_iter().enumerate() {
        let writer = store.writer(pty_id, 1).unwrap();
        for sequence in 1..=12u64 {
            writer.append(sequence, &[b'q'; 50]).unwrap_queued();
        }
        writer.close(false).unwrap();
        store
            .mark(pty_id, SpoolState::Lost, 10 + index as u64)
            .unwrap();
    }
    let report = store.enforce_budget().unwrap();
    assert_eq!(report.evicted, 1, "{report:?}");
    assert!(
        !spool_dir(&root, "old").exists(),
        "the oldest lost spool goes first"
    );
    assert!(spool_dir(&root, "new").exists());
    assert!(report.used_bytes <= limits.host_budget_bytes);
}

#[test]
fn host_budget_shrinks_live_spools_to_one_segment() {
    let root = temp_root("shrink");
    let limits = SpoolLimits {
        host_budget_bytes: 1_500,
        ..small_limits()
    };
    let store = SpoolStore::open(&root, limits).unwrap();
    let live = store.writer("live", 1).unwrap();
    for sequence in 1..=30u64 {
        live.append(sequence, &[b'l'; 50]).unwrap_queued();
    }
    live.flush(WAIT).unwrap();
    let report = store.enforce_budget().unwrap();
    assert_eq!(
        (report.evicted, report.shrink_requests),
        (0, 1),
        "{report:?}"
    );
    live.flush(WAIT).unwrap();
    let dir = spool_dir(&root, "live");
    let lengths =
        ["seg-0.raw", "seg-1.raw"].map(|name| fs::metadata(dir.join(name)).unwrap().len());
    assert!(
        lengths.contains(&0),
        "the older segment was dropped: {lengths:?}"
    );
    assert!(super::layout::dir_usage(&dir) <= limits.host_budget_bytes);
    let cold = store.read_cold("live").unwrap();
    assert_eq!(cold.chunks.last().unwrap().sequence, 30);
    assert_eq!(cold.continuity, super::SpoolContinuity::Partial);
    live.close(true).unwrap();
}
