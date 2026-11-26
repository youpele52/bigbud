//! U17: a synthetic config with the directive structure of a real macOS user
//! config (top-level Include of a tool's config with a proxied host, literal
//! Host blocks with HostName/User/IdentityFile/LocalForward/Port, and a block
//! with UseKeychain/AddKeysToAgent). No real host, user or key is copied.

use super::*;

fn production(fixture: &Fixture, alias: &str) -> Result<ResolvedConfig, ErrorCode> {
    resolve_with_facts(
        &fixture.0.join("config"),
        None,
        alias,
        &RouteFacts::default().with_production(),
        true,
    )
    .map_err(|failure| failure.code)
}

fn real_shape(fixture: &Fixture, extra: &str) -> io::Result<()> {
    DirBuilder::new()
        .mode(0o700)
        .create(fixture.0.join("tool"))?;
    fixture.file(
        "tool/config",
        b"# managed by a tool\nHost toolvm\n  Hostname 127.0.0.1\n  Port 32222\n  User me\n  \
          IdentitiesOnly yes\n  ProxyCommand '/Applications/Tool.app/helper' proxy %h\n",
    )?;
    fixture.write_config(&format!(
        "Include tool/config\n\n\
         Host web1\n  HostName 10.9.0.1\n  User ops\n  LocalForward 8080 127.0.0.1:80\n\n\
         Host vm\n  HostName 10.9.0.7\n  Port 42977\n  User dev\n{extra}\n\
         Host mac\n  HostName 10.9.0.8\n  User me\n  UseKeychain yes\n  AddKeysToAgent yes\n\
         {}",
        fixture.keys()
    ))
}

#[test]
fn harmless_directives_no_longer_refuse_a_real_shaped_config() -> io::Result<()> {
    let fixture = Fixture::new()?;
    real_shape(
        &fixture,
        "  LocalForward 9000 127.0.0.1:9000\n  ServerAliveInterval 30\n",
    )?;
    for (alias, host, port, user) in [
        ("vm", Ipv4Addr::new(10, 9, 0, 7), 42977, "dev"),
        ("mac", Ipv4Addr::new(10, 9, 0, 8), 22, "me"),
        ("web1", Ipv4Addr::new(10, 9, 0, 1), 22, "ops"),
    ] {
        let resolved =
            production(&fixture, alias).map_err(|e| io::Error::other(format!("{e:?}")))?;
        assert_eq!(resolved.host, IpAddr::V4(host));
        assert_eq!((resolved.port, resolved.user.as_str()), (port, user));
    }
    // The tool's proxied host is still refused: ProxyCommand changes the route.
    assert_eq!(production(&fixture, "toolvm").err(), Some(UNSUPPORTED));
    Ok(())
}

#[test]
fn ignore_unknown_covers_only_keywords_openssh_does_not_know() -> io::Result<()> {
    let ignored = Fixture::new()?;
    real_shape(&ignored, "  IgnoreUnknown Fancy*\n  FancyThing on\n")?;
    assert!(production(&ignored, "vm").is_ok());
    let known = Fixture::new()?;
    real_shape(&known, "  IgnoreUnknown Ciphers\n  Ciphers aes128-ctr\n")?;
    assert_eq!(production(&known, "vm").err(), Some(UNSUPPORTED));
    let unlisted = Fixture::new()?;
    real_shape(&unlisted, "  FancyThing on\n")?;
    assert_eq!(production(&unlisted, "vm").err(), Some(UNSUPPORTED));
    Ok(())
}

#[test]
fn match_exec_is_skipped_only_when_an_earlier_criterion_is_false() -> io::Result<()> {
    let skipped = Fixture::new()?;
    real_shape(
        &skipped,
        "Match host 10.1.1.1 exec \"true\"\n  User other\n",
    )?;
    assert_eq!(
        production(&skipped, "vm")
            .map(|resolved| resolved.user)
            .ok(),
        Some("dev".to_owned())
    );
    let refused = Fixture::new()?;
    real_shape(
        &refused,
        "Match exec \"true\" host 10.9.0.7\n  User other\n",
    )?;
    assert_eq!(production(&refused, "vm").err(), Some(UNSUPPORTED));
    Ok(())
}

#[test]
fn modern_user_auth_algorithms_are_admitted_and_sha1_or_dsa_refused() -> io::Result<()> {
    // U22: a user list drawn from OpenSSH's modern defaults is admitted.
    for value in [
        "ssh-ed25519",
        "rsa-sha2-512,rsa-sha2-256",
        "ecdsa-sha2-nistp256,sk-ssh-ed25519@openssh.com,sk-ecdsa-sha2-nistp256@openssh.com",
    ] {
        let fixture = Fixture::new()?;
        real_shape(&fixture, &format!("  PubkeyAcceptedAlgorithms {value}\n"))?;
        assert!(production(&fixture, "vm").is_ok(), "{value}");
    }
    // SHA-1 RSA, DSA, a modifier or a certificate form stays refused.
    for value in [
        "ssh-rsa",
        "ssh-dss",
        "+ssh-rsa",
        "^ssh-ed25519",
        "ssh-ed25519-cert-v01@openssh.com",
    ] {
        let fixture = Fixture::new()?;
        real_shape(&fixture, &format!("  PubkeyAcceptedAlgorithms {value}\n"))?;
        assert_eq!(
            production(&fixture, "vm").err(),
            Some(UNSUPPORTED),
            "{value}"
        );
    }
    Ok(())
}
