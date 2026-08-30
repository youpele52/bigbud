use std::fs::{self, File};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use bigbud_protocol::v1;

use super::UnixExecutor;

fn temp_root(tag: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "bigbud-cleanup-{tag}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&root).expect("create root");
    root
}

fn identity(path: &std::path::Path) -> v1::ResourceCleanupIdentity {
    let metadata = fs::symlink_metadata(path).expect("metadata");
    v1::ResourceCleanupIdentity {
        device_or_volume: metadata.dev().to_string(),
        inode_or_file_id: metadata.ino().to_string(),
        entry_type: if metadata.is_dir() {
            v1::ResourceCleanupEntryType::Directory as i32
        } else {
            v1::ResourceCleanupEntryType::File as i32
        },
    }
}

fn execute(
    root: &std::path::Path,
    relative: &str,
    expected: v1::ResourceCleanupIdentity,
    quarantine: &str,
) -> v1::ResourceCleanupOutcome {
    execute_with_deadline(root, relative, expected, quarantine, u64::MAX)
}

fn execute_with_deadline(
    root: &std::path::Path,
    relative: &str,
    expected: v1::ResourceCleanupIdentity,
    quarantine: &str,
    deadline: u64,
) -> v1::ResourceCleanupOutcome {
    execute_with_options(root, relative, expected, quarantine, deadline, false)
}

fn execute_with_options(
    root: &std::path::Path,
    relative: &str,
    expected: v1::ResourceCleanupIdentity,
    quarantine: &str,
    deadline: u64,
    cancel: bool,
) -> v1::ResourceCleanupOutcome {
    let _guard = super::super::CANCELLATION_TEST_LOCK
        .lock()
        .expect("execution lock");
    let root_identity = identity(root);
    let mut executor = UnixExecutor::new();
    let handles = executor
        .bootstrap(vec![v1::ResourceCleanupRoot {
            root_id: "root".to_owned(),
            path: root.to_string_lossy().into_owned(),
            identity: Some(root_identity.clone()),
        }])
        .expect("bootstrap");
    let request = v1::ResourceCleanupRequest {
        request_id: "request".to_owned(),
        operation_id: "operation".to_owned(),
        page_digest: vec![1; 32],
        deadline_unix_ms: deadline,
        platform: std::env::consts::OS.to_owned(),
        resources: vec![v1::ResourceCleanupResource {
            resource_id: "resource".to_owned(),
            root_handle: handles[0].root_handle.clone(),
            relative_path: relative.to_owned(),
            quarantine_name: quarantine.to_owned(),
            identity: Some(expected),
            root_identity: Some(root_identity.clone()),
            parent_identity: Some(root_identity),
            action: v1::ResourceCleanupAction::Delete as i32,
        }],
        plan_digest: vec![1; 32],
        finalize_proof_digest: vec![2; 32],
        authorization_digest: vec![3; 32],
    };
    if cancel {
        super::super::request_cancellation();
    }
    let outcome = v1::ResourceCleanupOutcome::try_from(executor.execute(request)[0].outcome)
        .expect("outcome");
    super::super::reset_cancellation();
    outcome
}

#[test]
fn reports_an_absent_target_idempotently() {
    let root = temp_root("absent");
    let target = root.join("target");
    fs::write(&target, b"content").expect("target");
    let captured = identity(&target);
    fs::remove_file(target).expect("remove target");
    assert_eq!(
        execute(&root, "target", captured, ".bigbud-cleanup-absent"),
        v1::ResourceCleanupOutcome::AlreadyAbsent
    );
    fs::remove_dir(root).expect("cleanup");
}

