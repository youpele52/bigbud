//! W2 T-files: a production target has no startup workspace root, so each file
//! request names its own root; a fixture keeps its exact startup root.

use super::{ErrorCode, Transport, root_authority, validate_path};
use crate::config::RouteFacts;
use crate::transport::{TransportConfig, host_identity::HostIdentity, write_identity_fixture};
use std::{
    fs,
    net::Ipv4Addr,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "bb-workspace-production-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        Self(dir)
    }

    fn transport(&self, root: Option<&str>, production: bool) -> Transport {
        let known_hosts = self.0.join("known_hosts");
        fs::write(&known_hosts, "").unwrap();
        fs::set_permissions(&known_hosts, fs::Permissions::from_mode(0o600)).unwrap();
        let facts = if production {
            RouteFacts::default().with_production()
        } else {
            RouteFacts::default()
        };
        Transport::new_with_facts(
            TransportConfig {
                ssh: PathBuf::from("/usr/bin/ssh"),
                keyscan: PathBuf::from("/usr/bin/ssh-keyscan"),
                host: Ipv4Addr::LOCALHOST.into(),
                port: 22,
                user: "dev".into(),
                identity: write_identity_fixture(&self.0),
                known_hosts,
                alias_config: None,
                system_config: None,
                workspace_root: root.map(PathBuf::from),
                dev_interactive_terminal: false,
                host_identity: HostIdentity::default(),
            },
            &facts,
        )
        .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn production_admits_each_request_root_under_the_normal_path_rule() {
    let fixture = Fixture::new();
    let transport = fixture.transport(None, true);
    for root in ["/home/dev/project", "/srv/a b/c"] {
        let authority = root_authority(&transport, root);
        assert_eq!(authority, Some(Path::new(root)));
        assert_eq!(
            validate_path(authority, root, "src/main.rs", false),
            Ok(root)
        );
        assert_eq!(validate_path(authority, root, "", true), Ok(root));
    }
    for root in ["/", "relative", "/a/../b", "/a//b", "/a/", "/a\0b", ""] {
        assert_eq!(
            validate_path(root_authority(&transport, root), root, "file", false),
            Err(ErrorCode::WorkspacePathDenied),
            "{root:?}"
        );
    }
    // Traversal inside an admitted root is still refused.
    let root = "/home/dev/project";
    for relative in ["../etc/passwd", "a/../../b", "/abs"] {
        assert_eq!(
            validate_path(root_authority(&transport, root), root, relative, false),
            Err(ErrorCode::WorkspacePathDenied),
            "{relative:?}"
        );
    }
}

#[test]
fn fixture_keeps_its_startup_root_and_an_unrooted_fixture_denies() {
    let fixture = Fixture::new();
    let pinned = fixture.transport(Some("/fixtures/project"), true);
    let other = "/home/dev/project";
    assert_eq!(
        validate_path(root_authority(&pinned, other), other, "file", false),
        Err(ErrorCode::WorkspacePathDenied)
    );
    let root = "/fixtures/project";
    assert_eq!(
        validate_path(root_authority(&pinned, root), root, "file", false),
        Ok(root)
    );
    let unrooted = fixture.transport(None, false);
    assert_eq!(root_authority(&unrooted, other), None);
}
