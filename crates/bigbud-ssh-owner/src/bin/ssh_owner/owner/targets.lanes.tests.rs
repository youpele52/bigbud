//! Per-target lane state, lease identity, budget isolation and alias
//! re-verification (W3.7 follow-up).

use super::{LeaseScope, Registry, Slot, TargetAuthority};
use crate::v1::{self, ErrorCode, TargetAuthMode, TargetKind};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    identity: PathBuf,
    trust: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-lanes-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let identity = write_private(&root, "id_ed25519", 0o600);
        write_private(&root, "known_hosts", 0o600);
        Self {
            trust: root.join("known_hosts"),
            root,
            identity,
        }
    }

    fn config(&self) -> PathBuf {
        let path = self.root.join("ssh-config");
        write_private_with(
            &path,
            format!(
                "{}{}",
                self.alias_block("target-a", 2222),
                self.alias_block("target-b", 2222)
            ),
        );
        path
    }

    fn alias_block(&self, alias: &str, port: u16) -> String {
        format!(
            "Host {alias}\n  HostName 127.0.0.1\n  Port {port}\n  User tester\n  \
             IdentityFile {}\n  UserKnownHostsFile {}\n",
            self.identity.display(),
            self.trust.display()
        )
    }

    fn authority(&self, config: &Path) -> TargetAuthority {
        TargetAuthority::new(
            self.identity.clone(),
            self.trust.clone(),
            None,
            Some(config.into()),
            None,
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write_private(root: &Path, name: &str, mode: u32) -> PathBuf {
    let path = root.join(name);
    write_private_with(&path, "synthetic identity for target lanes");
    let mut perms = fs::metadata(&path).unwrap().permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(mode);
    fs::set_permissions(&path, perms).unwrap();
    path
}

fn write_private_with(path: &Path, contents: impl Into<String>) {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(contents.into().as_bytes()).unwrap();
}

fn alias_descriptor(
    target: &str,
    port: u16,
    identity: &Path,
    trust: &Path,
    generation: &[u8],
) -> v1::TargetDescriptor {
    v1::TargetDescriptor {
        target_id: target.into(),
        kind: TargetKind::Alias as i32,
        host: "127.0.0.1".into(),
        port: u32::from(port),
        user: "tester".into(),
        auth_mode: TargetAuthMode::Key as i32,
        identity_reference: identity.to_str().unwrap().into(),
        host_key_alias: String::new(),
        trust_reference: trust.to_str().unwrap().into(),
        generation: generation.to_vec(),
    }
}

fn request(wire: Option<v1::TargetDescriptor>, target: &str, generation: &[u8]) -> v1::Request {
    v1::Request {
        request_id: vec![1],
        target_id: target.into(),
        target_generation: generation.to_vec(),
        target_descriptor: wire,
        ..v1::Request::default()
    }
}

fn resolve(
    registry: &mut Registry,
    authority: &TargetAuthority,
    fixture: &Fixture,
    target: &str,
    port: u16,
    generation: &[u8],
) -> Result<super::registry::Preview, ErrorCode> {
    registry.resolve(
        Some(authority),
        &request(
            Some(alias_descriptor(
                target,
                port,
                &fixture.identity,
                &fixture.trust,
                generation,
            )),
            target,
            generation,
        ),
        None,
    )
}

#[test]
fn lease_scope_rejects_a_stale_generation_or_foreign_target() {
    let scope = LeaseScope::new("ssh:host=a", [7; 32]);
    assert!(scope.admits("ssh:host=a", [7; 32]));
    assert!(!scope.admits("ssh:host=a", [8; 32]));
    assert!(!scope.admits("ssh:host=b", [7; 32]));
}

#[test]
fn lane_state_belongs_to_one_target_and_does_not_leak() {
    let fixture = Fixture::new();
    let config = fixture.config();
    let authority = fixture.authority(&config);
    let mut registry = Registry::default();
    resolve(&mut registry, &authority, &fixture, "target-a", 2222, &[]).unwrap();
    resolve(&mut registry, &authority, &fixture, "target-b", 2222, &[]).unwrap();

    // A terminal ambiguity on one target stays on that target.
    let mut first = registry.take("target-a").unwrap();
    first.lanes.terminal_uncertain = true;
    registry.restore(first);
    assert!(registry.lanes("target-a").unwrap().terminal_uncertain());
    assert!(!registry.lanes("target-b").unwrap().terminal_uncertain());

    // An agent close ambiguity stays on that target too.
    let mut second = registry.take("target-b").unwrap();
    second.lanes.agent_close_uncertain = true;
    registry.restore(second);
    assert!(!registry.lanes("target-a").unwrap().agent_close_uncertain);
    assert!(registry.lanes("target-b").unwrap().agent_close_uncertain);
}

#[test]
fn a_changed_alias_descriptor_invalidates_only_that_target() {
    let fixture = Fixture::new();
    let config = fixture.root.join("ssh-config");
    write_private_with(
        &config,
        format!(
            "{}{}",
            fixture.alias_block("target-a", 2222),
            fixture.alias_block("target-b", 2222)
        ),
    );
    let authority = fixture.authority(&config);
    let mut registry = Registry::default();
    resolve(&mut registry, &authority, &fixture, "target-a", 2222, &[]).unwrap();
    let second = resolve(&mut registry, &authority, &fixture, "target-b", 2222, &[]).unwrap();
    let second_generation = registry.generation(&second.target_id).unwrap();

    // The alias policy for target A changed behind the owner's back. Its cached
    // transport is dropped and the request is refused typed.
    write_private_with(
        &config,
        format!(
            "{}{}",
            fixture.alias_block("target-a", 2200),
            fixture.alias_block("target-b", 2222)
        ),
    );
    let first_generation = registry.generation("target-a").unwrap();
    assert_eq!(
        resolve(
            &mut registry,
            &authority,
            &fixture,
            "target-a",
            2222,
            &first_generation
        )
        .err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    let slot = registry.take("target-a").unwrap();
    assert!(slot.transport.is_none(), "stale transport was dropped");

    // Target B kept its cached transport, generation and lane state.
    assert_eq!(registry.generation("target-b"), Some(second_generation));
    let mut slot: Slot = registry.take("target-b").unwrap();
    assert_eq!(slot.transport.as_ref().unwrap().host(), "127.0.0.1");
    slot.lanes.terminal_uncertain = true;
    assert!(slot.lanes.terminal_uncertain());
}

#[test]
fn production_refusals_happen_before_a_transport_and_leave_other_targets_usable() {
    let fixture = Fixture::new();
    let config = fixture.config();
    write_private_with(
        &config,
        format!(
            "{}Host broken\n  HostName 127.0.0.1\n  Port 2222\n  User tester\n  \
             IdentityFile {}\n  UserKnownHostsFile {}\n  ForwardAgent yes\n",
            fixture.alias_block("target-good", 2222),
            fixture.identity.display(),
            fixture.trust.display()
        ),
    );
    let authority = fixture.authority(&config);
    let mut registry = Registry::default();
    let good = resolve(
        &mut registry,
        &authority,
        &fixture,
        "target-good",
        2222,
        &[],
    )
    .unwrap();
    let good_generation = registry.generation(&good.target_id).unwrap();

    // An unresolved alias is refused while resolving, before any transport.
    assert_eq!(
        resolve(
            &mut registry,
            &authority,
            &fixture,
            "target-missing",
            2222,
            &[]
        )
        .err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    // A policy the production owner does not admit is refused at the same point.
    assert_eq!(
        resolve(&mut registry, &authority, &fixture, "broken", 2222, &[]).err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    // A wrong-mode identity is refused before a transport exists.
    let bad_identity = write_private(&fixture.root, "bad_identity", 0o644);
    let bad = v1::TargetDescriptor {
        target_id: "target-bad-identity".into(),
        kind: TargetKind::Structured as i32,
        host: "127.0.0.1".into(),
        port: 2222,
        user: "tester".into(),
        auth_mode: TargetAuthMode::Key as i32,
        identity_reference: bad_identity.to_str().unwrap().into(),
        host_key_alias: String::new(),
        trust_reference: fixture.trust.to_str().unwrap().into(),
        generation: Vec::new(),
    };
    let request = request(Some(bad), "target-bad-identity", &[]);
    assert_eq!(
        registry.resolve(Some(&authority), &request, None).err(),
        Some(ErrorCode::ConfigUnsupported)
    );

    // None of the refusals touched the usable target's cached transport or
    // generation, and it still resolves normally.
    assert_eq!(registry.generation("target-good"), Some(good_generation));
    let slot = registry.take("target-good").unwrap();
    assert!(slot.transport.is_some());
    registry.restore(slot);
    assert!(
        resolve(
            &mut registry,
            &authority,
            &fixture,
            "target-good",
            2222,
            &good_generation
        )
        .is_ok()
    );
}
