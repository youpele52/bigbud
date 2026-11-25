#![allow(clippy::panic_in_result_fn)] // Test assertions report failures while I/O errors propagate.

use super::*;
use std::fs::{self, DirBuilder, OpenOptions, Permissions};
use std::io::{self, Write};
use std::net::Ipv4Addr;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt, symlink};
use std::sync::atomic::{AtomicU64, Ordering};

#[path = "default_policy_v2_tests.rs"]
mod default_policy_v2_tests;
#[path = "default_policy_v3_tests.rs"]
mod default_policy_v3_tests;
#[path = "descriptor_tests.rs"]
mod descriptor_tests;
#[path = "diagnostic_tests.rs"]
mod diagnostic_tests;
#[path = "include_tests.rs"]
mod include_tests;
#[path = "jump_resolution_tests.rs"]
mod jump_resolution_tests;
#[path = "paths_tests.rs"]
mod paths_tests;
#[path = "platform_defaults_tests.rs"]
mod platform_defaults_tests;
#[path = "quoted_trust_tests.rs"]
mod quoted_trust_tests;
#[path = "route_defaults_tests.rs"]
mod route_defaults_tests;
#[path = "route_facts_tests.rs"]
mod route_facts_tests;
#[path = "send_env_tests.rs"]
mod send_env_tests;
#[path = "startup_tests.rs"]
mod startup_tests;
#[path = "stock_defaults_tests.rs"]
mod stock_defaults_tests;
#[path = "system_tests.rs"]
mod system_tests;
#[path = "timers_tests.rs"]
mod timers_tests;
#[path = "trust_paths_tests.rs"]
mod trust_paths_tests;

static NEXT: AtomicU64 = AtomicU64::new(0);
const ROUTE: &str = "Host picker\n HostName 127.0.0.1\n Port 2201\n User remote\n";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> io::Result<Self> {
        let root = std::env::temp_dir().join(format!(
            "picker-proof-config-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        DirBuilder::new().mode(0o700).create(&root)?;
        let this = Self(root);
        this.file("identity", b"synthetic key material")?;
        this.file("pins", b"")?;
        Ok(this)
    }

    fn file(&self, name: &str, contents: &[u8]) -> io::Result<()> {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.0.join(name))?
            .write_all(contents)
    }

    fn write_config(&self, text: &str) -> io::Result<()> {
        fs::write(self.0.join("config"), text)
    }

    fn keys(&self) -> String {
        format!(
            "\nMatch all\n IdentityFile \"{}\" # private\n UserKnownHostsFile={}\n",
            self.0.join("identity").display(),
            self.0.join("pins").display()
        )
    }

    fn resolve(&self) -> Result<ResolvedConfig, ErrorCode> {
        resolve(&self.0.join("config"), "picker", "local")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn resolves_the_first_values_and_normalizes_the_exact_host_key_token() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let config = format!(
        "# global first value wins\nPort=2208\n\
         Host p?ck* !picker\n ProxyCommand denied-unrelated\n\
         hOsT p?cker another\n HostName = \"127.0.0.2\"\n User remote\n\
         HostKeyAlias My-Test_Key.1\n HostKeyAlgorithms ssh-ed25519\n\
         IdentityAgent none\n ProxyJump none\n GlobalKnownHostsFile none\n\
         Host *\n Port 22\n HostName 127.0.0.9\n User fallback\n HostKeyAlias ignored\n{}",
        fixture.keys()
    );
    fixture.write_config(&config.replace('\n', "\r\n"))?;
    let resolved = fixture
        .resolve()
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    assert_eq!(resolved.host, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)));
    assert_eq!(resolved.port, 2208);
    assert_eq!(resolved.user, "remote");
    assert_eq!(resolved.host_key_alias.as_deref(), Some("my-test_key.1"));
    let root = fs::canonicalize(&fixture.0)?;
    assert_eq!(resolved.identity, root.join("identity"));
    assert_eq!(resolved.known_hosts, Some(root.join("pins")));
    assert_eq!(resolved.revalidate(), Ok(()));
    Ok(())
}

