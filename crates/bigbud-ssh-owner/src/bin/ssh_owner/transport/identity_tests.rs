use super::*;
use crate::transport::{Transport, TransportConfig};
use std::net::Ipv4Addr;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt, symlink};
use std::sync::atomic::{AtomicU64, Ordering};

const PIN: &[u8] = b"[127.0.0.1]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "bigbud-proof-identity-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        Self(root)
    }

    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        use std::io::Write;
        let path = self.0.join(name);
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
        path
    }

    fn config(&self) -> TransportConfig {
        TransportConfig {
            ssh: self.0.join("unused-ssh"),
            keyscan: self.0.join("unused-keyscan"),
            host: Ipv4Addr::LOCALHOST.into(),
            port: 2200,
            user: "fixture".into(),
            identity: self.0.join("identity"),
            known_hosts: self.0.join("known_hosts"),
            alias_config: None,
            system_config: None,
            workspace_root: None,
            dev_interactive_terminal: false,
            host_identity: Default::default(),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _removed = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn rejects_missing_nonprivate_nonregular_linked_or_unsafe_paths() {
    let fixture = Fixture::new();
    let rejected = |path: &Path| assert!(matches!(IdentityFile::bind(path), Err(UNSUPPORTED)));
    rejected(&fixture.0.join("missing"));
    rejected(&fixture.0);
    let identity = fixture.file("identity", b"unused fixture data");
    let metadata = fs::symlink_metadata(&identity).unwrap();
    assert!(!regular_owned(&metadata, metadata.uid().wrapping_add(1)));
    fs::set_permissions(&identity, fs::Permissions::from_mode(0o644)).unwrap();
    rejected(&identity);
    fs::set_permissions(&identity, fs::Permissions::from_mode(0o600)).unwrap();
    let link = fixture.0.join("link");
    symlink(&identity, &link).unwrap();
    rejected(&link);
    fs::remove_file(&link).unwrap();
    fs::hard_link(&identity, &link).unwrap();
    rejected(&identity);
    fs::remove_file(&link).unwrap();
    let parent_link = fixture.0.join("parent-link");
    symlink(&fixture.0, &parent_link).unwrap();
    rejected(&parent_link.join("identity"));
    rejected(&fixture.0.join("parent-link/../identity"));
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o755)).unwrap();
    rejected(&identity);
}

#[test]
fn unsafe_public_sidecar_cannot_reach_openssh() {
    let fixture = Fixture::new();
    let identity = fixture.file("identity", b"unused fixture data");
    let target = fixture.file("target", b"not the public sidecar");
    let sidecar = fixture.0.join("identity.pub");
    symlink(target, &sidecar).unwrap();
    assert!(matches!(IdentityFile::bind(&identity), Err(UNSUPPORTED)));
    fs::remove_file(sidecar).unwrap();
    let sidecar = fixture.file("identity.pub", b"public sidecar data");
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(IdentityFile::bind(&identity).is_ok());
}

#[test]
fn authenticated_launch_requires_pin_and_rechecks_the_bound_identity() {
    let fixture = Fixture::new();
    assert!(matches!(Transport::new(fixture.config()), Err(UNSUPPORTED)));
    // Opaque test bytes establish that owner admission does not parse a key.
    let identity = fixture.file("identity", b"unused fixture data");
    let transport = Transport::new(fixture.config()).unwrap();
    assert!(matches!(
        transport.pinned_ssh("-T"),
        Err(ErrorCode::TrustRequired)
    ));
    fixture.file("known_hosts", PIN);
    let pinned = transport.pinned_ssh("-T").unwrap();
    let argv = pinned.command.get_args().collect::<Vec<_>>();
    assert!(
        argv.windows(2)
            .any(|pair| pair == ["-i".as_ref(), identity.as_os_str()])
    );
    assert!(argv.contains(&"StrictHostKeyChecking=yes".as_ref()));
    assert!(argv.contains(&"PubkeyAcceptedAlgorithms=ssh-ed25519".as_ref()));
    assert!(argv.contains(&"IdentityAgent=none".as_ref()));
    assert!(argv.contains(&"BatchMode=yes".as_ref()));
    drop(pinned);
    fs::set_permissions(&identity, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(transport.pinned_ssh("-T"), Err(UNSUPPORTED)));
    fs::rename(&identity, fixture.0.join("old-identity")).unwrap();
    fixture.file("identity", b"unused fixture data");
    assert!(matches!(transport.pinned_ssh("-T"), Err(UNSUPPORTED)));
}

#[test]
fn applies_alias_and_included_identity_in_configured_order() {
    let fixture = Fixture::new();
    let system = Fixture::new();
    let mut config = fixture.config();
    let first = fixture.file("identity", b"first");
    let second = fixture.file("second-identity", b"second");
    let alias_pin = std::str::from_utf8(PIN)
        .unwrap()
        .replacen("[127.0.0.1]:2200", "proof-host", 1);
    fixture.file("known_hosts", alias_pin.as_bytes());
    fixture.file(
        "keys.conf",
        format!("IdentityFile {}\n", second.display()).as_bytes(),
    );
    let ssh_config = fixture.file(
        "config",
        format!(
            "Host proof\nHostName 127.0.0.1\nPort 2200\nUser fixture\nHostKeyAlias proof-host\nIdentityFile {}\nInclude keys.conf\nUserKnownHostsFile {}\n",
            first.display(),
            config.known_hosts.display()
        )
        .as_bytes(),
    );
    config.alias_config = Some((ssh_config, "proof".into()));
    config.system_config = Some(system.file("config", b"Host *\n"));
    let transport = Transport::new(config).unwrap();
    let pinned = transport.pinned_ssh("-T").unwrap();
    let argv = pinned.command.get_args().collect::<Vec<_>>();
    let identity_args = argv
        .windows(2)
        .filter(|pair| pair.first().is_some_and(|arg| *arg == "-i"));
    let admitted_paths = identity_args.filter_map(|pair| pair.get(1).copied());
    assert!(admitted_paths.eq([first.as_os_str(), second.as_os_str()]));
    assert!(argv.contains(&"HostKeyAlias=proof-host".as_ref()));
    fs::remove_file(second).unwrap();
    assert!(matches!(transport.pinned_ssh("-T"), Err(UNSUPPORTED)));
}
