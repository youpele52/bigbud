use std::path::{Component, Path};

use bigbud_protocol::v1;
use sha2::{Digest, Sha256};

use super::{MAX_RESOURCES, MAX_ROOTS};

pub fn validate_bootstrap(request: &v1::ResourceCleanupRootBootstrapRequest) -> Result<(), String> {
    if request.request_id.is_empty()
        || request.request_id.len() > 512
        || request.platform != std::env::consts::OS
    {
        return Err("INVALID_BOOTSTRAP".to_owned());
    }
    if request.roots.is_empty() || request.roots.len() > MAX_ROOTS {
        return Err("ROOT_LIMIT".to_owned());
    }
    let mut ids = std::collections::HashSet::new();
    let mut paths = Vec::new();
    for root in &request.roots {
        if root.root_id.is_empty() || root.root_id.len() > 64 || !ids.insert(root.root_id.as_str())
        {
            return Err("DUPLICATE_ROOT".to_owned());
        }
        let path = Path::new(&root.path);
        let Some(identity) = root.identity.as_ref() else {
            return Err("INVALID_ROOT".to_owned());
        };
        if root.path.len() > 4096
            || !path.is_absolute()
            || path.parent().is_none()
            || identity.entry_type != v1::ResourceCleanupEntryType::Directory as i32
        {
            return Err("INVALID_ROOT".to_owned());
        }
        validate_identity(identity)?;
        let canonical = std::fs::canonicalize(path).map_err(|_| "INVALID_ROOT".to_owned())?;
        if forbidden_root(&canonical) {
            return Err("FORBIDDEN_ROOT".to_owned());
        }
        if paths.iter().any(|other: &std::path::PathBuf| {
            canonical.starts_with(other) || other.starts_with(&canonical)
        }) {
            return Err("OVERLAPPING_ROOTS".to_owned());
        }
        paths.push(canonical);
    }
    Ok(())
}

pub fn validate_request(request: &v1::ResourceCleanupRequest) -> Result<(), String> {
    if request.request_id.is_empty()
        || request.request_id.len() > 512
        || request.operation_id.is_empty()
        || request.operation_id.len() > 512
        || request.page_digest.len() != 32
        || request.plan_digest.len() != 32
        || request.finalize_proof_digest.len() != 32
        || request.authorization_digest.len() != 32
        || request.platform != std::env::consts::OS
        || request.resources.is_empty()
        || request.resources.len() > MAX_RESOURCES
    {
        return Err("INVALID_REQUEST".to_owned());
    }
    let mut ids = std::collections::HashSet::new();
    for resource in &request.resources {
        if resource.resource_id.is_empty()
            || resource.resource_id.len() > 512
            || !ids.insert(resource.resource_id.as_str())
            || resource.root_handle.is_empty()
            || resource.root_handle.len() > 64
            || resource.relative_path.len() > 4096
            || resource.quarantine_name.len() > 255
            || !safe_relative(&resource.relative_path)
            || !safe_quarantine(&resource.quarantine_name)
            || resource.root_identity.is_none()
            || resource.parent_identity.is_none()
            || resource.action != v1::ResourceCleanupAction::Delete as i32
        {
            return Err("INVALID_RESOURCE".to_owned());
        }
        if let Some(identity) = &resource.identity {
            validate_identity(identity)?;
        }
        if let Some(identity) = &resource.root_identity {
            validate_identity(identity)?;
        }
        if let Some(identity) = &resource.parent_identity {
            validate_identity(identity)?;
        }
    }
    let expected_page = page_digest(&request.resources);
    if request.page_digest.as_slice() != expected_page.as_slice() {
        return Err("INVALID_PAGE_DIGEST".to_owned());
    }
    let expected_authorization = authorization_digest(request);
    if request.authorization_digest.as_slice() != expected_authorization.as_slice() {
        return Err("INVALID_FINALIZE_PROOF".to_owned());
    }
    Ok(())
}

/// Rejects requests whose proof cannot be bound to this operation and exact page before mutation.
pub(super) fn authorization_digest(request: &v1::ResourceCleanupRequest) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"bigbud.resource-cleanup.authorization.v1\0");
    digest_string(&mut hasher, &request.request_id);
    digest_string(&mut hasher, &request.operation_id);
    hasher.update(&request.plan_digest);
    hasher.update(&request.page_digest);
    hasher.update(&request.finalize_proof_digest);
    hasher.update(request.deadline_unix_ms.to_be_bytes());
    digest_string(&mut hasher, &request.platform);
    hasher.finalize().into()
}