#[test]
fn match_resets_the_host_stanza_and_never_admits_an_applicable_exec() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let marker = fixture.0.join("ran");
    let allowed = format!(
        "Host unrelated\n IgnoreUnknown *\n\
         Match originalhost other exec \"touch {}\"\n ProxyJump ignored\n\
         Match !originalhost other localuser lo?al user local\n HostName 127.0.0.1\n\
         Match host 127.0.*,localhost originalhost PICK*,!avoid\n User remote\n Port 2201\n{}",
        marker.display(),
        fixture.keys()
    );
    fixture.write_config(&allowed)?;
    let resolved = fixture
        .resolve()
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    assert_eq!(resolved.port, 2201);
    assert_eq!(resolved.user, "remote");
    assert_eq!(resolved.host_key_alias, None);
    for criterion in ["exec", "!exec", "originalhost picker exec"] {
        fixture.write_config(&format!(
            "{ROUTE}Host unrelated\n Match {criterion} \"touch {}\" originalhost other\n{}",
            marker.display(),
            fixture.keys()
        ))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{criterion}");
    }
    assert!(!marker.exists());
    Ok(())
}

#[test]
fn ipv6_loopback_respects_the_first_configured_address_family() -> io::Result<()> {
    let fixture = Fixture::new()?;
    for directive in [
        "",
        "AddressFamily inet6\n",
        "AddressFamily any\nAddressFamily inet\n",
    ] {
        fixture.write_config(&format!(
            "HostName ::1\nPort 2201\nUser remote\n{directive}{}",
            fixture.keys()
        ))?;
        let resolved = fixture
            .resolve()
            .map_err(|error| io::Error::other(format!("{error:?}")))?;
        assert_eq!(resolved.host, IpAddr::V6(std::net::Ipv6Addr::LOCALHOST));
    }
    fixture.write_config(&format!(
        "HostName ::1\nPort 2201\nUser remote\nAddressFamily inet\nAddressFamily inet6\n{}",
        fixture.keys()
    ))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    Ok(())
}

#[test]
fn selects_literal_ipv6_host_and_match_patterns_without_accepting_user_colons() -> io::Result<()> {
    let fixture = Fixture::new()?;
    fixture.write_config(&format!(
        "Host * !::1\nKnownHostsCommand unrelated\nHost ::1\nUser remote\n\
         Match host ::?,!::2 originalhost ::1\nPort 2201\n{}",
        fixture.keys(),
    ))?;
    let resolve_ipv6 = || resolve(&fixture.0.join("config"), "::1", "local");
    let config = resolve_ipv6().map_err(|error| io::Error::other(format!("{error:?}")))?;
    assert_eq!(config.host, IpAddr::V6(std::net::Ipv6Addr::LOCALHOST));
    assert_eq!(config.port, 2201);
    assert_eq!(config.user, "remote");
    fixture.write_config(&format!(
        "Host ::1\nUser remote\nPort 2201\nMatch user remote:invalid\n{}",
        fixture.keys(),
    ))?;
    assert!(matches!(resolve_ipv6(), Err(UNSUPPORTED)));
    Ok(())
}

#[test]
fn identity_agent_retains_explicit_disable_and_exact_user_fixture_path() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let resolved = |policy: &str| {
        fixture.write_config(&format!("{ROUTE}{policy}\n{}", fixture.keys()))?;
        fixture
            .resolve()
            .map_err(|error| io::Error::other(format!("{error:?}")))
    };
    let root = fs::canonicalize(&fixture.0)?;
    assert_eq!(resolved("")?.identity_agent, IdentityAgent::Absent);
    assert_eq!(
        resolved("IdentityAgent none\nIdentityAgent ~/other")?.identity_agent,
        IdentityAgent::Disabled,
    );
    assert_eq!(
        resolved("IdentityAgent ~/socket\nIdentityAgent none")?.identity_agent,
        IdentityAgent::Socket(root.join("home/socket")),
    );
    for value in ["SSH_AUTH_SOCK", "$SSH_AUTH_SOCK", "%d/agent", "~/../agent"] {
        assert!(
            resolved(&format!("IdentityAgent {value}")).is_err(),
            "{value}"
        );
    }
    Ok(())
}

