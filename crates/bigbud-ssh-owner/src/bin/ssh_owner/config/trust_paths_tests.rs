use super::*;

#[test]
fn retains_first_user_and_global_lists_in_order_and_binds_all_sources() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    for name in ["picker.pins", "global-user"] {
        user.file(name, b"")?;
    }
    system.file("global-system", b"")?;
    fs::set_permissions(
        system.0.join("global-system"),
        Permissions::from_mode(0o400),
    )?;
    user.write_config(&format!(
        "{ROUTE}UserKnownHostsFile {} {}\n{}",
        user.0.join("pins").display(),
        user.0.join("%n.pins").display(),
        user.keys(),
    ))?;
    system.file(
        "config",
        format!(
            "GlobalKnownHostsFile {} {}\nGlobalKnownHostsFile none\nUserKnownHostsFile none\n",
            system.0.join("global-system").display(),
            user.0.join("global-user").display(),
        )
        .as_bytes(),
    )?;
    let resolve_fixture = || {
        resolve_with_system(
            &user.0.join("config"),
            &system.0.join("config"),
            "picker",
            "local",
        )
        .map_err(|error| io::Error::other(format!("{error:?}")))
    };
    let config = resolve_fixture()?;
    let user_root = fs::canonicalize(&user.0)?;
    let system_root = fs::canonicalize(&system.0)?;
    assert_eq!(config.known_hosts, Some(user_root.join("pins")));
    assert_eq!(
        config.additional_user_known_hosts,
        [user_root.join("picker.pins")]
    );
    assert_eq!(
        config.global_known_hosts,
        [
            system_root.join("global-system"),
            user_root.join("global-user")
        ]
    );
    fs::write(
        user.0.join("pins"),
        b"transport can update the first user file",
    )?;
    assert_eq!(config.revalidate(), Ok(()));
    user.file("replacement", b"")?;
    fs::rename(user.0.join("replacement"), user.0.join("picker.pins"))?;
    assert_eq!(config.revalidate(), Err(UNSUPPORTED));
    let config = resolve_fixture()?;
    system.file("replacement", b"")?;
    fs::rename(system.0.join("replacement"), system.0.join("global-system"))?;
    assert_eq!(config.revalidate(), Err(UNSUPPORTED));
    Ok(())
}

#[test]
fn rejects_unsafe_or_conflated_trust_sources_without_reading_records() -> io::Result<()> {
    let fixture = Fixture::new()?;
    fixture.file("secondary", b"")?;
    symlink(fixture.0.join("secondary"), fixture.0.join("link"))?;
    let pin = fixture.0.join("pins");
    for policy in [
        "UserKnownHostsFile none".to_owned(),
        format!("UserKnownHostsFile none {}", pin.display()),
        format!("UserKnownHostsFile {} none", pin.display()),
        format!("GlobalKnownHostsFile {}", pin.display()),
        format!("GlobalKnownHostsFile {}", fixture.0.join("%h").display()),
        format!(
            "GlobalKnownHostsFile {}",
            fixture.0.join("config").display()
        ),
        format!(
            "GlobalKnownHostsFile {}",
            fixture.0.join("identity").display()
        ),
        format!(
            "GlobalKnownHostsFile {}",
            fixture.0.join("missing").display()
        ),
        format!("GlobalKnownHostsFile {}", fixture.0.join("link").display()),
        format!(
            "UserKnownHostsFile {} {}",
            pin.display(),
            fixture.0.join("link").display()
        ),
    ] {
        fixture.write_config(&format!("{ROUTE}{policy}\n{}", fixture.keys()))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{policy}");
    }
    Ok(())
}

#[test]
fn explicit_user_none_requires_and_binds_a_global_authority() -> io::Result<()> {
    let fixture = Fixture::new()?;
    fixture.file("global-pins", b"")?;
    let global = fixture.0.join("global-pins");
    let policy = |user, global| {
        format!(
            "{ROUTE}IdentityFile {}\n{user}\n{global}\n",
            fixture.0.join("identity").display()
        )
    };
    fixture.write_config(&policy(
        "UserKnownHostsFile none",
        "GlobalKnownHostsFile none",
    ))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    let global_directive = format!("GlobalKnownHostsFile {}", global.display());
    fixture.write_config(&policy("", global_directive.as_str()))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    fixture.write_config(&policy(
        "UserKnownHostsFile none",
        global_directive.as_str(),
    ))?;
    let resolved = fixture
        .resolve()
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    assert_eq!(resolved.known_hosts, None);
    assert!(resolved.additional_user_known_hosts.is_empty());
    assert_eq!(resolved.global_known_hosts, [fs::canonicalize(&global)?]);
    fs::rename(&global, fixture.0.join("old-global"))?;
    fixture.file("global-pins", b"")?;
    assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    Ok(())
}

#[test]
fn certificate_policy_requires_explicit_alias_and_read_only_global_trust() -> io::Result<()> {
    let fixture = Fixture::new()?;
    fixture.file("ca-pins", b"")?;
    let base = format!(
        "{ROUTE}IdentityFile {}\nGlobalKnownHostsFile {}\n",
        fixture.0.join("identity").display(),
        fixture.0.join("ca-pins").display(),
    );
    let cert = "HostKeyAlgorithms ssh-ed25519-cert-v01@openssh.com\n";
    let write = |tail: &str| fixture.write_config(&format!("{base}{tail}"));
    for policy in [
        format!("{cert}UserKnownHostsFile none\n"),
        format!("{cert}HostKeyAlias ca-test\nUserKnownHostsFile {}\n", fixture.0.join("pins").display()),
        "HostKeyAlgorithms +ssh-ed25519-cert-v01@openssh.com\nHostKeyAlias ca-test\nUserKnownHostsFile none\n".to_owned(),
        format!("{cert}HostKeyAlias ca-test\nUserKnownHostsFile none\nGSSAPIKeyExchange yes\n"),
    ] {
        write(&policy)?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    }
    let enabled = format!("{cert}HostKeyAlias ca-test\nUserKnownHostsFile none\n");
    let resolve = || {
        fixture
            .resolve()
            .map_err(|error| io::Error::other(format!("{error:?}")))
    };
    write(&enabled)?;
    assert_eq!(
        resolve()?.host_verification,
        HostVerification::Ed25519Certificate
    );
    write(&format!("HostKeyAlgorithms ssh-ed25519\n{enabled}"))?;
    assert_eq!(resolve()?.host_verification, HostVerification::Ed25519Key);
    Ok(())
}

#[test]
fn an_explicit_empty_global_list_wins_and_unrelated_policy_is_ignored() -> io::Result<()> {
    let fixture = Fixture::new()?;
    fixture.write_config(&format!(
        "{ROUTE}GlobalKnownHostsFile none\nGlobalKnownHostsFile {}\n\
         Host unrelated\nGlobalKnownHostsFile !bad\n{}",
        fixture.0.join("missing-fallback").display(),
        fixture.keys(),
    ))?;
    let config = fixture
        .resolve()
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    assert!(config.global_known_hosts.is_empty());
    assert!(config.additional_user_known_hosts.is_empty());
    Ok(())
}
