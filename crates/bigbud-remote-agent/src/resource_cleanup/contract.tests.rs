use bigbud_protocol::v1;

use super::{safe_quarantine_for, safe_relative_for, validate_identity, validate_request};

fn identity(kind: v1::ResourceCleanupEntryType) -> v1::ResourceCleanupIdentity {
    v1::ResourceCleanupIdentity {
        device_or_volume: "1".to_owned(),
        inode_or_file_id: "2".to_owned(),
        entry_type: kind as i32,
    }
}

fn resource(relative_path: &str) -> v1::ResourceCleanupResource {
    v1::ResourceCleanupResource {
        resource_id: "resource".to_owned(),
        root_handle: "root-0".to_owned(),
        relative_path: relative_path.to_owned(),
        quarantine_name: ".bigbud-cleanup-target".to_owned(),
        identity: Some(identity(v1::ResourceCleanupEntryType::File)),
        root_identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
        parent_identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
        action: v1::ResourceCleanupAction::Delete as i32,
    }
}

#[test]
fn rejects_non_canonical_decimal_identity() {
    let mut value = identity(v1::ResourceCleanupEntryType::File);
    value.inode_or_file_id = "02".to_owned();
    assert_eq!(
        validate_identity(&value),
        Err("INVALID_IDENTITY".to_owned())
    );
}

#[test]
fn rejects_duplicate_resource_ids_and_unsafe_paths() {
    let resource = resource("../escape");
    let request = v1::ResourceCleanupRequest {
        request_id: "request".to_owned(),
        operation_id: "operation".to_owned(),
        page_digest: vec![0; 32],
        deadline_unix_ms: u64::MAX,
        platform: std::env::consts::OS.to_owned(),
        resources: vec![resource.clone(), resource],
        plan_digest: vec![0; 32],
        finalize_proof_digest: vec![0; 32],
        authorization_digest: vec![0; 32],
    };
    assert_eq!(
        validate_request(&request),
        Err("INVALID_RESOURCE".to_owned())
    );
}

#[test]
fn applies_windows_ads_rules_independently_of_the_host() {
    assert!(safe_relative_for("folder/file:stream", false));
    assert!(!safe_relative_for("folder/file:stream", true));
    assert!(safe_quarantine_for(".bigbud-cleanup-target:stream", false));
    assert!(!safe_quarantine_for(".bigbud-cleanup-target:stream", true));
}

#[cfg(unix)]
#[test]
fn rejects_the_filesystem_root() {
    let request = v1::ResourceCleanupRootBootstrapRequest {
        request_id: "request".to_owned(),
        platform: std::env::consts::OS.to_owned(),
        roots: vec![v1::ResourceCleanupRoot {
            root_id: "root".to_owned(),
            path: "/".to_owned(),
            identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
        }],
    };
    assert_eq!(
        super::validate_bootstrap(&request),
        Err("INVALID_ROOT".to_owned())
    );
}

#[test]
fn rejects_the_user_home_as_an_explicit_forbidden_root() {
    let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) else {
        return;
    };
    let request = v1::ResourceCleanupRootBootstrapRequest {
        request_id: "request".to_owned(),
        platform: std::env::consts::OS.to_owned(),
        roots: vec![v1::ResourceCleanupRoot {
            root_id: "root".to_owned(),
            path: std::path::PathBuf::from(home)
                .to_string_lossy()
                .into_owned(),
            identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
        }],
    };
    assert_eq!(
        super::validate_bootstrap(&request),
        Err("FORBIDDEN_ROOT".to_owned())
    );
}

#[test]
fn rejects_temporary_and_system_directories_as_forbidden_roots() {
    let request = v1::ResourceCleanupRootBootstrapRequest {
        request_id: "request".to_owned(),
        platform: std::env::consts::OS.to_owned(),
        roots: vec![v1::ResourceCleanupRoot {
            root_id: "root".to_owned(),
            path: std::env::temp_dir().to_string_lossy().into_owned(),
            identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
        }],
    };
    assert_eq!(
        super::validate_bootstrap(&request),
        Err("FORBIDDEN_ROOT".to_owned())
    );
    #[cfg(unix)]
    {
        let mut system_request = request;
        system_request.roots[0].path = "/etc".to_owned();
        assert_eq!(
            super::validate_bootstrap(&system_request),
            Err("FORBIDDEN_ROOT".to_owned())
        );
    }
}

#[test]
fn rejects_a_page_digest_that_does_not_match_the_canonical_resources() {
    let resource = resource("target");
    let mut request = v1::ResourceCleanupRequest {
        request_id: "request".to_owned(),
        operation_id: "operation".to_owned(),
        page_digest: super::page_digest(std::slice::from_ref(&resource)).to_vec(),
        deadline_unix_ms: u64::MAX,
        platform: std::env::consts::OS.to_owned(),
        resources: vec![resource],
        plan_digest: vec![1; 32],
        finalize_proof_digest: vec![2; 32],
        authorization_digest: Vec::new(),
    };
    request.authorization_digest = super::authorization_digest(&request).to_vec();
    request.resources[0].relative_path = "changed".to_owned();
    assert_eq!(
        validate_request(&request),
        Err("INVALID_PAGE_DIGEST".to_owned())
    );
}
