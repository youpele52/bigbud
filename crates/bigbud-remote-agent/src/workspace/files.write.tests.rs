//! Unix write-path behavior: guarded parents, commit re-checks, read-back verification,
//! in-place rewrites, group preservation and unknown outcomes.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{FileExt, MetadataExt, PermissionsExt};

use super::files_seams::Fault;
use super::write_test_support::{Seams, TestRoot, supplementary_group_other_than};
use super::*;

fn corrupt_after_sync(seams: &Seams) {
    seams.after_sync(|file| file.write_at(b"#", 0).map(|_| ()).unwrap());
}

#[test]
fn guarded_write_with_missing_parent_conflicts_and_creates_nothing() {
    let root = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let expected = content_sha256(b"old");
    for path in ["missing/deeper/file.txt", "missing.txt"] {
        match workspace.write_file(path, b"new", Some(&expected)) {
            Err(WorkspaceError::WriteConflict {
                expected: reported,
                actual: None,
            }) => assert_eq!(reported, expected),
            other => panic!("expected a missing-target conflict for {path}, got {other:?}"),
        }
    }
    // A missing parent creates nothing; a missing file only leaves its lock file.
    assert!(
        root.entries_without_locks().is_empty(),
        "{:?}",
        root.entries()
    );
}

#[test]
fn guarded_write_refuses_symlinked_parent_without_creating() {
    let root = TestRoot::new();
    let outside = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    std::os::unix::fs::symlink(&outside.0, root.0.join("link")).unwrap();
    assert!(matches!(
        workspace.write_file("link/file.txt", b"x", Some(&content_sha256(b"y"))),
        Err(WorkspaceError::SymlinkComponent)
    ));
    assert!(outside.entries().is_empty());
}

#[test]
fn guarded_atomic_write_rechecks_before_rename_and_removes_temporary() {
    let root = TestRoot::new();
    let path = root.0.join("file.txt");
    fs::write(&path, b"base").unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let racing = path.clone();
    let seams = Seams::new();
    seams.before_commit(move || fs::write(racing, b"external").unwrap());
    match workspace.write_file("file.txt", b"mine", Some(&content_sha256(b"base"))) {
        Err(WorkspaceError::WriteConflict { actual, .. }) => {
            assert_eq!(actual, Some(content_sha256(b"external")));
        }
        other => panic!("expected a re-check conflict, got {other:?}"),
    }
    assert_eq!(fs::read(&path).unwrap(), b"external");
    assert_eq!(root.entries_without_locks(), vec!["file.txt"]);
}

#[test]
fn guarded_in_place_write_rechecks_through_the_written_descriptor() {
    let root = TestRoot::new();
    let path = root.0.join("file.txt");
    fs::write(&path, b"base").unwrap();
    fs::hard_link(&path, root.0.join("alias.txt")).unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let racing = path.clone();
    let seams = Seams::new();
    seams.before_commit(move || fs::write(racing, b"external").unwrap());
    let result = workspace.write_file("file.txt", b"mine", Some(&content_sha256(b"base")));
    assert!(matches!(
        result,
        Err(WorkspaceError::WriteConflict { actual: Some(ref actual), .. })
            if *actual == content_sha256(b"external")
    ));
    assert_eq!(fs::read(&path).unwrap(), b"external");
}

#[test]
fn hard_linked_files_are_rewritten_in_place() {
    let root = TestRoot::new();
    let path = root.0.join("file.txt");
    let alias = root.0.join("alias.txt");
    fs::write(&path, b"a much longer original body").unwrap();
    fs::hard_link(&path, &alias).unwrap();
    let inode = fs::metadata(&path).unwrap().ino();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();

    workspace.write_file("file.txt", b"short", None).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"short");
    assert_eq!(fs::read(&alias).unwrap(), b"short");

    let guard = content_sha256(b"short");
    workspace
        .write_file("file.txt", b"guarded", Some(&guard))
        .unwrap();
    assert_eq!(fs::read(&alias).unwrap(), b"guarded");
    assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
    assert_eq!(fs::metadata(&path).unwrap().nlink(), 2);
    assert_eq!(root.entries_without_locks(), vec!["alias.txt", "file.txt"]);
}

#[test]
fn single_link_files_owned_by_the_writer_are_replaced_atomically() {
    let root = TestRoot::new();
    let path = root.0.join("file.txt");
    fs::write(&path, b"original").unwrap();
    let inode = fs::metadata(&path).unwrap().ino();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    workspace
        .write_file("file.txt", b"next", Some(&content_sha256(b"original")))
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"next");
    assert_ne!(fs::metadata(&path).unwrap().ino(), inode);
}

