//! Host keys for a DNS-named target are checked under the name (OpenSSH
//! semantics), never under the address the owner resolved.

use super::HostIdentity;
use crate::transport::{Transport, TransportConfig, host_key::HostKey, write_identity_fixture};
use crate::v1::ErrorCode;
use std::{
    fs,
    net::Ipv4Addr,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

const KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "bb-host-identity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        Self(dir)
    }

    /// A transport dialling 127.0.0.1:2200 whose `known_hosts` holds `records`.
    fn transport(&self, identity: HostIdentity, records: &[(&str, &str)]) -> Transport {
        let ssh = self.0.join("record-ssh");
        fs::write(&ssh, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();
        let known_hosts = self.0.join("known_hosts");
        let lines: String = records
            .iter()
            .map(|(label, key)| format!("{label} {key}\n"))
            .collect();
        fs::write(&known_hosts, lines).unwrap();
        fs::set_permissions(&known_hosts, fs::Permissions::from_mode(0o600)).unwrap();
        Transport::new(TransportConfig {
            ssh,
            keyscan: self.0.join("unused-keyscan"),
            host: Ipv4Addr::LOCALHOST.into(),
            port: 2200,
            user: "fixture".into(),
            identity: write_identity_fixture(&self.0),
            known_hosts,
            alias_config: None,
            system_config: None,
            workspace_root: None,
            dev_interactive_terminal: false,
            host_identity: identity,
        })
        .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn named(alias: Option<&str>) -> HostIdentity {
    HostIdentity {
        dns_name: Some("build.example.internal".into()),
        key_alias: alias.map(str::to_owned),
    }
}

fn key(record: &str) -> HostKey {
    HostKey::from_record(format!("x {record}").as_bytes(), "x").unwrap()
}

fn host_key_alias(transport: &Transport) -> Option<String> {
    let pinned = transport.pinned_ssh("-T").ok()?;
    let args: Vec<_> = pinned
        .command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    args.iter()
        .find_map(|arg| arg.strip_prefix("HostKeyAlias=").map(str::to_owned))
}

#[test]
fn a_named_target_verifies_against_the_name_keyed_record() {
    let fixture = Fixture::new();
    // Only the name-keyed record exists; the dialled address has none.
    let transport = fixture.transport(named(None), &[("[build.example.internal]:2200", KEY)]);
    assert!(
        transport
            .pin()
            .unwrap()
            .is_some_and(|pin| pin.key == key(KEY))
    );
    assert_eq!(
        host_key_alias(&transport).as_deref(),
        Some("[build.example.internal]:2200")
    );
}

#[test]
fn an_address_keyed_record_does_not_vouch_for_a_named_target() {
    let fixture = Fixture::new();
    let transport = fixture.transport(named(None), &[("[127.0.0.1]:2200", KEY)]);
    // The owner's single-record store fails closed on a record for another
    // label: the address-keyed pin never verifies the name.
    assert!(matches!(transport.pin(), Err(ErrorCode::HostKeyChanged)));
}

#[test]
fn an_explicit_host_key_alias_overrides_the_name() {
    let fixture = Fixture::new();
    let transport = fixture.transport(named(Some("build-key")), &[("build-key", KEY)]);
    assert!(
        transport
            .pin()
            .unwrap()
            .is_some_and(|pin| pin.key == key(KEY))
    );
    assert_eq!(host_key_alias(&transport).as_deref(), Some("build-key"));
    // The name's own label no longer vouches once an alias is set.
    let unaliased = Fixture::new();
    let transport = unaliased.transport(
        named(Some("build-key")),
        &[("[build.example.internal]:2200", OTHER)],
    );
    assert!(matches!(transport.pin(), Err(ErrorCode::HostKeyChanged)));
}

#[test]
fn an_ip_literal_target_is_unchanged() {
    let fixture = Fixture::new();
    let transport = fixture.transport(HostIdentity::default(), &[("[127.0.0.1]:2200", KEY)]);
    assert!(
        transport
            .pin()
            .unwrap()
            .is_some_and(|pin| pin.key == key(KEY))
    );
    assert_eq!(host_key_alias(&transport), None);
}

#[test]
fn a_changed_key_under_the_name_still_refuses() {
    let fixture = Fixture::new();
    let transport = fixture.transport(named(None), &[("[build.example.internal]:2200", KEY)]);
    let deadline = Instant::now() + Duration::from_secs(5);
    let observed = transport.inspect_with(deadline, |_| Ok(vec![key(OTHER)]));
    assert!(matches!(observed, Err(ErrorCode::HostKeyChanged)));
    let matching = transport
        .inspect_with(deadline, |_| Ok(vec![key(KEY)]))
        .unwrap();
    assert!(matching.verified);
}

#[test]
fn label_precedence_and_policy_matching() {
    let identity = named(None);
    assert_eq!(
        identity.label(None, 22, "127.0.0.1"),
        "build.example.internal"
    );
    assert_eq!(identity.label(Some("policy"), 22, "127.0.0.1"), "policy");
    assert_eq!(
        HostIdentity::default().label(None, 22, "127.0.0.1"),
        "127.0.0.1"
    );
    let address = Ipv4Addr::LOCALHOST.into();
    let name = crate::config::Host::Name("build.example.internal".into());
    assert!(identity.matches(&name, address));
    assert!(!identity.matches(&crate::config::Host::Ip(address), address));
    assert!(HostIdentity::default().matches(&crate::config::Host::Ip(address), address));
    assert!(!HostIdentity::default().matches(&name, address));
}

/// U23: OpenSSH-default host-key types. A pin is matched by any offered key of
/// a pinned type; a key of an unpinned type alone has changed; first use
/// challenges the most preferred offered key; the launch allows only the
/// pinned type (RSA with SHA-2 signatures only).
#[test]
fn multi_type_host_keys_follow_openssh_pinning() {
    use crate::transport::host_key::fixtures::{ECDSAB256, RSAB2048};
    let deadline = Instant::now() + Duration::from_secs(5);
    let fixture = Fixture::new();
    let pinned = fixture.transport(HostIdentity::default(), &[("[127.0.0.1]:2200", KEY)]);
    let only_rsa = pinned.inspect_with(deadline, |_| Ok(vec![key(RSAB2048.0)]));
    assert!(matches!(only_rsa, Err(ErrorCode::HostKeyChanged)));
    let both = pinned
        .inspect_with(deadline, |_| Ok(vec![key(KEY), key(ECDSAB256.0)]))
        .unwrap();
    assert!(both.verified && both.key_type == "ssh-ed25519");

    let fixture = Fixture::new();
    let rsa = fixture.transport(HostIdentity::default(), &[("[127.0.0.1]:2200", RSAB2048.0)]);
    let observed = rsa
        .inspect_with(deadline, |_| Ok(vec![key(KEY), key(RSAB2048.0)]))
        .unwrap();
    assert!(observed.verified && observed.key_type == "ssh-rsa");
    assert_eq!(observed.fingerprint, RSAB2048.1);
    let args: Vec<_> = rsa
        .pinned_ssh("-T")
        .unwrap()
        .command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert!(args.contains(&"HostKeyAlgorithms=rsa-sha2-512,rsa-sha2-256".to_owned()));

    let fixture = Fixture::new();
    let first_use = fixture.transport(HostIdentity::default(), &[]);
    let challenge = first_use
        .inspect_with(deadline, |_| Ok(vec![key(ECDSAB256.0), key(RSAB2048.0)]))
        .unwrap();
    assert!(!challenge.verified && challenge.key_type == "ecdsa-sha2-nistp256");
    assert_eq!(challenge.fingerprint, ECDSAB256.1);
}
