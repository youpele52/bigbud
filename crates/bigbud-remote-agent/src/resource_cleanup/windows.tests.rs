use std::fs::{self, OpenOptions};
use std::io::{Read, Seek};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use bigbud_protocol::v1;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
};

use super::{WindowsExecutor, identity, open_verified};

#[test]
fn excludes_a_second_executor_with_the_operation_lock() {
    let root = temporary_root("lock");
    let root_file = open_verified(&root).expect("open root");
    let first = super::native::OperationLock::acquire(&root_file).expect("first lock");
    let error = match super::native::OperationLock::acquire(&root_file) {
        Ok(_) => panic!("second lock unexpectedly succeeded"),
        Err(error) => error,
    };
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
    drop(first);
    let second = super::native::OperationLock::acquire(&root_file).expect("lock after release");
    drop(second);
    remove_root(&root);
}

#[test]
fn removes_a_verified_file() {
    let root = temporary_root("file");
    let target = root.join("target");
    fs::write(&target, b"content").expect("target");

    assert_removed(&root, &target);
    remove_root(&root);
}

#[test]
fn removes_a_directory_tree_through_relative_handles() {
    let root = temporary_root("directory");
    let target = root.join("target");
    fs::create_dir(&target).expect("target");
    fs::write(target.join("child"), b"content").expect("child");

    assert_removed(&root, &target);
    remove_root(&root);
}

#[test]
fn removes_a_nested_target_through_a_verified_parent() {
    let root = temporary_root("nested-parent");
    let parent = root.join("nested");
    fs::create_dir(&parent).expect("parent");
    let target = parent.join("target");
    fs::write(&target, b"content").expect("target");

    assert_removed(&root, &target);
    fs::remove_dir(parent).expect("parent cleanup");
    remove_root(&root);
}

#[test]
fn rejects_an_ads_shaped_request_before_executor_mutation() {
    let root = temporary_root("ads");
    let target = root.join("target");
    fs::write(&target, b"retain").expect("target");
    let root_identity = identity(&open_verified(&root).expect("root")).expect("root identity");
    let target_identity =
        identity(&open_verified(&target).expect("target")).expect("target identity");
    let mut executor = WindowsExecutor::new();
    let handles = executor
        .bootstrap(vec![v1::ResourceCleanupRoot {
            root_id: "root".to_owned(),
            path: root.to_string_lossy().into_owned(),
            identity: Some(root_identity.clone()),
        }])
        .expect("bootstrap");
    let mut request = v1::ResourceCleanupRequest {
        request_id: "request".to_owned(),
        operation_id: "operation".to_owned(),
        page_digest: Vec::new(),
        plan_digest: vec![2; 32],
        finalize_proof_digest: vec![3; 32],
        authorization_digest: Vec::new(),
        deadline_unix_ms: u64::MAX,
        platform: "windows".to_owned(),
        resources: vec![v1::ResourceCleanupResource {
            resource_id: "resource".to_owned(),
            root_handle: handles[0].root_handle.clone(),
            relative_path: "target:stream".to_owned(),
            quarantine_name: ".bigbud-cleanup-target".to_owned(),
            identity: Some(target_identity),
            root_identity: Some(root_identity.clone()),
            parent_identity: Some(root_identity),
            action: v1::ResourceCleanupAction::Delete as i32,
        }],
    };
    request.page_digest = super::super::contract::page_digest(&request.resources).to_vec();
    request.authorization_digest = super::super::contract::authorization_digest(&request).to_vec();
    assert_eq!(
        super::super::contract::validate_request(&request),
        Err("INVALID_RESOURCE".to_owned())
    );
    assert!(target.exists());
    fs::remove_file(target).expect("target cleanup");
    remove_root(&root);
}

#[test]
fn resumes_a_matching_quarantine() {
    let root = temporary_root("resume");
    let quarantine = root.join(".bigbud-cleanup-target");
    fs::write(&quarantine, b"content").expect("quarantine");
    let expected =
        identity(&open_verified(&quarantine).expect("open quarantine")).expect("identity");

    assert_eq!(
        execute(&root, "target", expected),
        v1::ResourceCleanupOutcome::ResumedAndRemoved
    );
    assert!(!quarantine.exists());
    remove_root(&root);
}