/// An owned, single-link file whose group alone differs stays atomic: the replacement is
/// given the original group and mode, so read-only and set-group-ID files keep working.
#[test]
fn owned_files_with_only_a_group_mismatch_stay_atomic_and_keep_group_and_mode() {
    let root = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    for mode in [0o444, 0o2750, 0o640] {
        let name = format!("file-{mode:o}");
        let path = root.0.join(&name);
        fs::write(&path, b"original").unwrap();
        let Some(other_group) = supplementary_group_other_than(fs::metadata(&path).unwrap().gid())
        else {
            eprintln!("skipped: the test user has no second group to chown to");
            return;
        };
        std::os::unix::fs::chown(&path, None, Some(other_group)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        let inode = fs::metadata(&path).unwrap().ino();
        workspace
            .write_file(&name, b"next", Some(&content_sha256(b"original")))
            .unwrap();
        let metadata = fs::metadata(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"next");
        assert_ne!(
            metadata.ino(),
            inode,
            "mode {mode:o} was not replaced atomically"
        );
        assert_eq!(metadata.gid(), other_group);
        assert_eq!(metadata.permissions().mode() & 0o7777, mode);
    }
}

#[test]
fn a_refused_group_change_falls_back_to_an_in_place_write() {
    let root = TestRoot::new();
    let path = root.0.join("file.txt");
    fs::write(&path, b"original").unwrap();
    let Some(other_group) = supplementary_group_other_than(fs::metadata(&path).unwrap().gid())
    else {
        eprintln!("skipped: the test user has no second group to chown to");
        return;
    };
    std::os::unix::fs::chown(&path, None, Some(other_group)).unwrap();
    let inode = fs::metadata(&path).unwrap().ino();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let seams = Seams::new();
    seams.fault(Fault::TemporaryChown, libc::EPERM);
    workspace
        .write_file("file.txt", b"next", Some(&content_sha256(b"original")))
        .unwrap();
    let metadata = fs::metadata(&path).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"next");
    assert_eq!(metadata.ino(), inode);
    assert_eq!(metadata.gid(), other_group);
    assert_eq!(root.entries_without_locks(), vec!["file.txt"]);
}

#[test]
fn atomic_read_back_mismatch_fails_without_replacing() {
    let root = TestRoot::new();
    let path = root.0.join("file.txt");
    fs::write(&path, b"original").unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let seams = Seams::new();
    corrupt_after_sync(&seams);
    assert!(matches!(
        workspace.write_file("file.txt", b"next", Some(&content_sha256(b"original"))),
        Err(WorkspaceError::WriteVerificationFailed)
    ));
    assert_eq!(fs::read(&path).unwrap(), b"original");
    assert_eq!(root.entries_without_locks(), vec!["file.txt"]);
}

#[test]
fn create_read_back_mismatch_removes_the_new_file() {
    let root = TestRoot::new();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    let seams = Seams::new();
    corrupt_after_sync(&seams);
    assert!(matches!(
        workspace.create_file("new.txt", b"created"),
        Err(WorkspaceError::WriteVerificationFailed)
    ));
    assert!(root.entries_without_locks().is_empty());
}

#[test]
fn in_place_failures_after_truncation_are_unknown_outcomes() {
    let root = TestRoot::new();
    let path = root.0.join("file.txt");
    fs::write(&path, b"original").unwrap();
    fs::hard_link(&path, root.0.join("alias.txt")).unwrap();
    let workspace = WorkspaceRoot::open(&root.0).unwrap();
    {
        let seams = Seams::new();
        seams.fault(Fault::AfterTruncate, libc::EIO);
        assert!(matches!(
            workspace.write_file("file.txt", b"next", None),
            Err(WorkspaceError::UnknownOutcome(_))
        ));
    }
    fs::write(&path, b"original").unwrap();
    {
        let seams = Seams::new();
        corrupt_after_sync(&seams);
        match workspace.write_file("file.txt", b"next", Some(&content_sha256(b"original"))) {
            Err(WorkspaceError::UnknownOutcome(cause)) => {
                assert!(matches!(*cause, WorkspaceError::WriteVerificationFailed));
            }
            other => panic!("expected an unknown outcome, got {other:?}"),
        }
    }
    // Failures before truncation stay definitive.
    assert!(matches!(
        workspace.write_file("file.txt", b"next", Some(&content_sha256(b"stale"))),
        Err(WorkspaceError::WriteConflict { .. })
    ));
}