pub(super) fn page_digest(resources: &[v1::ResourceCleanupResource]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"bigbud.resource-cleanup.page.v1\0");
    for resource in resources {
        digest_string(&mut hasher, &resource.resource_id);
        digest_string(&mut hasher, &resource.root_handle);
        digest_string(&mut hasher, &resource.relative_path);
        digest_string(&mut hasher, &resource.quarantine_name);
        digest_identity(&mut hasher, resource.identity.as_ref());
        digest_identity(&mut hasher, resource.root_identity.as_ref());
        digest_identity(&mut hasher, resource.parent_identity.as_ref());
        hasher.update([1]);
    }
    hasher.finalize().into()
}

fn digest_string(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u32).to_be_bytes());
    hasher.update(value.as_bytes());
}

fn digest_identity(hasher: &mut Sha256, identity: Option<&v1::ResourceCleanupIdentity>) {
    hasher.update([u8::from(identity.is_some())]);
    let Some(identity) = identity else { return };
    digest_string(hasher, &identity.device_or_volume);
    digest_string(hasher, &identity.inode_or_file_id);
    hasher.update([identity.entry_type as u8]);
}

fn forbidden_root(path: &Path) -> bool {
    if path.parent().is_none() {
        return true;
    }
    if std::env::var_os("USERPROFILE")
        .and_then(|home| std::fs::canonicalize(home).ok())
        .and_then(|home| home.parent().map(Path::to_path_buf))
        .is_some_and(|profiles| profiles == path)
    {
        return true;
    }
    let environment_roots = [
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
        std::env::var_os("SystemRoot"),
        std::env::var_os("WINDIR"),
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("ProgramData"),
        Some(std::env::temp_dir().into_os_string()),
    ];
    if environment_roots
        .into_iter()
        .flatten()
        .filter_map(|candidate| std::fs::canonicalize(candidate).ok())
        .any(|candidate| candidate == path)
    {
        return true;
    }
    #[cfg(unix)]
    {
        const SYSTEM_ROOTS: &[&str] = &[
            "/bin",
            "/boot",
            "/dev",
            "/etc",
            "/home",
            "/lib",
            "/lib64",
            "/proc",
            "/root",
            "/run",
            "/sbin",
            "/sys",
            "/tmp",
            "/usr",
            "/var",
            "/Applications",
            "/Library",
            "/System",
            "/Users",
            "/Volumes",
            "/private/tmp",
            "/private/var",
        ];
        if SYSTEM_ROOTS
            .iter()
            .filter_map(|candidate| std::fs::canonicalize(candidate).ok())
            .any(|candidate| candidate == path)
        {
            return true;
        }
    }
    false
}

pub fn validate_identity(identity: &v1::ResourceCleanupIdentity) -> Result<(), String> {
    if !canonical_decimal(&identity.device_or_volume)
        || !canonical_decimal(&identity.inode_or_file_id)
        || v1::ResourceCleanupEntryType::try_from(identity.entry_type).map_or(true, |kind| {
            kind == v1::ResourceCleanupEntryType::Unspecified
        })
    {
        return Err("INVALID_IDENTITY".to_owned());
    }
    Ok(())
}

fn canonical_decimal(value: &str) -> bool {
    !value.is_empty()
        && (value == "0" || !value.starts_with('0'))
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('\0')
        && Path::new(value).components().all(|component| {
            matches!(component, Component::Normal(_))
                && !component
                    .as_os_str()
                    .to_string_lossy()
                    .contains(['/', '\\'])
        })
}

fn safe_quarantine(value: &str) -> bool {
    value.starts_with(".bigbud-cleanup-") && safe_relative(value)
}

#[cfg(test)]
mod tests {
    use bigbud_protocol::v1;

    use super::{validate_identity, validate_request};

    fn identity(kind: v1::ResourceCleanupEntryType) -> v1::ResourceCleanupIdentity {
        v1::ResourceCleanupIdentity {
            device_or_volume: "1".to_owned(),
            inode_or_file_id: "2".to_owned(),
            entry_type: kind as i32,
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
        let resource = v1::ResourceCleanupResource {
            resource_id: "resource".to_owned(),
            root_handle: "root".to_owned(),
            relative_path: "../escape".to_owned(),
            quarantine_name: ".bigbud-cleanup-resource".to_owned(),
            identity: None,
            root_identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
            parent_identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
            action: v1::ResourceCleanupAction::Delete as i32,
        };
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
        let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        else {
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
        let resource = v1::ResourceCleanupResource {
            resource_id: "resource".to_owned(),
            root_handle: "root-0".to_owned(),
            relative_path: "target".to_owned(),
            quarantine_name: ".bigbud-cleanup-target".to_owned(),
            identity: Some(identity(v1::ResourceCleanupEntryType::File)),
            root_identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
            parent_identity: Some(identity(v1::ResourceCleanupEntryType::Directory)),
            action: v1::ResourceCleanupAction::Delete as i32,
        };
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
}
