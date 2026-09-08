use super::*;

#[test]
fn retains_a_file_when_the_known_byte_bound_is_exceeded() {
    let root = temp_root("known-byte-bound");
    let target = root.join("target");
    let file = File::create(&target).expect("target");
    file.set_len(super::super::super::MAX_KNOWN_BYTES + 1)
        .expect("sparse file length");
    assert_eq!(
        execute(
            &root,
            "target",
            identity(&target),
            ".bigbud-cleanup-known-byte-bound"
        ),
        v1::ResourceCleanupOutcome::UnsupportedEntry
    );
    assert!(target.exists());
    assert!(!root.join(".bigbud-cleanup-known-byte-bound").exists());
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn observes_cancellation_before_mutating_the_next_entry() {
    let root = temp_root("cancelled");
    let target = root.join("target");
    fs::write(&target, b"retain").expect("target");
    let outcome = execute_with_options(
        &root,
        "target",
        identity(&target),
        ".bigbud-cleanup-cancelled",
        u64::MAX,
        true,
    );
    assert_eq!(outcome, v1::ResourceCleanupOutcome::ProcessFailure);
    assert!(target.exists());
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn refuses_a_managed_root_replaced_after_bootstrap() {
    let root = temp_root("root-replacement");
    let displaced = root.with_extension("displaced");
    let target = root.join("target");
    fs::write(&target, b"retain").expect("target");
    let root_identity = identity(&root);
    let target_identity = identity(&target);
    let mut executor = UnixExecutor::new();
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
        platform: std::env::consts::OS.to_owned(),
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
