use super::*;

fn directory(fixture: &Fixture, name: &str) -> io::Result<()> {
    DirBuilder::new().mode(0o700).create(fixture.0.join(name))
}

fn resolve_ok(fixture: &Fixture) -> io::Result<ResolvedConfig> {
    fixture
        .resolve()
        .map_err(|code| io::Error::other(format!("{code:?}")))
}

#[test]
fn includes_in_bytewise_path_and_operand_order_with_fixture_root_for_nested_files() -> io::Result<()>
{
    let fixture = Fixture::new()?;
    for path in ["parts", "parts/a", "parts/a-"] {
        directory(&fixture, path)?;
    }
    // Create in reverse order. Lexical order of complete paths puts 'a-/' before 'a/'.
    fixture.file("parts/a/1.conf", b"User fallback\nPort 2299\n")?;
    fixture.file(
        "parts/a-/2.conf",
        b"User first\nInclude route.conf\nHost other\n",
    )?;
    fixture.file("parts/a-/.hidden.conf", b"ProxyJump forbidden\n")?;
    fixture.file(
        "route.conf",
        b"Match user first originalhost picker\nHostName 127.0.0.2\nPort 2202\n",
    )?;
    fixture.file(
        "absolute.conf",
        b"Port 2210\nUser third\nHostKeyAlias Included-Key\n",
    )?;
    fixture.write_config(&format!(
        "Host p?cker !other\n Include parts/a*/[1-2].con? parts/a-/[!9].conf parts/a-/*.conf parts/a-/*.not-found \"{}\"\n Port 2220\n{}",
        fs::canonicalize(&fixture.0)?.join("absolute*.conf").display(),
        fixture.keys()
    ))?;
    let resolved = resolve_ok(&fixture)?;
    assert_eq!(resolved.host, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)));
    assert_eq!(resolved.port, 2202);
    assert_eq!(resolved.user, "first");
    assert_eq!(resolved.host_key_alias.as_deref(), Some("included-key"));
    assert_eq!(resolved.revalidate(), Ok(()));
    Ok(())
}

#[test]
fn include_globs_skip_regular_intermediate_files_but_not_unsafe_entries() -> io::Result<()> {
    let fixture = Fixture::new()?;
    directory(&fixture, "parts")?;
    fixture.file("parts/00-not-a-directory", b"ProxyJump forbidden\n")?;
    directory(&fixture, "parts/20-route")?;
    fixture.file("parts/20-route/route.conf", b"Port 2202\n")?;
    fixture.write_config(&format!(
        "Include parts/*/route.conf parts/00-not-a-directory/*.conf\n{ROUTE}{}",
        fixture.keys(),
    ))?;
    let resolved = resolve_ok(&fixture)?;
    assert_eq!(resolved.port, 2202);
    fs::write(fixture.0.join("parts/00-not-a-directory"), "not config")?;
    assert_eq!(resolved.revalidate(), Ok(()));

    fs::remove_file(fixture.0.join("parts/00-not-a-directory"))?;
    directory(&fixture, "parts/00-not-a-directory")?;
    fixture.file("parts/00-not-a-directory/route.conf", b"Port 2203\n")?;
    assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    assert_eq!(resolve_ok(&fixture)?.port, 2203);

    symlink("20-route", fixture.0.join("parts/10-symlink"))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    fs::remove_file(fixture.0.join("parts/10-symlink"))?;
    fixture.file("parts/literal-file", b"not a directory")?;
    fixture.write_config(&format!(
        "Include parts/literal-file/route.conf\n{ROUTE}{}",
        fixture.keys(),
    ))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    Ok(())
}

