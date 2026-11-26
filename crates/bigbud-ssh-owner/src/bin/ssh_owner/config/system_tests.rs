use super::*;

fn resolve_pair(user: &Fixture, system: &Fixture) -> Result<ResolvedConfig, ErrorCode> {
    resolve_with_system(
        &user.0.join("config"),
        &system.0.join("config"),
        "picker",
        "local",
    )
}

fn resolve_pair_ok(user: &Fixture, system: &Fixture) -> io::Result<ResolvedConfig> {
    resolve_pair(user, system).map_err(|code| io::Error::other(format!("{code:?}")))
}

#[test]
fn user_scalars_win_and_system_starts_active_with_user_settings_visible_to_match() -> io::Result<()>
{
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.file("route.conf", b"HostName 127.0.0.2\nUser user-first\n")?;
    user.write_config(&format!(
        "Host picker\nInclude route.conf\n{}Host unrelated\nInclude missing\n",
        user.keys()
    ))?;
    system.file(
        "route.conf",
        b"Port 2202\nMatch host 127.0.0.2 user user-first\nHostKeyAlias System-Key\nHost unrelated\n",
    )?;
    system.file("config", format!(
        "Include route.conf\nPort 2203\nHostName 127.0.0.3\nUser system-fallback\nHostKeyAlias ignored\nUserKnownHostsFile {}\n",
        system.0.join("pins").display(),
    ).as_bytes())?;

    let resolved = resolve_pair_ok(&user, &system)?;
    assert_eq!(resolved.host, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)));
    assert_eq!(resolved.port, 2202);
    assert_eq!(resolved.user, "user-first");
    assert_eq!(resolved.host_key_alias.as_deref(), Some("system-key"));
    assert_eq!(
        resolved.known_hosts,
        Some(fs::canonicalize(&user.0)?.join("pins"))
    );
    assert_eq!(resolved.revalidate(), Ok(()));
    let direct = user
        .resolve()
        .map_err(|code| io::Error::other(format!("{code:?}")))?;
    assert_eq!(direct.port, 22);
    assert_eq!(direct.user, "user-first");
    assert_eq!(direct.host_key_alias, None);
    Ok(())
}

#[test]
fn keeps_user_port_and_fills_missing_username_from_system() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.write_config(&format!(
        "Host picker\nHostName 127.0.0.1\nPort 2201\n{}",
        user.keys()
    ))?;
    system.file("config", b"Host picker\nPort 2299\nUser system-user\n")?;

    let resolved = resolve_pair_ok(&user, &system)?;
    assert_eq!(resolved.port, 2201);
    assert_eq!(resolved.user, "system-user");
    assert_eq!(
        resolved.identity,
        fs::canonicalize(&user.0)?.join("identity")
    );
    assert!(resolved.additional_identities.is_empty());
    assert_eq!(resolved.revalidate(), Ok(()));
    let direct = user
        .resolve()
        .map_err(|code| io::Error::other(format!("{code:?}")))?;
    assert_eq!(direct.port, 2201);
    assert_eq!(direct.user, "local");
    Ok(())
}

#[test]
fn nested_includes_use_the_current_source_root_and_revalidation_binds_both_graphs() -> io::Result<()>
{
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    for fixture in [&user, &system] {
        DirBuilder::new()
            .mode(0o700)
            .create(fixture.0.join("parts"))?;
        fixture.file(
            "parts/entry.conf",
            b"Include leaf.conf newly-matched*.conf\n",
        )?;
        fixture.file("parts/leaf.conf", b"ProxyJump forbidden\n")?;
    }
    user.file("leaf.conf", b"User user-leaf\n")?;
    system.file("leaf.conf", b"Port 2204\n")?;
    user.write_config(&format!("Include parts/entry.conf\n{}", user.keys()))?;
    system.file(
        "config",
        format!(
            "Include {}\nHostName 127.0.0.4\n",
            fs::canonicalize(&system.0)?
                .join("parts/entry.conf")
                .display()
        )
        .as_bytes(),
    )?;

    let resolved = resolve_pair_ok(&user, &system)?;
    assert_eq!(resolved.host, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 4)));
    assert_eq!(resolved.port, 2204);
    assert_eq!(resolved.user, "user-leaf");
    assert_eq!(resolved.revalidate(), Ok(()));
    for fixture in [&user, &system] {
        let resolved = resolve_pair_ok(&user, &system)?;
        fixture.file("newly-matched.conf", b"# no effective change\n")?;
        assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
        fs::remove_file(fixture.0.join("newly-matched.conf"))?;
        assert_eq!(resolved.revalidate(), Ok(()));
        let resolved = resolve_pair_ok(&user, &system)?;
        let leaf = fixture.0.join("leaf.conf");
        let mut text = fs::read_to_string(&leaf)?;
        text.push_str("# still no effective change\n");
        fs::write(leaf, text)?;
        assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    }
    Ok(())
}

