//! Owner-side host-name resolution for target descriptors (W3.7).

use super::{Descriptor, Host, HostResolver, TargetAuthority};
use crate::v1::{self, ErrorCode, TargetAuthMode, TargetKind};
use std::{
    fs,
    net::{IpAddr, Ipv4Addr},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// Scripted resolver: records every lookup and answers from a fixed table.
struct Scripted {
    answer: Option<IpAddr>,
    lookups: Mutex<Vec<(String, u16)>>,
}

impl HostResolver for Scripted {
    fn resolve(&self, name: &str, port: u16) -> Option<IpAddr> {
        self.lookups.lock().unwrap().push((name.to_owned(), port));
        self.answer
    }
}

struct Files {
    root: PathBuf,
    identity: PathBuf,
    trust: PathBuf,
}

impl Files {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "bigbud-target-dns-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let private = |name: &str| {
            let path = root.join(name);
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .and_then(|mut file| {
                    std::io::Write::write_all(&mut file, b"synthetic identity for dns")
                })
                .unwrap();
            path
        };
        let identity = private("id_ed25519");
        let trust = private("known_hosts");
        Self {
            root,
            identity,
            trust,
        }
    }

    fn wire(&self, host: &str) -> v1::TargetDescriptor {
        v1::TargetDescriptor {
            target_id: "ssh:named".into(),
            kind: TargetKind::Structured as i32,
            host: host.into(),
            port: 2222,
            user: "tester".into(),
            auth_mode: TargetAuthMode::Key as i32,
            identity_reference: self.identity.to_str().unwrap().into(),
            host_key_alias: String::new(),
            trust_reference: self.trust.to_str().unwrap().into(),
            generation: Vec::new(),
        }
    }

    fn authority(&self, resolver: &Arc<Scripted>) -> TargetAuthority {
        TargetAuthority::new(self.identity.clone(), self.trust.clone(), None, None, None)
            .with_resolver(resolver.clone())
    }
}

impl Drop for Files {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn scripted(answer: Option<IpAddr>) -> Arc<Scripted> {
    Arc::new(Scripted {
        answer,
        lookups: Mutex::new(Vec::new()),
    })
}

#[test]
fn parses_host_names_and_keeps_ip_literals() {
    let files = Files::new();
    let named = Descriptor::parse(&files.wire("build-01.example.internal")).unwrap();
    assert_eq!(named.host, Host::Name("build-01.example.internal".into()));
    let literal = Descriptor::parse(&files.wire("192.0.2.7")).unwrap();
    assert_eq!(
        literal.host,
        Host::Ip(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 7)))
    );
    assert_eq!(
        Descriptor::parse(&files.wire("0.0.0.0")).err(),
        Some(ErrorCode::InvalidOperands)
    );
    let oversized = format!("{}.example", "a".repeat(250));
    assert_eq!(
        Descriptor::parse(&files.wire(&oversized)).err(),
        Some(ErrorCode::InvalidOperands)
    );
}

#[test]
fn the_owner_resolves_a_host_name_on_every_binding() {
    let files = Files::new();
    let address = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 9));
    let resolver = scripted(Some(address));
    let authority = files.authority(&resolver);
    let descriptor = Descriptor::parse(&files.wire("build.example.internal")).unwrap();
    let first = authority.bind(&descriptor).unwrap();
    assert_eq!(first.host, address);
    authority.bind(&descriptor).unwrap();
    // Nothing is cached in the authority: each binding performs its own lookup.
    assert_eq!(
        *resolver.lookups.lock().unwrap(),
        vec![
            ("build.example.internal".to_owned(), 2222),
            ("build.example.internal".to_owned(), 2222)
        ]
    );
}

#[test]
fn an_unresolvable_host_name_is_a_typed_refusal() {
    let files = Files::new();
    let resolver = scripted(None);
    let authority = files.authority(&resolver);
    let descriptor = Descriptor::parse(&files.wire("missing.example.internal")).unwrap();
    assert_eq!(
        authority.bind(&descriptor).err(),
        Some(ErrorCode::TargetHostUnresolved)
    );
}