#[test]
fn restores_parent_scope_and_never_evaluates_demonstrably_inactive_includes() -> io::Result<()> {
    let fixture = Fixture::new()?;
    fixture.file(
        "active.conf",
        b"Match originalhost other\nInclude never-read\n",
    )?;
    fixture.file("inactive.conf", b"Match all\nProxyJump forbidden\n")?;
    symlink("outside-not-read", fixture.0.join("ignored-link"))?;
    fixture.write_config(&format!(
        "Host other\n Include /outside/blocked ../blocked ignored-link inactive.conf\n\
         Match originalhost other\n Include \"unterminated\n\
         Match originalhost picker localuser local\n Include active.conf\n\
         HostName 127.0.0.1\n Port 2201\n User remote\n{}",
        fixture.keys()
    ))?;
    let resolved = resolve_ok(&fixture)?;
    assert_eq!(resolved.port, 2201);
    fs::remove_file(fixture.0.join("inactive.conf"))?;
    assert_eq!(resolved.revalidate(), Ok(()));
    Ok(())
}

#[test]
fn rejects_unsafe_operands_and_sources_even_if_settings_are_already_complete() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let other = Fixture::new()?;
    other.file("external.conf", b"# outside\n")?;
    directory(&fixture, "dir")?;
    directory(&fixture, "public")?;
    fixture.file("public/private.conf", b"# private leaf\n")?;
    fs::set_permissions(fixture.0.join("public"), Permissions::from_mode(0o755))?;
    fixture.file("public.conf", b"# readable by others\n")?;
    fs::set_permissions(fixture.0.join("public.conf"), Permissions::from_mode(0o644))?;
    fixture.file("unreadable.conf", b"# private, but not readable\n")?;
    fs::set_permissions(
        fixture.0.join("unreadable.conf"),
        Permissions::from_mode(0o000),
    )?;
    fixture.file("invalid.conf", b"\xff")?;
    fixture.file("unsupported.conf", b"ProxyJump forbidden\n")?;
    fixture.file("odd name.conf", b"# unsafe matching name\n")?;
    symlink(other.0.join("external.conf"), fixture.0.join("link.conf"))?;
    symlink("nonexistent.conf", fixture.0.join("dangling.conf"))?;
    symlink(&other.0, fixture.0.join("leak"))?;
    fs::hard_link(other.0.join("external.conf"), fixture.0.join("hard.conf"))?;
    for operand in [
        "".into(),
        "missing.conf".into(),
        other.0.join("external.conf").display().to_string(),
        format!("{}/../*/external.conf", fixture.0.display()),
        "../*/external.conf".into(),
        "~other/none*.conf".into(),
        "$HOME/none*.conf".into(),
        "%d/none*.conf".into(),
        "dir//none*.conf".into(),
        "dir/./none*.conf".into(),
        "none[*.conf".into(),
        "none[z-a].conf".into(),
        "{dir,public}/*.conf".into(),
        "dir".into(),
        "l?nk.conf".into(),
        "dangling*.conf".into(),
        "leak/*.conf".into(),
        "public/*.conf".into(),
        "public.conf".into(),
        "hard.conf".into(),
        "unreadable.conf".into(),
        "invalid.conf".into(),
        "unsupported.conf".into(),
        "odd*.conf".into(),
    ] {
        fixture.write_config(&format!("{ROUTE}{}Include {operand}\n", fixture.keys()))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{operand}");
    }
    // Includes cannot double as the identity or mutable trust source.
    fs::write(fixture.0.join("identity"), b"# also valid config\n")?;
    for alias in ["identity", "pins"] {
        fixture.write_config(&format!("{ROUTE}{}Include {alias}\n", fixture.keys()))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{alias}");
    }
    Ok(())
}

#[test]
fn rejects_cycles_but_allows_repeated_non_recursive_includes() -> io::Result<()> {
    let fixture = Fixture::new()?;
    fixture.file("leaf.conf", b"# ok\n")?;
    fixture.file("first.conf", b"Include second.conf\n")?;
    fixture.file("second.conf", b"Include first.conf\n")?;
    fixture.write_config(&format!(
        "{ROUTE}{}Include leaf.conf leaf.conf\n",
        fixture.keys()
    ))?;
    assert_eq!(resolve_ok(&fixture)?.revalidate(), Ok(()));
    for operand in [
        "first.conf".to_owned(),
        fixture.0.join("config").display().to_string(),
    ] {
        fixture.write_config(&format!("{ROUTE}{}Include {operand}\n", fixture.keys()))?;
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{operand}");
    }
    Ok(())
}