#[test]
fn returns_ordered_distinct_identities_and_binds_every_version() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    for name in ["user-extra", "system-first", "system-last"] {
        user.file(name, name.as_bytes())?;
    }
    user.file(
        "keys.conf",
        format!("IdentityFile {}\n", user.0.join("user-extra").display()).as_bytes(),
    )?;
    user.write_config(&format!("{ROUTE}{}Include keys.conf\n", user.keys()))?;
    system.file(
        "keys.conf",
        format!(
            "IdentityFile {}\nIdentityFile {}\n",
            user.0.join("identity").display(),
            user.0.join("system-last").display()
        )
        .as_bytes(),
    )?;
    system.file(
        "config",
        format!(
            "IdentityFile {}\nInclude keys.conf\nIdentityFile {}\n",
            user.0.join("system-first").display(),
            user.0.join("user-extra").display()
        )
        .as_bytes(),
    )?;

    let resolved = resolve_pair_ok(&user, &system)?;
    let root = fs::canonicalize(&user.0)?;
    assert_eq!(resolved.identity, root.join("identity"));
    assert_eq!(
        resolved.additional_identities,
        ["user-extra", "system-first", "system-last"].map(|name| root.join(name))
    );
    assert_eq!(resolved.revalidate(), Ok(()));
    let user_only = user
        .resolve()
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    assert_eq!(user_only.identity, root.join("identity"));
    assert_eq!(user_only.additional_identities, [root.join("user-extra")]);
    assert_eq!(user_only.revalidate(), Ok(()));
    for name in ["identity", "user-extra", "system-first", "system-last"] {
        let resolved = resolve_pair_ok(&user, &system)?;
        fs::write(user.0.join(name), b"changed identity material")?;
        assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    }
    assert_eq!(user_only.revalidate(), Err(UNSUPPORTED));
    Ok(())
}

#[test]
fn rejects_unsafe_system_sources_even_with_complete_user_settings() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.write_config(&format!("{ROUTE}{}", user.keys()))?;
    assert!(matches!(resolve_pair(&user, &system), Err(UNSUPPORTED)));
    system.file("config", b"# safe\n")?;
    let system_config = system.0.join("config");
    let resolved = resolve_pair_ok(&user, &system)?;
    fs::set_permissions(&system_config, Permissions::from_mode(0o644))?;
    assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    assert!(matches!(resolve_pair(&user, &system), Err(UNSUPPORTED)));
    fs::set_permissions(&system_config, Permissions::from_mode(0o600))?;
    for text in [
        "ProxyJump forbidden\n".to_owned(),
        "Match originalhost picker exec forbidden\n".to_owned(),
        "Include ../escape\n".to_owned(),
        format!("Include {}\n", user.0.join("config").display()),
    ] {
        system.write_config(&text)?;
        assert!(
            matches!(resolve_pair(&user, &system), Err(UNSUPPORTED)),
            "{text}"
        );
    }
    fs::remove_file(&system_config)?;
    symlink(user.0.join("config"), &system_config)?;
    assert!(matches!(resolve_pair(&user, &system), Err(UNSUPPORTED)));
    Ok(())
}

#[test]
fn rejects_additional_identities_outside_user_fixture_or_aliasing_trust_or_config() -> io::Result<()>
{
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.file("also-config", b"# config is not an identity\n")?;
    user.write_config(&format!("{ROUTE}{}Include also-config\n", user.keys()))?;
    symlink(system.0.join("identity"), user.0.join("link"))?;
    user.file("public", b"not private\n")?;
    fs::set_permissions(user.0.join("public"), Permissions::from_mode(0o644))?;
    system.file("config", b"# placeholder\n")?;
    for path in [
        system.0.join("identity"),
        user.0.join("link"),
        user.0.join("public"),
        user.0.join("also-config"),
        user.0.join("pins"),
    ] {
        system.write_config(&format!("IdentityFile {}\n", path.display()))?;
        assert!(
            matches!(resolve_pair(&user, &system), Err(UNSUPPORTED)),
            "{path:?}"
        );
    }
    Ok(())
}

#[test]
fn shares_file_and_identity_budgets_across_sources() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    for fixture in [&user, &system] {
        for index in 0..31 {
            fixture.file(&format!("part-{index:02}.conf"), b"# no settings\n")?;
        }
    }
    let user_config = format!("{ROUTE}{}Include part-*.conf\n", user.keys());
    user.write_config(&user_config)?;
    system.file("config", b"Include part-*.conf\n")?;
    assert_eq!(resolve_pair_ok(&user, &system)?.revalidate(), Ok(()));
    system.file("part-31.conf", b"# exceeds shared visit budget\n")?;
    assert!(matches!(resolve_pair(&user, &system), Err(UNSUPPORTED)));
    fs::remove_file(system.0.join("part-31.conf"))?;

    let mut text = "Include part-*.conf\n".to_owned();
    for index in 1..=MAX_IDENTITIES {
        use std::fmt::Write as _;
        let name = format!("key-{index}");
        user.file(&name, b"synthetic key\n")?;
        writeln!(text, "IdentityFile {}", user.0.join(name).display()).map_err(io::Error::other)?;
        system.write_config(&text)?;
        if index < MAX_IDENTITIES {
            assert_eq!(
                resolve_pair_ok(&user, &system)?.additional_identities.len(),
                index
            );
        } else {
            assert!(matches!(resolve_pair(&user, &system), Err(UNSUPPORTED)));
        }
    }
    Ok(())
}