#[test]
fn retains_both_entries_on_a_quarantine_collision() {
    let root = temp_root("collision");
    let target = root.join("target");
    let quarantine = root.join(".bigbud-cleanup-collision");
    fs::write(&target, b"target").expect("target");
    fs::write(&quarantine, b"collision").expect("quarantine");
    assert_eq!(
        execute(
            &root,
            "target",
            identity(&target),
            ".bigbud-cleanup-collision"
        ),
        v1::ResourceCleanupOutcome::IdentityMismatch
    );
    assert!(target.exists());
    assert!(quarantine.exists());
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn enforces_the_request_deadline_before_mutation() {
    let root = temp_root("deadline");
    let target = root.join("target");
    fs::write(&target, b"target").expect("target");
    assert_eq!(
        execute_with_deadline(
            &root,
            "target",
            identity(&target),
            ".bigbud-cleanup-deadline",
            0,
        ),
        v1::ResourceCleanupOutcome::DeadlineExceeded
    );
    assert!(target.exists());
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn refuses_operation_lock_contention() {
    let root = temp_root("lock");
    let target = root.join("target");
    fs::write(&target, b"target").expect("target");
    let held = File::open(&root).expect("open root");
    // SAFETY: held owns the live descriptor for the duration of the lock.
    assert_eq!(
        unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    assert_eq!(
        execute(&root, "target", identity(&target), ".bigbud-cleanup-lock"),
        v1::ResourceCleanupOutcome::Busy
    );
    // SAFETY: held still owns the descriptor that acquired the lock.
    assert_eq!(unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_UN) }, 0);
    drop(held);
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn rejects_a_special_child_without_removing_it() {
    let root = temp_root("special");
    let target = root.join("target");
    fs::create_dir(&target).expect("target");
    let fifo = target.join("fifo");
    let fifo_name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).expect("fifo name");
    // SAFETY: fifo_name is a valid NUL-terminated path in the temporary directory.
    assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
    assert_eq!(
        execute(
            &root,
            "target",
            identity(&target),
            ".bigbud-cleanup-special"
        ),
        v1::ResourceCleanupOutcome::UnsupportedEntry
    );
    assert!(target.join("fifo").exists());
    assert!(!root.join(".bigbud-cleanup-special").exists());
    fs::remove_dir_all(root).expect("cleanup");
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires passwordless sudo mount capability"]
fn refuses_a_same_device_bind_mount_boundary() {
    let root = temp_root("bind-mount");
    let outside = temp_root("bind-source");
    fs::write(outside.join("sentinel"), b"retain").expect("sentinel");
    let target = root.join("target");
    let mounted = target.join("mounted");
    fs::create_dir_all(&mounted).expect("mount point");
    let status = std::process::Command::new("sudo")
        .args(["mount", "--bind"])
        .arg(&outside)
        .arg(&mounted)
        .status()
        .expect("bind mount");
    assert!(status.success());
    assert_eq!(
        execute(
            &root,
            "target",
            identity(&target),
            ".bigbud-cleanup-bind-mount"
        ),
        v1::ResourceCleanupOutcome::UnsupportedEntry
    );
    assert!(target.exists());
    assert!(!root.join(".bigbud-cleanup-bind-mount").exists());
    let status = std::process::Command::new("sudo")
        .arg("umount")
        .arg(&mounted)
        .status()
        .expect("unmount");
    assert!(status.success());
    assert_eq!(
        fs::read(outside.join("sentinel")).expect("sentinel"),
        b"retain"
    );
    fs::remove_dir_all(root).expect("root cleanup");
    fs::remove_dir_all(outside).expect("outside cleanup");
}

#[test]
fn removes_a_nested_directory_without_following_symlink_children() {
    let root = temp_root("directory");
    let target = root.join("target");
    fs::create_dir(&target).expect("target");
    fs::write(target.join("file"), b"content").expect("file");
    let outside = root.with_extension("outside");
    fs::write(&outside, b"keep").expect("outside");
    std::os::unix::fs::symlink(&outside, target.join("link")).expect("symlink");
    let outcome = execute(
        &root,
        "target",
        identity(&target),
        ".bigbud-cleanup-directory",
    );
    assert_eq!(outcome, v1::ResourceCleanupOutcome::Removed);
    assert!(!target.exists());
    assert_eq!(fs::read(&outside).expect("outside retained"), b"keep");
    fs::remove_file(outside).expect("remove outside");
    fs::remove_dir(root).expect("remove root");
}

#[test]
fn rejects_a_symlink_ancestor_without_mutating_its_target() {
    let root = temp_root("symlink-ancestor");
    let outside = root.with_extension("outside");
    fs::create_dir(&outside).expect("outside");
    let target = outside.join("target");
    fs::write(&target, b"keep").expect("target");
    std::os::unix::fs::symlink(&outside, root.join("link")).expect("symlink");
    assert_eq!(
        execute(
            &root,
            "link/target",
            identity(&target),
            ".bigbud-cleanup-symlink-ancestor"
        ),
        v1::ResourceCleanupOutcome::UnsupportedEntry
    );
    assert_eq!(fs::read(&target).expect("target retained"), b"keep");
    fs::remove_dir_all(root).expect("root cleanup");
    fs::remove_dir_all(outside).expect("outside cleanup");
}

#[test]
fn resumes_only_a_matching_quarantine() {
    let root = temp_root("resume");
    let quarantine = root.join(".bigbud-cleanup-resume");
    fs::write(&quarantine, b"content").expect("quarantine");
    let outcome = execute(
        &root,
        "target",
        identity(&quarantine),
        ".bigbud-cleanup-resume",
    );
    assert_eq!(outcome, v1::ResourceCleanupOutcome::ResumedAndRemoved);
    assert!(!quarantine.exists());
    fs::remove_dir(root).expect("remove root");
}

#[test]
fn retains_a_replacement_target() {
    let root = temp_root("replacement");
    let target = root.join("target");
    fs::write(&target, b"first").expect("first");
    let captured = identity(&target);
    fs::remove_file(&target).expect("remove first");
    fs::write(&target, b"replacement").expect("replacement");
    let outcome = execute(&root, "target", captured, ".bigbud-cleanup-replacement");
    assert_eq!(outcome, v1::ResourceCleanupOutcome::IdentityMismatch);
    assert_eq!(fs::read(&target).expect("retained"), b"replacement");
    fs::remove_dir_all(root).expect("cleanup");
}

#[path = "unix.tests.bounds.rs"]
mod bounds;
