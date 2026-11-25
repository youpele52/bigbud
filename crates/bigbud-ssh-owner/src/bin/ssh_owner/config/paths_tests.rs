use super::*;

fn private_dir(fixture: &Fixture, name: &str) -> io::Result<()> {
    DirBuilder::new().mode(0o700).create(fixture.0.join(name))
}

fn resolve_pair(user: &Fixture, system: &Fixture) -> Result<ResolvedConfig, ErrorCode> {
    resolve_with_system(
        &user.0.join("config"),
        &system.0.join("config"),
        "picker",
        "local",
    )
}

#[test]
fn includes_use_the_current_route_and_auth_paths_use_the_final_route() -> io::Result<()> {
    let fixture = Fixture::new()?;
    private_dir(&fixture, "home")?;
    private_dir(&fixture, "home/.ssh")?;
    fixture.file(
        "home/.ssh/picker-picker-22-local.conf",
        b"HostName 127.0.0.2\nPort 2222\nUser remote-new\nInclude nested-%r.conf\n",
    )?;
    fixture.file(
        "nested-remote-new.conf",
        b"HostKeyAlias nested\nHost other\n",
    )?;
    fixture.file(
        "home/.ssh/second-127.0.0.2-picker-2222-remote-new-%.conf",
        b"HostKeyAlias later\n",
    )?;
    fixture.file("home/.ssh/id-127.0.0.2-picker-2222-remote-new", b"test key")?;
    fixture.file("home/pins-127.0.0.2-picker-2222-remote-new", b"")?;
    fixture.write_config("Host picker\nIdentityFile ~/.ssh/id-%h-%n-%p-%r\nUserKnownHostsFile ~/pins-%h-%n-%p-%r\nInclude ~/.ssh/%h-%n-%p-%r.conf ~/.ssh/second-%h-%n-%p-%r-%%*.conf\nUser later\nPort 2201\n")?;

    let resolved = fixture
        .resolve()
        .map_err(|code| io::Error::other(format!("{code:?}")))?;
    let root = fs::canonicalize(&fixture.0)?;
    assert_eq!(
        resolved.identity,
        root.join("home/.ssh/id-127.0.0.2-picker-2222-remote-new")
    );
    assert_eq!(
        resolved.known_hosts,
        Some(root.join("home/pins-127.0.0.2-picker-2222-remote-new"))
    );
    assert_eq!(resolved.port, 2222);
    assert_eq!(resolved.user, "remote-new");
    assert_eq!(resolved.host_key_alias.as_deref(), Some("nested"));
    assert_eq!(resolved.revalidate(), Ok(()));
    fixture.file(
        "home/.ssh/second-127.0.0.2-picker-2222-remote-new-%2.conf",
        b"# new matching file\n",
    )?;
    assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    Ok(())
}

#[test]
fn hostname_expands_the_original_alias_before_match_and_include() -> io::Result<()> {
    let fixture = Fixture::new()?;
    private_dir(&fixture, "home")?;
    fixture.file("route-127.0.0.42.conf", b"Port 2242\nUser remote\n")?;
    fixture.file("home/id-127.0.0.42-42", b"test key")?;
    fixture.write_config(&format!(
        "Host 4? !43\nHostName 127.0.0.%h\n\
         Match host 127.0.0.42 originalhost 42\nInclude route-%h.conf\n\
         Host 42\nHostName 127.0.1.%h\n\
         IdentityFile ~/id-%h-%n\nUserKnownHostsFile {}\n",
        fixture.0.join("pins").display()
    ))?;
    let resolved = resolve(&fixture.0.join("config"), "42", "local")
        .map_err(|code| io::Error::other(format!("{code:?}")))?;
    assert_eq!(resolved.host, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 42)));
    assert_eq!(resolved.port, 2242);
    assert_eq!(resolved.user, "remote");
    assert_eq!(
        resolved.identity,
        fs::canonicalize(&fixture.0)?.join("home/id-127.0.0.42-42")
    );
    assert_eq!(resolved.revalidate(), Ok(()));
    Ok(())
}

#[test]
fn hostname_expansion_remains_bounded_and_fails_closed() -> io::Result<()> {
    let fixture = Fixture::new()?;
    for operand in [
        "%n",
        "%p",
        "%r",
        "%",
        "%é",
        "127.0.0.%%h",
        "${HOST}",
        "../%h",
    ] {
        // Unsupported active values are rejected even behind a valid first value.
        fixture.write_config(&format!("{ROUTE}HostName {operand}\n{}", fixture.keys()))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{operand}");
    }
    fixture.write_config(&format!(
        "{ROUTE}HostName {}\n{}",
        "%h".repeat(44),
        fixture.keys()
    ))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));

    for (alias, operand) in [("42", "192.0.2.%h"), ("picker", "%h")] {
        fixture.write_config(&format!(
            "HostName {operand}\nPort 2201\nUser remote\n{}",
            fixture.keys()
        ))?;
        assert!(matches!(
            resolve(&fixture.0.join("config"), alias, "local"),
            Err(UNSUPPORTED)
        ));
    }
    Ok(())
}

