//! Descriptor bounds and grant binding for per-target admission (W3.7).

use super::super::{Registry, TargetAuthority};
use super::{Descriptor, MAX_TARGETS};
use crate::{
    owner_grants::{Binding, Grants},
    v1::{self, ErrorCode, TargetAuthMode, TargetKind},
};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
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
            "bigbud-target-descriptor-{}-{}",
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

#[test]
fn refuses_descriptor_bounds_and_unsupported_auth_modes() {
    let fixture = Fixture::new();
    let base = descriptor(
        "ssh:host=a",
        "127.0.0.1",
        2222,
        &fixture.identity,
        &fixture.trust,
        &[],
    );
    // In-app password (v1.credential.proto): a structured POSIX target is
    // admitted and marked; an alias password target stays unsupported policy.
    let mut password = base.clone();
    password.auth_mode = TargetAuthMode::Password as i32;
    #[cfg(unix)]
    assert!(Descriptor::parse(&password).unwrap().password);
    // A password target may name no identity at all; a key target may not.
    let mut keyless = password.clone();
    keyless.identity_reference = String::new();
    #[cfg(unix)]
    assert!(
        Descriptor::parse(&keyless)
            .unwrap()
            .identity
            .as_os_str()
            .is_empty()
    );
    let mut keyless_key = base.clone();
    keyless_key.identity_reference = String::new();
    assert_eq!(
        Descriptor::parse(&keyless_key).err(),
        Some(ErrorCode::InvalidOperands)
    );
    #[cfg(windows)]
    assert_eq!(
        Descriptor::parse(&password).err(),
        Some(ErrorCode::WindowsPasswordUnsupported)
    );
    let mut alias_password = password.clone();
    alias_password.kind = TargetKind::Alias as i32;
    #[cfg(unix)]
    assert_eq!(
        Descriptor::parse(&alias_password).err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    assert!(!Descriptor::parse(&base).unwrap().password);
    for malformed in [
        "-bad.example",
        "bad-.example",
        "a..b",
        "10.0.0",
        "has space",
        "x_y.z",
    ] {
        let mut hostname = base.clone();
        hostname.host = malformed.into();
        assert_eq!(
            Descriptor::parse(&hostname).err(),
            Some(ErrorCode::InvalidOperands),
            "{malformed}"
        );
    }
    let mut oversized = base.clone();
    oversized.target_id = "a".repeat(4 * 1024);
    assert_eq!(
        Descriptor::parse(&oversized).err(),
        Some(ErrorCode::InvalidOperands)
    );
    let mut relative = base.clone();
    relative.identity_reference = "relative/identity".into();
    assert_eq!(
        Descriptor::parse(&relative).err(),
        Some(ErrorCode::InvalidOperands)
    );
    assert!(Descriptor::parse(&base).is_ok());
}

#[test]
fn unsupported_target_policy_is_refused_before_any_dial_and_other_targets_survive() {
    let fixture = Fixture::new();
    let authority = fixture.authority();
    let mut registry = Registry::default();
    registry
        .resolve(
            Some(&authority),
            &request(
                Some(descriptor(
                    "ssh:host=good",
                    "127.0.0.1",
                    2222,
                    &fixture.identity,
                    &fixture.trust,
                    &[],
                )),
                "ssh:host=good",
                &[],
            ),
            None,
        )
        .unwrap();
    // Missing identity file: `IdentityFiles::bind` refuses before any SSH spawn.
    let missing = fixture.root.join("missing_identity");
    let refused = registry.resolve(
        Some(&authority),
        &request(
            Some(descriptor(
                "ssh:host=bad",
                "127.0.0.1",
                2222,
                &missing,
                &fixture.trust,
                &[],
            )),
            "ssh:host=bad",
            &[],
        ),
        None,
    );
    assert_eq!(refused.err(), Some(ErrorCode::ConfigUnsupported));
    // No entry was cached for the refused target, and the good target still works.
    assert!(registry.generation("ssh:host=bad").is_none());
    assert!(registry.generation("ssh:host=good").is_some());
    let slot = registry.take("ssh:host=good").unwrap();
    assert_eq!(slot.transport.as_ref().unwrap().host(), "127.0.0.1");
    registry.restore(slot);
    // Agent mode stays unsupported policy, not a credential prompt.
    let mut agent = descriptor(
        "ssh:host=agent",
        "127.0.0.1",
        2222,
        &fixture.identity,
        &fixture.trust,
        &[],
    );
    agent.auth_mode = TargetAuthMode::Agent as i32;
    assert_eq!(
        Descriptor::parse(&agent).err(),
        Some(ErrorCode::ConfigUnsupported)
    );
}

#[test]
fn grants_bind_the_target_and_generation_of_the_resolved_target() {
    let now = Instant::now();
    let mut grants = Grants::default();
    let issued = v1::Request {
        request_id: vec![1],
        target_id: "ssh:host=a".into(),
        ..v1::Request::default()
    };
    let operation = v1::request::Operation::InspectTrust(v1::Empty {});
    let mut granted_a = issued.clone();
    granted_a.grant = grants
        .issue(
            &issued,
            Binding {
                target_id: "ssh:host=a".into(),
                generation: vec![8; 32],
            },
            operation.clone(),
            now,
        )
        .unwrap()
        .to_vec();
    let other = v1::Request {
        target_id: "ssh:host=b".into(),
        ..granted_a.clone()
    };
    assert_eq!(
        grants.consume(&other, operation.clone(), now).err(),
        Some(ErrorCode::TargetMismatch)
    );
    let stale = v1::Request {
        target_generation: vec![9; 32],
        ..granted_a.clone()
    };
    assert_eq!(
        grants.consume(&stale, operation.clone(), now).err(),
        Some(ErrorCode::StaleGeneration)
    );
}

#[test]
fn target_count_admits_several_targets_and_stays_bounded() {
    assert!((2..=32).contains(&MAX_TARGETS));
}