#[test]
fn retains_both_entries_on_a_quarantine_collision() {
    let root = temporary_root("collision");
    let target = root.join("target");
    let quarantine = root.join(".bigbud-cleanup-target");
    fs::write(&target, b"target").expect("target");
    fs::write(&quarantine, b"collision").expect("quarantine");
    let expected = identity(&open_verified(&target).expect("open target")).expect("identity");

    assert_eq!(
        execute(&root, "target", expected),
        v1::ResourceCleanupOutcome::IdentityMismatch
    );
    assert!(target.exists());
    assert!(quarantine.exists());
    fs::remove_file(target).expect("target cleanup");
    fs::remove_file(quarantine).expect("quarantine cleanup");
    remove_root(&root);
}

#[test]
fn removes_junction_without_traversing_it() {
    let root = temporary_root("junction");
    let outside = temporary_root("junction-outside");
    let sentinel = outside.join("sentinel");
    fs::write(&sentinel, b"retain").expect("sentinel");
    let target = root.join("target");
    fs::create_dir(&target).expect("target");
    create_junction(&target.join("junction"), &outside);

    assert_removed(&root, &target);
    assert_eq!(fs::read(&sentinel).expect("retained sentinel"), b"retain");
    remove_root(&root);
    fs::remove_dir_all(outside).expect("outside cleanup");
}

#[test]
fn removes_a_file_while_a_delete_sharing_handle_is_open() {
    let root = temporary_root("sharing");
    let target = root.join("target");
    fs::write(&target, b"content").expect("target");
    let mut held = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(&target)
        .expect("shared handle");

    assert_removed(&root, &target);
    held.rewind().expect("rewind");
    let mut content = Vec::new();
    held.read_to_end(&mut content).expect("read held file");
    assert_eq!(content, b"content");
    drop(held);
    remove_root(&root);
}

fn assert_removed(root: &Path, target: &Path) {
    let target_identity =
        identity(&open_verified(target).expect("open target")).expect("target identity");
    let relative = target.strip_prefix(root).expect("relative target");
    assert_eq!(
        execute(root, &relative.to_string_lossy(), target_identity),
        v1::ResourceCleanupOutcome::Removed
    );
    assert!(!target.exists());
}

fn execute(
    root: &Path,
    relative_path: &str,
    target_identity: v1::ResourceCleanupIdentity,
) -> v1::ResourceCleanupOutcome {
    execute_with_options(root, relative_path, target_identity, false)
}

fn execute_with_options(
    root: &Path,
    relative_path: &str,
    target_identity: v1::ResourceCleanupIdentity,
    cancel: bool,
) -> v1::ResourceCleanupOutcome {
    let _guard = super::super::CANCELLATION_TEST_LOCK
        .lock()
        .expect("execution lock");
    let root_identity = identity(&open_verified(root).expect("open root")).expect("root identity");
    let parent = root
        .join(relative_path)
        .parent()
        .expect("parent")
        .to_owned();
    let parent_identity =
        identity(&open_verified(&parent).expect("open parent")).expect("parent identity");
    let mut executor = WindowsExecutor::new();
    let handles = executor
        .bootstrap(vec![v1::ResourceCleanupRoot {
            root_id: "root".to_owned(),
            path: root.to_string_lossy().into_owned(),
            identity: Some(root_identity.clone()),
        }])
        .expect("bootstrap");
    if cancel {
        super::super::request_cancellation();
    }
    let results = executor.execute(v1::ResourceCleanupRequest {
        request_id: "request".to_owned(),
        operation_id: "operation".to_owned(),
        page_digest: vec![1; 32],
        plan_digest: vec![2; 32],
        finalize_proof_digest: vec![3; 32],
        authorization_digest: vec![4; 32],
        deadline_unix_ms: u64::MAX,
        platform: "windows".to_owned(),
        resources: vec![v1::ResourceCleanupResource {
            resource_id: "resource".to_owned(),
            root_handle: handles[0].root_handle.clone(),
            relative_path: relative_path.to_owned(),
            quarantine_name: ".bigbud-cleanup-target".to_owned(),
            identity: Some(target_identity),
            root_identity: Some(root_identity.clone()),
            parent_identity: Some(parent_identity),
            action: v1::ResourceCleanupAction::Delete as i32,
        }],
    });
    let outcome = v1::ResourceCleanupOutcome::try_from(results[0].outcome).expect("outcome");
    super::super::reset_cancellation();
    outcome
}

