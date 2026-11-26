use super::{MAX_ALIASES, list};
use crate::config::RouteFacts;
use crate::v1::AliasRouteKind;
use std::fs::{self, DirBuilder, OpenOptions, read_to_string};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> io::Result<Self> {
        let root = std::env::temp_dir().join(format!(
            "bigbud-alias-list-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        DirBuilder::new().mode(0o700).create(&root)?;
        Ok(Self(root))
    }

    fn config(&self) -> PathBuf {
        self.0.join("ssh-config")
    }

    fn write(&self, name: &str, text: &str) -> io::Result<()> {
        let path = self.0.join(name);
        if let Some(parent) = path.parent() {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        }
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?
            .write_all(text.as_bytes())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run(fixture: &Fixture) -> Result<crate::v1::ProofAliases, crate::v1::ErrorCode> {
    list(&fixture.config(), None, &RouteFacts::default())
}

#[test]
fn discovers_literals_wildcards_includes_ports_and_ipv6() {
    let fixture = Fixture::new().expect("fixture");
    fixture
        .write(
            "ssh-config",
            [
                "Host !prod-* build-box",
                "  HostName build.internal",
                "  User ci",
                "  Port 2222",
                "Host v6-box",
                "  HostName ::1",
                "  HostKeyAlias v6-trust",
                "  Port 22222",
                "Include hosts.d/*.conf",
                "Host prod-web",
                "  HostName prod.internal",
                "Host *",
                "  User fallback",
                "",
            ]
            .join("\n")
            .as_str(),
        )
        .expect("config");
    fixture
        .write(
            "hosts.d/a.conf",
            "Host from-a\n  HostName a.internal\n  Port 2200\n",
        )
        .expect("a");
    fixture.write("hosts.d/b.conf", "Host from-b\n").expect("b");

    let aliases = run(&fixture).expect("list");

    let names: Vec<_> = aliases
        .entries
        .iter()
        .map(|entry| entry.alias.as_str())
        .collect();
    assert_eq!(
        names,
        ["build-box", "v6-box", "from-a", "from-b", "prod-web"]
    );
    assert!(!aliases.truncated);

    let build = &aliases.entries[0];
    assert_eq!(build.host_name, "build.internal");
    assert_eq!(build.user, "ci");
    assert_eq!(build.port, 2222);
    assert_eq!(build.route_kind, AliasRouteKind::Direct as i32);
    assert!(build.unsupported.is_none());

    let v6 = &aliases.entries[1];
    assert_eq!(v6.host_name, "::1");
    assert_eq!(v6.user, "fallback");
    assert_eq!(v6.port, 22222);
    assert_eq!(v6.host_key_alias, "v6-trust");
    assert!(v6.unsupported.is_none());

    let from_b = &aliases.entries[3];
    assert_eq!(from_b.host_name, "from-b");
    assert_eq!(from_b.port, 22);
    assert_eq!(from_b.source, "user_include");
}

#[test]
fn reports_one_unsupported_alias_without_failing_the_list() {
    let fixture = Fixture::new().expect("fixture");
    let marker = fixture.0.join("executed");
    fixture
        .write(
            "ssh-config",
            format!(
                "Host good\n  HostName good.internal\nHost blocked\n  HostName blocked.internal\n  LocalCommand touch {}\n",
                marker.display()
            )
            .as_str(),
        )
        .expect("config");

    let aliases = run(&fixture).expect("list");
    assert_eq!(aliases.entries.len(), 2);
    assert!(aliases.entries[0].unsupported.is_none());
    let blocked = &aliases.entries[1];
    let unsupported = blocked.unsupported.as_ref().expect("typed refusal");
    assert_eq!(unsupported.reason, "localcommand");
    assert_eq!(unsupported.source, "user_config");
    assert_eq!(unsupported.line, 5);
    assert!(!unsupported.remedy.is_empty());
    assert!(!marker.exists(), "discovery must not evaluate LocalCommand");
}

#[test]
fn never_evaluates_match_exec_or_opens_a_process() {
    let fixture = Fixture::new().expect("fixture");
    let marker = fixture.0.join("executed");
    fixture
        .write(
            "ssh-config",
            format!(
                "Match exec \"touch {}\"\n  User never\nHost safe\n  HostName safe.internal\n",
                marker.display()
            )
            .as_str(),
        )
        .expect("config");

    let aliases = run(&fixture).expect("list");
    assert_eq!(aliases.entries.len(), 1);
    assert_eq!(
        aliases.entries[0]
            .unsupported
            .as_ref()
            .map(|entry| entry.reason.as_str()),
        Some("match")
    );
    assert!(!marker.exists(), "Match exec must never be evaluated");
}

#[test]
fn truncates_at_the_explicit_alias_bound_and_reports_it() {
    let fixture = Fixture::new().expect("fixture");
    let mut config = String::new();
    for index in 0..=MAX_ALIASES {
        config.push_str(&format!("Host alias-{index}\n"));
    }
    fixture.write("ssh-config", &config).expect("config");

    let aliases = run(&fixture).expect("list");
    assert!(aliases.truncated);
    assert_eq!(aliases.entries.len(), MAX_ALIASES);
    assert_eq!(aliases.max_entries, MAX_ALIASES as u32);
    assert_eq!(aliases.entries[0].alias, "alias-0");
}

#[test]
fn refuses_oversized_and_malformed_configs_with_config_unsupported() {
    let oversized = Fixture::new().expect("oversized fixture");
    let mut config = String::from("Host huge\n");
    while config.len() <= 256 * 1024 {
        config.push_str("# padding padding padding padding padding padding\n");
    }
    oversized.write("ssh-config", &config).expect("config");
    assert_eq!(
        run(&oversized).expect_err("oversized config"),
        crate::v1::ErrorCode::ConfigUnsupported
    );

    let malformed = Fixture::new().expect("malformed fixture");
    malformed
        .write("ssh-config", "Host safe\nBad$Keyword value\n")
        .expect("config");
    assert_eq!(
        run(&malformed).expect_err("malformed config"),
        crate::v1::ErrorCode::ConfigUnsupported
    );
}

#[test]
fn uses_the_owner_config_scope_only_and_returns_no_raw_values() {
    let fixture = Fixture::new().expect("fixture");
    fixture
        .write(
            "ssh-config",
            [
                "Host scoped",
                "  HostName scoped.internal",
                "  IdentityFile /private/secret/id_ed25519",
                "  UserKnownHostsFile /private/secret/known_hosts",
                "",
            ]
            .join("\n")
            .as_str(),
        )
        .expect("config");

    let aliases = run(&fixture).expect("list");
    let entry = &aliases.entries[0];
    assert!(entry.unsupported.is_none());
    let rendered = format!("{entry:?}");
    assert!(!rendered.contains("id_ed25519"));
    assert!(!rendered.contains("/private/secret"));
    assert!(
        read_to_string(fixture.config())
            .expect("read")
            .contains("id_ed25519")
    );
}

#[test]
fn reports_the_restricted_connector_route_fact() {
    let fixture = Fixture::new().expect("fixture");
    fixture
        .write(
            "ssh-config",
            "Host connector\n  HostName 127.0.0.1\n  ProxyCommand nc %h %p\n",
        )
        .expect("config");

    let aliases = run(&fixture).expect("list");
    assert_eq!(
        aliases.entries[0].route_kind,
        AliasRouteKind::RestrictedConnector as i32
    );
    assert_eq!(aliases.entries[0].jump_hops, 0);
    assert!(aliases.entries[0].unsupported.is_none());
}
