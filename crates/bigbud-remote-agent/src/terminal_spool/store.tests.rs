use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::layout::{self, CHECKPOINT_FILE, META_FILE};
use super::{SpoolContinuity, SpoolError, SpoolLimits, SpoolState, SpoolStore};

pub(super) fn temp_root(label: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("bigbud-spool-{label}-{suffix}/terminal-host"))
}

pub(super) fn small_limits() -> SpoolLimits {
    SpoolLimits {
        segment_bytes: 1024,
        checkpoint_max_bytes: 256,
        host_budget_bytes: 1024 * 1024,
        buffer_bytes: 64,
        flush_interval: Duration::from_millis(20),
        checkpoint_interval: Duration::from_millis(50),
        lost_retention_ms: 7 * 24 * 60 * 60 * 1000,
        queue_messages: 64,
        queue_bytes: 64 * 1024,
    }
}

pub(super) fn spool_dir(root: &Path, pty_id: &str) -> PathBuf {
    root.join("terminals").join(layout::dir_name(pty_id))
}

const WAIT: Duration = Duration::from_secs(5);

#[test]
fn round_trips_chunks_in_order_with_full_continuity() {
    let root = temp_root("roundtrip");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    let writer = store.writer("pty-1", 1_000).unwrap();
    for sequence in 1..=5u64 {
        let outcome = writer.append(sequence, format!("line {sequence}\r\n").as_bytes());
        assert_eq!(outcome, super::AppendOutcome::Queued);
    }
    writer.flush(WAIT).unwrap();
    let cold = store.read_cold("pty-1").unwrap();
    assert_eq!(cold.pty_id, "pty-1");
    assert_eq!(cold.state, SpoolState::Live);
    assert_eq!(cold.continuity, SpoolContinuity::Full);
    assert!(cold.checkpoint.is_none());
    let sequences: Vec<u64> = cold.chunks.iter().map(|chunk| chunk.sequence).collect();
    assert_eq!(sequences, vec![1, 2, 3, 4, 5]);
    assert_eq!(cold.chunks[2].bytes, b"line 3\r\n");
    writer.close(true).unwrap();
}

#[cfg(unix)]
#[test]
fn creates_owner_only_folders_and_files_named_by_hash() {
    use std::os::unix::fs::PermissionsExt;
    let root = temp_root("perms");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    let writer = store.writer("secret-pty-name", 1).unwrap();
    writer.append(1, b"hello").unwrap_queued();
    writer.checkpoint(1, b"screen".to_vec()).unwrap();
    writer.flush(WAIT).unwrap();
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    let dir = spool_dir(&root, "secret-pty-name");
    assert_eq!(mode(&root), 0o700);
    assert_eq!(mode(&root.join("terminals")), 0o700);
    assert_eq!(mode(&dir), 0o700);
    for name in [META_FILE, CHECKPOINT_FILE, "seg-0.raw", "seg-1.raw"] {
        assert_eq!(mode(&dir.join(name)), 0o600, "{name}");
    }
    let name = dir.file_name().unwrap().to_string_lossy().into_owned();
    assert!(layout::is_spool_dir_name(&name));
    assert!(!name.contains("secret"));
    writer.close(true).unwrap();
}

pub(super) trait QueuedExt {
    fn unwrap_queued(self);
}

impl QueuedExt for super::AppendOutcome {
    fn unwrap_queued(self) {
        assert_eq!(self, super::AppendOutcome::Queued);
    }
}

#[test]
fn checkpoint_replaces_atomically_and_ignores_stale_temp_files() {
    let root = temp_root("atomic");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    let writer = store.writer("pty-a", 1).unwrap();
    for sequence in 1..=3 {
        writer.append(sequence, b"x").unwrap_queued();
    }
    writer.checkpoint(2, b"first".to_vec()).unwrap();
    writer.checkpoint(3, b"second".to_vec()).unwrap();
    writer.flush(WAIT).unwrap();
    let dir = spool_dir(&root, "pty-a");
    // A crash mid-write leaves only a temp file; the committed checkpoint is untouched.
    fs::write(dir.join("checkpoint.bin.tmp"), b"torn garbage").unwrap();
    let cold = store.read_cold("pty-a").unwrap();
    let checkpoint = cold.checkpoint.unwrap();
    assert_eq!(checkpoint.through_sequence, 3);
    assert_eq!(checkpoint.blob, b"second");
    assert!(cold.chunks.is_empty());
    assert_eq!(cold.continuity, SpoolContinuity::Full);
    writer.close(false).unwrap();
}