#[test]
fn retains_a_file_when_the_known_byte_bound_is_exceeded() {
    let root = temporary_root("known-byte-bound");
    let target = root.join("target");
    let file = fs::File::create(&target).expect("target");
    file.set_len(super::super::MAX_KNOWN_BYTES + 1)
        .expect("sparse file length");
    let expected = identity(&open_verified(&target).expect("open target")).expect("identity");

    assert_eq!(
        execute(&root, "target", expected),
        v1::ResourceCleanupOutcome::UnsupportedEntry
    );
    assert!(target.exists());
    assert!(!root.join(".bigbud-cleanup-target").exists());
    fs::remove_file(target).expect("target cleanup");
    remove_root(&root);
}

#[test]
fn observes_cancellation_before_mutating_the_next_entry() {
    let root = temporary_root("cancelled");
    let target = root.join("target");
    fs::write(&target, b"retain").expect("target");
    let expected = identity(&open_verified(&target).expect("open target")).expect("identity");
    let outcome = execute_with_options(&root, "target", expected, true);
    assert_eq!(outcome, v1::ResourceCleanupOutcome::ProcessFailure);
    fs::remove_file(target).expect("target cleanup");
    remove_root(&root);
}

#[test]
fn refuses_a_managed_root_replaced_after_bootstrap() {
    let root = temporary_root("root-replacement");
    let displaced = root.with_extension("displaced");
    let target = root.join("target");
    fs::write(&target, b"retain").expect("target");
    let root_identity = identity(&open_verified(&root).expect("root")).expect("root identity");
    let target_identity = identity(&open_verified(&target).expect("target")).expect("identity");
    let mut executor = WindowsExecutor::new();
    let handles = executor
        .bootstrap(vec![v1::ResourceCleanupRoot {
            root_id: "root".to_owned(),
            path: root.to_string_lossy().into_owned(),
            identity: Some(root_identity.clone()),
        }])
        .expect("bootstrap");
    fs::rename(&root, &displaced).expect("displace root");
    fs::create_dir(&root).expect("replacement root");
    let results = executor.execute(v1::ResourceCleanupRequest {
        request_id: "request".to_owned(),
        operation_id: "operation".to_owned(),
        page_digest: vec![1; 32],
        deadline_unix_ms: u64::MAX,
        platform: "windows".to_owned(),
        resources: vec![v1::ResourceCleanupResource {
            resource_id: "resource".to_owned(),
            root_handle: handles[0].root_handle.clone(),
            relative_path: "target".to_owned(),
            quarantine_name: ".bigbud-cleanup-root-replacement".to_owned(),
            identity: Some(target_identity),
            root_identity: Some(root_identity.clone()),
            parent_identity: Some(root_identity),
            action: v1::ResourceCleanupAction::Delete as i32,
        }],
        plan_digest: vec![2; 32],
        finalize_proof_digest: vec![3; 32],
        authorization_digest: vec![4; 32],
    });
    assert_eq!(
        v1::ResourceCleanupOutcome::try_from(results[0].outcome).expect("outcome"),
        v1::ResourceCleanupOutcome::IdentityMismatch
    );
    assert!(displaced.join("target").exists());
    fs::remove_dir(root).expect("replacement cleanup");
    fs::remove_dir_all(displaced).expect("displaced cleanup");
}

fn temporary_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "bigbud-cleanup-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&root).expect("root");
    root
}

fn create_junction(junction: &Path, target: &Path) {
    let output = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(junction)
        .arg(target)
        .output()
        .expect("create junction");
    assert!(
        output.status.success(),
        "mklink failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn remove_root(root: &Path) {
    let lock = root.join(".bigbud-resource-cleanup.lock");
    if lock.exists() {
        fs::remove_file(lock).expect("lock cleanup");
    }
    fs::remove_dir(root).expect("root cleanup");
}
