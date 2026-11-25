use super::{Slot, TargetAuthority};
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
            "bigbud-targets-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let identity = write_private(&root, "id_ed25519", 0o600);
        let trust = root.join("known_hosts");
        write_private(&root, "known_hosts", 0o600);
        Self {
            root,
            identity,
            trust,
        }
    }

    fn identity(&self, name: &str) -> PathBuf {
        write_private(&self.root, name, 0o600)
    }

    fn authority(&self) -> TargetAuthority {
        TargetAuthority::new(self.identity.clone(), self.trust.clone(), None, None, None)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write_private(root: &Path, name: &str, mode: u32) -> PathBuf {
    let path = root.join(name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(&path)
        .unwrap();
    file.write_all(b"synthetic identity for target resolution")
        .unwrap();
    path
}

fn descriptor(
    target: &str,
    host: &str,
    port: u16,
    identity: &Path,
    trust: &Path,
    generation: &[u8],
) -> v1::TargetDescriptor {
    v1::TargetDescriptor {
        target_id: target.into(),
        kind: TargetKind::Structured as i32,
        host: host.into(),
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

fn take_host(registry: &mut super::Registry, target: &str) -> String {
    let slot: Slot = registry.take(target).unwrap();
    let host = slot.transport.as_ref().unwrap().host().to_owned();
    registry.restore(slot);
    host
}

#[test]
fn one_owner_resolves_two_targets_with_separate_policy_and_generations() {
    let fixture = Fixture::new();
    let authority = fixture.authority();
    let other_identity = fixture.identity("id_other");
    let mut registry = super::Registry::default();
    let first = registry
        .resolve(
            Some(&authority),
            &request(
                Some(descriptor(
                    "ssh:host=a",
                    "127.0.0.1",
                    2222,
                    &fixture.identity,
                    &fixture.trust,
                    &[],
                )),
                "ssh:host=a",
                &[],
            ),
            None,
        )
        .unwrap();
    let second = registry
        .resolve(
            Some(&authority),
            &request(
                Some(descriptor(
                    "ssh:host=b",
                    "127.0.0.2",
                    2200,
                    &other_identity,
                    &fixture.trust,
                    &[],
                )),
                "ssh:host=b",
                &[],
            ),
            None,
        )
        .unwrap();
    assert_ne!(first.target_id, second.target_id);
    // Each target owns its resolved route, identity and generation.
    assert_eq!(take_host(&mut registry, "ssh:host=a"), "127.0.0.1");
    assert_eq!(take_host(&mut registry, "ssh:host=b"), "127.0.0.2");
    let first_generation = registry.generation("ssh:host=a").unwrap();
    assert_ne!(Some(first_generation), registry.generation("ssh:host=b"));
    // A repeat request with the same descriptor and generation is the same entry.
    let again = registry
        .resolve(
            Some(&authority),
            &request(
                Some(descriptor(
                    "ssh:host=a",
                    "127.0.0.1",
                    2222,
                    &fixture.identity,
                    &fixture.trust,
                    &first_generation,
                )),
                "ssh:host=a",
                &first_generation,
            ),
            None,
        )
        .unwrap();
    assert_eq!(again.target_id, first.target_id);
}

#[test]
fn stale_generation_is_refused_without_dropping_the_target() {
    let fixture = Fixture::new();
    let authority = fixture.authority();
    let mut registry = super::Registry::default();
    let resolved = registry
        .resolve(
            Some(&authority),
            &request(
                Some(descriptor(
                    "ssh:host=a",
                    "127.0.0.1",
                    2222,
                    &fixture.identity,
                    &fixture.trust,
                    &[],
                )),
                "ssh:host=a",
                &[],
            ),
            None,
        )
        .unwrap();
    assert_eq!(
        registry
            .resolve(
                Some(&authority),
                &request(
                    Some(descriptor(
                        "ssh:host=a",
                        "127.0.0.1",
                        2222,
                        &fixture.identity,
                        &fixture.trust,
                        &[7; 32],
                    )),
                    "ssh:host=a",
                    &[7; 32],
                ),
                None,
            )
            .err(),
        Some(ErrorCode::StaleGeneration)
    );
    // The resolved target is untouched and still addressable.
    assert!(registry.generation(&resolved.target_id).is_some());
}

#[test]
fn changed_descriptor_for_the_same_target_is_a_mismatch() {
    let fixture = Fixture::new();
    let authority = fixture.authority();
    let mut registry = super::Registry::default();
    registry
        .resolve(
            Some(&authority),
            &request(
                Some(descriptor(
                    "ssh:host=a",
                    "127.0.0.1",
                    2222,
                    &fixture.identity,
                    &fixture.trust,
                    &[],
                )),
                "ssh:host=a",
                &[],
            ),
            None,
        )
        .unwrap();
    let generation = registry.generation("ssh:host=a").unwrap();
    assert_eq!(
        registry
            .resolve(
                Some(&authority),
                &request(
                    Some(descriptor(
                        "ssh:host=a",
                        "127.0.0.1",
                        2200,
                        &fixture.identity,
                        &fixture.trust,
                        &generation,
                    )),
                    "ssh:host=a",
                    &generation,
                ),
                None,
            )
            .err(),
        Some(ErrorCode::TargetMismatch)
    );
}

#[test]
fn unknown_target_needs_a_descriptor_and_is_typed() {
    let fixture = Fixture::new();
    let authority = fixture.authority();
    let mut registry = super::Registry::default();
    assert_eq!(
        registry
            .resolve(Some(&authority), &request(None, "ssh:host=a", &[]), None)
            .err(),
        Some(ErrorCode::TargetUnknown)
    );
    // A descriptor without an owner authority cannot be admitted either.
    assert_eq!(
        registry
            .resolve(
                None,
                &request(
                    Some(descriptor(
                        "ssh:host=a",
                        "127.0.0.1",
                        2222,
                        &fixture.identity,
                        &fixture.trust,
                        &[],
                    )),
                    "ssh:host=a",
                    &[],
                ),
                None,
            )
            .err(),
        Some(ErrorCode::ConfigUnsupported)
    );
}

#[test]
fn fixture_target_parity_without_a_descriptor() {
    let fixture = Fixture::new();
    let authority = fixture.authority();
    let pinned = registry_for_pinned(&fixture);
    let mut pinned = pinned;
    let generation = pinned.generation("ssh:fixture").unwrap();
    let resolved = pinned
        .resolve(
            Some(&authority),
            &request(None, "ssh:fixture", &generation),
            Some(("ssh:fixture", [3; 32])),
        )
        .unwrap();
    assert_eq!(resolved.target_id, "ssh:fixture");
    // The same protections as a descriptor target.
    assert_eq!(
        pinned
            .resolve(
                Some(&authority),
                &request(None, "ssh:fixture", &[9; 32]),
                Some(("ssh:fixture", [3; 32])),
            )
            .err(),
        Some(ErrorCode::StaleGeneration)
    );
    assert_eq!(
        pinned
            .resolve(
                Some(&authority),
                &request(None, "ssh:other", &generation),
                Some(("ssh:fixture", [3; 32])),
            )
            .err(),
        Some(ErrorCode::TargetUnknown)
    );
    // And the same target is reachable through a production descriptor.
    let mut production = super::Registry::default();
    let described = production
        .resolve(
            Some(&authority),
            &request(
                Some(descriptor(
                    "ssh:fixture",
                    "127.0.0.1",
                    2222,
                    &fixture.identity,
                    &fixture.trust,
                    &[],
                )),
                "ssh:fixture",
                &[],
            ),
            None,
        )
        .unwrap();
    assert_eq!(described.target_id, "ssh:fixture");
    assert_eq!(
        take_host(&mut production, "ssh:fixture"),
        take_host(&mut pinned, "ssh:fixture")
    );
}

fn registry_for_pinned(fixture: &Fixture) -> super::Registry {
    let config = crate::transport::TransportConfig {
        ssh: fixture.identity.clone(),
        keyscan: fixture.trust.clone(),
        host: "127.0.0.1".parse().unwrap(),
        port: 2222,
        user: "tester".into(),
        identity: fixture.identity.clone(),
        known_hosts: fixture.trust.clone(),
        alias_config: None,
        system_config: None,
        workspace_root: None,
        dev_interactive_terminal: false,
    };
    let transport =
        crate::transport::Transport::new_with_facts(config, &crate::config::RouteFacts::default())
            .unwrap();
    super::Registry::with_pinned(
        "ssh:fixture".into(),
        [3; 32],
        transport,
        crate::owner_storage::Storage::unhydrated(),
    )
}