#[test]
fn rejects_unsupported_routes_directives_and_ambiguous_syntax() -> io::Result<()> {
    let fixture = Fixture::new()?;
    for directive in [
        "ProxyJump hop",
        "ProxyCommand nc -w 3 %h %p",
        "ProxyCommand /usr/bin/env nc %h %p",
        "PasswordAuthentication yes",
        "ControlPath /tmp/outside-master",
        "RemoteCommand echo",
        "LocalForward 99 localhost:99",
        "LocalCommand echo",
        "PermitLocalCommand yes",
        "KnownHostsCommand key-probe",
        "Include missing",
        "IgnoreUnknown *",
        "CanonicalizeHostname yes",
        "Match final",
        "Match canonical",
        "Match all user remote",
        "Match unknown remote",
        "Host",
        "Host !",
        "HostKeyAlias [name]:22",
        "HostKeyAlias name,other",
        "HostKeyAlias %h",
        "HostKeyAlias -o",
        "HostKeyAlias \"name\"junk",
        "GlobalKnownHostsFile /tmp/outside-pins",
        "IdentityAgent /tmp/outside-agent",
        "IdentityFile none",
    ] {
        fixture.write_config(&format!("{ROUTE}{directive}\n{}", fixture.keys()))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{directive}");
    }
    for route in [
        "HostName 192.0.2.1\nPort 2201\nUser remote",
        "HostName localhost\nPort 2201\nUser remote",
        "HostName 2001:db8::1\nPort 2201\nUser remote",
        "HostName ::ffff:127.0.0.1\nPort 2201\nUser remote",
        "HostName 127.0.0.1\nPort 0\nUser remote",
        "HostName 127.0.0.1\nPort 65536\nUser remote",
        "HostName 127.0.0.1\nPort invalid\nUser remote",
        "HostName 127.0.0.1\nPort 2201\nUser -invalid",
    ] {
        fixture.write_config(&format!("{route}\n{}", fixture.keys()))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{route}");
    }
    Ok(())
}

#[test]
fn rejects_unsafe_or_ambient_path_sources() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let other = Fixture::new()?;
    let root = &fixture.0;
    fs::create_dir(root.join("directory"))?;
    symlink(root.join("identity"), root.join("link"))?;
    fs::hard_link(other.0.join("identity"), root.join("hard"))?;
    for path in [
        "identity".to_owned(),
        "~/identity".to_owned(),
        root.join("../identity").display().to_string(),
        root.join("directory").display().to_string(),
        root.join("missing").display().to_string(),
        root.join("link").display().to_string(),
        root.join("hard").display().to_string(),
        root.join("pins").display().to_string(),
        other.0.join("identity").display().to_string(),
    ] {
        fixture.write_config(&format!(
            "{ROUTE}IdentityFile {path}\nUserKnownHostsFile {}\n",
            root.join("pins").display()
        ))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{path}");
    }
    fixture.write_config(&format!("{ROUTE}{}", fixture.keys()))?;
    fs::set_permissions(root.join("identity"), Permissions::from_mode(0o644))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    fs::set_permissions(root.join("identity"), Permissions::from_mode(0o600))?;
    let config_link = root.join("config_link");
    symlink(root.join("config"), &config_link)?;
    assert!(matches!(
        resolve(&config_link, "picker", "local"),
        Err(UNSUPPORTED)
    ));
    let root_link = other.0.join("root_link");
    symlink(root, &root_link)?;
    assert!(matches!(
        resolve(&root_link.join("config"), "picker", "local"),
        Err(UNSUPPORTED)
    ));
    fs::remove_file(root.join("pins"))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    fixture.file("pins", b"")?;
    fs::set_permissions(root, Permissions::from_mode(0o755))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    Ok(())
}

#[test]
fn rejects_changed_config_or_identity_and_distinguishes_pin_writes_from_replacement()
-> io::Result<()> {
    let fixture = Fixture::new()?;
    let config = format!("{ROUTE}{}", fixture.keys());
    fixture.write_config(&config)?;
    let before = fixture
        .resolve()
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    fs::write(fixture.0.join("pins"), b"transport manages pins")?;
    assert_eq!(before.revalidate(), Ok(()));
    fixture.write_config(&config.replace("2201", "2202"))?;
    assert_eq!(before.revalidate(), Err(UNSUPPORTED));
    fixture.write_config(&config)?;
    let before = fixture
        .resolve()
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    fixture.file("new_config", config.as_bytes())?;
    fs::rename(fixture.0.join("new_config"), fixture.0.join("config"))?;
    assert_eq!(before.revalidate(), Err(UNSUPPORTED));
    let before = fixture
        .resolve()
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    fs::write(fixture.0.join("identity"), b"different key")?;
    assert_eq!(before.revalidate(), Err(UNSUPPORTED));
    let before = fixture
        .resolve()
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    fixture.file("new_pins", b"transport manages pins")?;
    fs::rename(fixture.0.join("new_pins"), fixture.0.join("pins"))?;
    assert_eq!(before.revalidate(), Err(UNSUPPORTED));
    Ok(())
}

#[test]
fn bounds_source_lines_and_pattern_lists() -> io::Result<()> {
    let fixture = Fixture::new()?;
    for text in [
        ("# shorter line\n").repeat(20_000),
        format!("#{}", "a".repeat(4096)),
        format!("Host {}picker", "a ".repeat(64)),
    ] {
        fixture.write_config(&format!("{text}\n{ROUTE}{}", fixture.keys()))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    }
    Ok(())
}