#[test]
fn system_includes_are_system_local_but_system_auth_templates_use_the_user_home() -> io::Result<()>
{
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    for fixture in [&user, &system] {
        private_dir(fixture, "home")?;
    }
    user.file("route-127.0.0.1-picker.conf", b"ProxyCommand forbidden\n")?;
    user.file("home/user-system-key", b"first key")?;
    user.file("home/system-2202", b"next key")?;
    user.file("home/trust-system-key", b"")?;
    user.write_config(
        "Host picker\nHostName 127.0.0.1\nIdentityFile ~/user-%r\nUserKnownHostsFile ~/trust-%r\n",
    )?;
    system.file(
        "home/tilde.conf",
        b"# harmless but not a permitted system Include\n",
    )?;
    system.file(
        "route-127.0.0.1-picker.conf",
        b"Port 2202\nUser system-key\nIdentityFile ~/system-%p\nUserKnownHostsFile ~/ignored-%n\n",
    )?;
    let system_config = b"Include route-%h-%n.conf\nIdentityFile ~/user-%r\nPort 2299\n";
    system.file("config", system_config)?;

    let resolved =
        resolve_pair(&user, &system).map_err(|code| io::Error::other(format!("{code:?}")))?;
    let home = fs::canonicalize(&user.0)?.join("home");
    assert_eq!(resolved.identity, home.join("user-system-key"));
    assert_eq!(resolved.additional_identities, [home.join("system-2202")]);
    assert_eq!(resolved.known_hosts, Some(home.join("trust-system-key")));
    assert_eq!(resolved.revalidate(), Ok(()));
    fs::write(home.join("system-2202"), b"changed key")?;
    assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    fs::write(
        system.0.join("config"),
        [system_config.as_slice(), b"Include ~/tilde.conf\n"].concat(),
    )?;
    assert!(matches!(resolve_pair(&user, &system), Err(UNSUPPORTED)));
    Ok(())
}

#[test]
fn rejects_unsupported_or_unsafe_expansions_without_falling_back() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let outside = Fixture::new()?;
    private_dir(&fixture, "home")?;
    private_dir(&fixture, "home/public")?;
    private_dir(&fixture, "not-home")?;
    fixture.file("home/public/key", b"private file in a public directory")?;
    fixture.file("not-home/key", b"private file outside the new namespace")?;
    fs::set_permissions(fixture.0.join("home/public"), Permissions::from_mode(0o755))?;
    symlink(&outside.0, fixture.0.join("home/link"))?;
    outside.file("seed.conf", b"# outside the fixture\n")?;
    fixture.file("home/identity", b"test key")?;
    fixture.file("home/identity%h", b"must not reach the transport")?;
    fixture.file("home/pins%h", b"")?;
    for operand in [
        "~other/identity",
        "~",
        "~/../identity",
        "~//identity",
        "~/link/identity",
        "~/public/key",
        "~/id-%d",
        "~/id-%C",
        "~/id-%",
        "~/id-%🗝",
        "~/id-${HOME}",
        "~/id-*",
        "~/identity%%h",
    ] {
        fixture.write_config(&format!(
            "{ROUTE}IdentityFile {operand}\nUserKnownHostsFile {}\n",
            fixture.0.join("pins").display()
        ))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{operand}");
    }
    for line in [
        "UserKnownHostsFile ~/pins%%h",
        "UserKnownHostsFile ~/pins-${HOME}",
        "UserKnownHostsFile ~/pins-%k",
        "Include ~/link/*.conf",
        "Include ~/../seed.conf",
        "Include ~other/ghost*.conf",
        "Include ~/ghost-%C*.conf",
        "Include ~/ghost-${HOME}*.conf",
    ] {
        fixture.write_config(&format!("{ROUTE}{}{line}\n", fixture.keys()))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{line}");
    }
    fixture.write_config(&format!(
        "HostName 127.0.0.1\nPort 2201\nUser ..\nInclude ~/%r/ignored*.conf\n{}",
        fixture.keys()
    ))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    let nested_outside_home = fixture.0.join("not-home/key");
    for operand in [
        "~/%r/identity".to_owned(),
        nested_outside_home.display().to_string(),
    ] {
        fixture.write_config(&format!(
            "HostName 127.0.0.1\nPort 2201\nUser .\nIdentityFile {operand}\nUserKnownHostsFile {}\n",
            fixture.0.join("pins").display(),
        ))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{operand}");
    }
    Ok(())
}

#[test]
fn revalidates_tilde_keys_and_trust_in_private_directories() -> io::Result<()> {
    let fixture = Fixture::new()?;
    private_dir(&fixture, "home")?;
    fixture.file("home/id-picker", b"old key")?;
    fixture.file("home/pins-2201", b"")?;
    fixture.write_config(&format!(
        "{ROUTE}IdentityFile ~/id-%n\nUserKnownHostsFile ~/pins-%p\n"
    ))?;
    let resolved = fixture
        .resolve()
        .map_err(|code| io::Error::other(format!("{code:?}")))?;
    fs::write(fixture.0.join("home/pins-2201"), b"in-place trust update")?;
    assert_eq!(resolved.revalidate(), Ok(()));
    fs::set_permissions(fixture.0.join("home"), Permissions::from_mode(0o755))?;
    assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    fs::set_permissions(fixture.0.join("home"), Permissions::from_mode(0o700))?;
    fixture.file("home/replacement", b"in-place trust update")?;
    fs::rename(
        fixture.0.join("home/replacement"),
        fixture.0.join("home/pins-2201"),
    )?;
    assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    Ok(())
}

#[test]
fn bounds_expanded_include_paths_even_if_the_glob_would_be_empty() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let name = "a".repeat(255);
    for operand in [
        format!("~/{}/*.conf", ["%n"; 17].join("/")),
        "~/%n-tail/*.conf".to_owned(),
        format!("~/{}/ghost*.conf", ["a"; 32].join("/")),
    ] {
        fixture.write_config(&format!(
            "HostName 127.0.0.1\nPort 2201\nUser remote\n{}Include {operand}\n",
            fixture.keys()
        ))?;
        assert!(
            matches!(
                resolve(&fixture.0.join("config"), &name, "local"),
                Err(UNSUPPORTED)
            ),
            "{operand}"
        );
    }
    Ok(())
}
