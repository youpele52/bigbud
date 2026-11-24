//! Unix write locking: the parent-directory lock, the always-taken per-path lock file, the
//! fallback when a filesystem cannot lock a directory, and the bounded wait.
#![cfg(unix)]

use std::fs;
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use super::files_seams::Fault;
use super::write_test_support::{Seams, TestRoot, hold_flock, lock_file_name};
use super::*;

const SHORT_TIMEOUT: Duration = Duration::from_millis(150);

fn assert_times_out(result: Result<u64, WorkspaceError>, started: Instant) {
    assert!(
        matches!(result, Err(WorkspaceError::WriteLockTimeout)),
        "expected a lock timeout, got {result:?}"
    );
    assert!(started.elapsed() >= SHORT_TIMEOUT);
}

#[test]
fn writes_use_per_path_lock_files_and_leave_no_temporaries() {
    let root = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    workspace.write_file("top.txt", b"1", None).unwrap();
    workspace
        .write_file("./top.txt", b"2", Some(&content_sha256(b"1")))
        .unwrap();
    workspace.write_file("dir/nested.txt", b"3", None).unwrap();
    workspace.create_file("dir/created.txt", b"4").unwrap();
    let mut expected = vec![
        "dir".to_owned(),
        "dir/created.txt".to_owned(),
        format!("dir/{}", lock_file_name("dir/created.txt")),
        format!("dir/{}", lock_file_name("dir/nested.txt")),
        "dir/nested.txt".to_owned(),
        lock_file_name("top.txt"),
        "top.txt".to_owned(),
    ];
    expected.sort();
    assert_eq!(root.entries(), expected);
}

#[test]
fn pre_existing_lock_files_are_reused_and_never_removed() {
    let root = TestRoot::new();
    let legacy = root.0.join(lock_file_name("file.txt"));
    let unrelated = root.0.join(".bigbud-lock-legacy");
    fs::write(&legacy, b"").unwrap();
    fs::write(&unrelated, b"").unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    workspace.write_file("file.txt", b"x", None).unwrap();
    assert!(legacy.exists());
    assert!(unrelated.exists());
}

#[test]
fn a_held_path_lock_times_out_without_writing() {
    let root = TestRoot::new();
    fs::write(root.0.join("file.txt"), b"original").unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let _held = hold_flock(&root.0.join(lock_file_name("file.txt")));
    let seams = Seams::new();
    seams.lock_timeout(SHORT_TIMEOUT);
    let started = Instant::now();
    assert_times_out(workspace.write_file("file.txt", b"next", None), started);
    let started = Instant::now();
    assert_times_out(workspace.create_file("file.txt", b"next"), started);
    assert_eq!(fs::read(root.0.join("file.txt")).unwrap(), b"original");
    assert_eq!(root.entries_without_locks(), vec!["file.txt"]);
}

#[test]
fn a_held_directory_lock_times_out_when_directories_can_be_locked() {
    let root = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let _held = hold_flock(&root.0);
    let seams = Seams::new();
    seams.lock_timeout(SHORT_TIMEOUT);
    let started = Instant::now();
    assert_times_out(workspace.write_file("file.txt", b"next", None), started);
    assert!(!root.0.join("file.txt").exists());
}

/// Linux NFS (`EBADF`), CIFS/FUSE (`ENOLCK`, `EOPNOTSUPP`): the directory lock is skipped and
/// the per-path lock file still excludes other writers of the same path.
#[test]
fn unsupported_directory_locks_fall_back_to_the_path_lock_file() {
    for errno in [libc::EBADF, libc::ENOLCK, libc::EOPNOTSUPP, libc::ENOTSUP] {
        let root = TestRoot::new();
        let workspace = WorkspaceRoot::open(&root.0).unwrap();
        let seams = Seams::new();
        seams
            .fault(Fault::DirectoryLock, errno)
            .lock_timeout(SHORT_TIMEOUT);
        {
            // The directory lock is not consulted, so holding it does not block.
            let _held_directory = hold_flock(&root.0);
            workspace.write_file("file.txt", b"written", None).unwrap();
            workspace.create_file("new.txt", b"created").unwrap();
        }
        let _held_path = hold_flock(&root.0.join(lock_file_name("file.txt")));
        let started = Instant::now();
        assert_times_out(
            workspace.write_file("file.txt", b"blocked", Some(&content_sha256(b"written"))),
            started,
        );
        assert_eq!(fs::read(root.0.join("file.txt")).unwrap(), b"written");
        assert_eq!(fs::read(root.0.join("new.txt")).unwrap(), b"created");
    }
}

#[test]
fn other_directory_lock_errors_fail_the_write() {
    let root = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let seams = Seams::new();
    seams.fault(Fault::DirectoryLock, libc::EIO);
    assert!(matches!(
        workspace.write_file("file.txt", b"x", None),
        Err(WorkspaceError::Io(_))
    ));
    assert!(!root.0.join("file.txt").exists());
}

/// While another writer holds the parent-directory lock, both `write_file` and `create_file`
/// in that directory wait for it, including at the workspace root whose descriptor is shared.
#[test]
fn writes_and_creates_serialize_on_the_parent_directory_lock() {
    for parent in ["", "dir"] {
        let root = TestRoot::new();
        fs::create_dir_all(root.0.join("dir")).unwrap();
        let workspace = WorkspaceRoot::open(&root.0).unwrap();
        let target = root.0.join(parent);
        let held = hold_flock(&target);

        let started = Arc::new(Barrier::new(3));
        let mut writers = Vec::new();
        for create in [false, true] {
            let workspace = workspace.clone();
            let started = Arc::clone(&started);
            let path = if parent.is_empty() {
                format!("file-{create}.txt")
            } else {
                format!("{parent}/file-{create}.txt")
            };
            writers.push(std::thread::spawn(move || {
                started.wait();
                if create {
                    workspace.create_file(&path, b"created")
                } else {
                    workspace.write_file(&path, b"written", None)
                }
            }));
        }
        started.wait();
        std::thread::sleep(Duration::from_millis(150));
        assert!(!target.join("file-false.txt").exists());
        assert!(!target.join("file-true.txt").exists());

        drop(held);
        for writer in writers {
            writer.join().unwrap().unwrap();
        }
        assert_eq!(fs::read(target.join("file-false.txt")).unwrap(), b"written");
        assert_eq!(fs::read(target.join("file-true.txt")).unwrap(), b"created");
    }
}