#[test]
fn an_ip_literal_never_consults_the_resolver() {
    let files = Files::new();
    let resolver = scripted(None);
    let authority = files.authority(&resolver);
    let descriptor = Descriptor::parse(&files.wire("127.0.0.1")).unwrap();
    assert_eq!(
        authority.bind(&descriptor).unwrap().host,
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    );
    assert!(resolver.lookups.lock().unwrap().is_empty());
}

#[test]
fn the_system_resolver_refuses_a_reserved_unresolvable_name() {
    // `.invalid` is reserved (RFC 6761) and never resolves.
    assert_eq!(
        super::dns::SystemResolver.resolve("bigbud-owner-test.invalid", 22),
        None
    );
}

impl Files {
    /// A private alias config whose `HostName` is `host_name`.
    fn alias_config(&self, host_name: &str, extra: &str) -> PathBuf {
        let path = self.root.join("ssh-config");
        let body = format!(
            "Host named\n  HostName {host_name}\n  Port 2222\n  User tester\n  \
             IdentityFile {}\n  UserKnownHostsFile {}\n{extra}",
            self.identity.display(),
            self.trust.display()
        );
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .and_then(|mut file| std::io::Write::write_all(&mut file, body.as_bytes()))
            .unwrap();
        path
    }

    fn alias_wire(&self, host: &str) -> v1::TargetDescriptor {
        v1::TargetDescriptor {
            target_id: "named".into(),
            kind: TargetKind::Alias as i32,
            port: 2222,
            ..self.wire(host)
        }
    }
}

fn production_resolve(path: &std::path::Path, fixture_mode: bool) -> Result<Host, ErrorCode> {
    crate::config::resolve_for_startup(
        path,
        None,
        "named",
        &crate::config::RouteFacts::default().with_production(),
        !fixture_mode,
    )
    .map(|resolved| resolved.host)
}

#[test]
fn the_alias_parser_admits_a_dns_host_name_only_in_production() {
    let files = Files::new();
    let config = files.alias_config("build.example.internal", "");
    assert_eq!(
        production_resolve(&config, false),
        Ok(Host::Name("build.example.internal".into()))
    );
    // Fixture routes stay numeric loopback.
    assert_eq!(
        production_resolve(&config, true).err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    // A name cannot satisfy an explicit address family before resolution.
    let family = files.alias_config("build.example.internal", "  AddressFamily inet\n");
    assert_eq!(
        production_resolve(&family, false).err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    // The same shared rule refuses a malformed name.
    let malformed = files.alias_config("-bad.example", "");
    assert!(production_resolve(&malformed, false).is_err());
}

#[test]
fn an_alias_with_a_dns_host_name_binds_name_to_name_and_resolves_once() {
    let files = Files::new();
    let config = files.alias_config("build.example.internal", "");
    let address = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 11));
    let resolver = scripted(Some(address));
    let authority = TargetAuthority::new(
        files.identity.clone(),
        files.trust.clone(),
        None,
        Some(config),
        None,
    )
    .with_resolver(resolver.clone());
    let descriptor = Descriptor::parse(&files.alias_wire("build.example.internal")).unwrap();
    let bound = authority.bind(&descriptor).unwrap();
    assert_eq!(bound.host, address);
    assert_eq!(
        bound.host_identity.dns_name.as_deref(),
        Some("build.example.internal")
    );
    assert_eq!(resolver.lookups.lock().unwrap().len(), 1);
    // The resolved address does not stand in for the policy's name: comparison
    // is name against name, before any lookup.
    let by_address = Descriptor::parse(&files.alias_wire("192.0.2.11")).unwrap();
    assert_eq!(
        authority.bind(&by_address).err(),
        Some(ErrorCode::ConfigUnsupported)
    );
    assert_eq!(resolver.lookups.lock().unwrap().len(), 1);
}

#[test]
fn an_unresolvable_alias_host_name_is_a_typed_refusal() {
    let files = Files::new();
    let config = files.alias_config("missing.example.internal", "");
    let resolver = scripted(None);
    let authority = TargetAuthority::new(
        files.identity.clone(),
        files.trust.clone(),
        None,
        Some(config),
        None,
    )
    .with_resolver(resolver);
    let descriptor = Descriptor::parse(&files.alias_wire("missing.example.internal")).unwrap();
    assert_eq!(
        authority.bind(&descriptor).err(),
        Some(ErrorCode::TargetHostUnresolved)
    );
}