#[test]
fn enforces_depth_file_and_per_file_size_limits() -> io::Result<()> {
    let fixture = Fixture::new()?;
    for index in 1..=17 {
        let data = if index < 16 {
            format!("Include level-{}\n", index + 1)
        } else {
            "# end\n".to_owned()
        };
        fixture.file(&format!("level-{index}"), data.as_bytes())?;
    }
    let prefix = format!("{ROUTE}{}", fixture.keys());
    fixture.write_config(&format!("{prefix}Include level-1\n"))?;
    assert_eq!(resolve_ok(&fixture)?.revalidate(), Ok(()));
    fs::write(fixture.0.join("level-16"), "Include level-17\n")?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));

    for index in 1..=63 {
        fixture.file(&format!("part-{index:02}.conf"), b"# ok\n")?;
    }
    fixture.write_config(&format!("{prefix}Include part-*.conf\n"))?;
    assert_eq!(resolve_ok(&fixture)?.revalidate(), Ok(()));
    fixture.file("part-64.conf", b"# one too many\n")?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));

    let exact = format!("#{}\n", "x".repeat(1022)).repeat(256);
    fixture.file("large.conf", exact.as_bytes())?;
    fixture.write_config(&format!("{prefix}Include large.conf\n"))?;
    assert_eq!(resolve_ok(&fixture)?.revalidate(), Ok(()));
    fs::write(fixture.0.join("large.conf"), format!("{exact}\n"))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));

    fixture.write_config(&format!("{prefix}{}", "Include z*\n".repeat(2000)))?;
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    Ok(())
}

#[test]
fn revalidation_binds_exact_matched_paths_and_versions_including_empty_globs() -> io::Result<()> {
    let fixture = Fixture::new()?;
    directory(&fixture, "parts")?;
    fixture.file("parts/90.conf", b"# no effective settings\n")?;
    fixture.write_config(&format!(
        "{ROUTE}{}Include parts/*.conf empty/*.conf\n",
        fixture.keys()
    ))?;
    let frozen = resolve_ok(&fixture)?;
    fixture.file("parts/unrelated.txt", b"# ignored\n")?;
    assert_eq!(frozen.revalidate(), Ok(()));
    directory(&fixture, "empty")?;
    assert_eq!(frozen.revalidate(), Ok(()));
    fixture.file("empty/50.conf", b"# formerly empty glob\n")?;
    assert_eq!(frozen.revalidate(), Err(UNSUPPORTED));
    fs::remove_file(fixture.0.join("empty/50.conf"))?;
    assert_eq!(frozen.revalidate(), Ok(()));
    fixture.file("parts/10.conf", b"# first now, same effective settings\n")?;
    assert_eq!(frozen.revalidate(), Err(UNSUPPORTED));
    fs::remove_file(fixture.0.join("parts/10.conf"))?;
    fs::write(fixture.0.join("parts/90.conf"), b"# new content\n")?;
    assert_eq!(frozen.revalidate(), Err(UNSUPPORTED));
    let frozen = resolve_ok(&fixture)?;
    fixture.file("replacement", b"# new content\n")?;
    fs::rename(
        fixture.0.join("replacement"),
        fixture.0.join("parts/90.conf"),
    )?;
    assert_eq!(frozen.revalidate(), Err(UNSUPPORTED));
    let frozen = resolve_ok(&fixture)?;
    fs::remove_file(fixture.0.join("parts/90.conf"))?;
    assert_eq!(frozen.revalidate(), Err(UNSUPPORTED));
    Ok(())
}