#[test]
fn torn_checkpoint_and_truncated_segment_keep_the_intact_prefix() {
    let root = temp_root("crash");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    let writer = store.writer("pty-c", 1).unwrap();
    for sequence in 1..=4 {
        writer.append(sequence, b"abcdef").unwrap_queued();
    }
    writer.checkpoint(2, b"screen".to_vec()).unwrap();
    writer.flush(WAIT).unwrap();
    writer.close(false).unwrap();
    let dir = spool_dir(&root, "pty-c");
    // Simulate a crash: the checkpoint loses its tail and the segment ends mid-record.
    let checkpoint = fs::read(dir.join(CHECKPOINT_FILE)).unwrap();
    fs::write(
        dir.join(CHECKPOINT_FILE),
        &checkpoint[..checkpoint.len() - 2],
    )
    .unwrap();
    let segment = fs::read(dir.join("seg-0.raw")).unwrap();
    fs::write(dir.join("seg-0.raw"), &segment[..segment.len() - 3]).unwrap();
    let cold = store.read_cold("pty-c").unwrap();
    assert!(
        cold.checkpoint.is_none(),
        "a torn checkpoint is never trusted"
    );
    let sequences: Vec<u64> = cold.chunks.iter().map(|chunk| chunk.sequence).collect();
    assert_eq!(sequences, vec![1, 2, 3]);
    // Nothing was rotated away, so the intact prefix is still the full stream so far.
    assert_eq!(cold.continuity, SpoolContinuity::Full);
}

#[test]
fn mark_and_remove_refuse_active_writers_and_track_lost_time() {
    let root = temp_root("mark");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    let writer = store.writer("pty-m", 10).unwrap();
    assert!(matches!(
        store.mark("pty-m", SpoolState::Lost, 20),
        Err(SpoolError::Busy)
    ));
    assert!(matches!(store.remove("pty-m"), Err(SpoolError::Busy)));
    assert!(matches!(store.writer("pty-m", 10), Err(SpoolError::Busy)));
    writer.close(false).unwrap();
    store.mark("pty-m", SpoolState::Lost, 30).unwrap();
    let cold = store.read_cold("pty-m").unwrap();
    assert_eq!(cold.state, SpoolState::Lost);
    assert_eq!(cold.lost_at_ms, Some(30));
    store.remove("pty-m").unwrap();
    assert!(matches!(store.read_cold("pty-m"), Err(SpoolError::Unknown)));
    assert!(!spool_dir(&root, "pty-m").exists());
}

#[test]
fn close_with_remove_deletes_the_spool_at_once() {
    let root = temp_root("close");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    let writer = store.writer("pty-x", 1).unwrap();
    writer.append(1, b"bye").unwrap_queued();
    writer.close(true).unwrap();
    assert!(!spool_dir(&root, "pty-x").exists());
    assert!(
        fs::read_dir(root.join("terminals"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn rejects_invalid_ids_and_oversized_checkpoints() {
    let root = temp_root("invalid");
    let store = SpoolStore::open(&root, small_limits()).unwrap();
    assert!(matches!(
        store.writer("", 1),
        Err(SpoolError::InvalidArgument(_))
    ));
    assert!(matches!(
        store.read_cold("a\0b"),
        Err(SpoolError::InvalidArgument(_))
    ));
    let writer = store.writer("pty-big", 1).unwrap();
    let error = writer.checkpoint(1, vec![0; 257]).unwrap_err();
    assert!(matches!(error, SpoolError::CheckpointTooLarge(256)));
    writer.close(true).unwrap();
}
