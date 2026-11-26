use super::*;

#[test]
fn single_quoted_paths_select_and_bind_ordered_trust_sources() -> io::Result<()> {
    let fixture = Fixture::new()?;
    fixture.file("secondary pins", b"")?;
    fixture.file("global", b"")?;
    fixture.file(
        "trust.conf",
        format!(
            "HostKeyAlias 'Fixture-Key'\nIdentityFile '{}'\n\
             UserKnownHostsFile '{}' \"{}\" # ordered\nGlobalKnownHostsFile '{}'\n",
            fixture.0.join("identity").display(),
            fixture.0.join("pins").display(),
            fixture.0.join("secondary pins").display(),
            fixture.0.join("global").display(),
        )
        .as_bytes(),
    )?;
    fixture.write_config(&format!(
        "{ROUTE}Match originalhost 'picker'\nInclude 'trust.conf'\n\
         Match all\nHostKeyAlias fallback\nUserKnownHostsFile none\nGlobalKnownHostsFile none\n"
    ))?;
    let resolved = fixture
        .resolve()
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    let root = fs::canonicalize(&fixture.0)?;
    assert_eq!(resolved.host_key_alias.as_deref(), Some("fixture-key"));
    assert_eq!(resolved.known_hosts, Some(root.join("pins")));
    assert_eq!(
        resolved.additional_user_known_hosts,
        [root.join("secondary pins")]
    );
    assert_eq!(resolved.global_known_hosts, [root.join("global")]);
    assert_eq!(resolved.revalidate(), Ok(()));
    fs::rename(root.join("secondary pins"), root.join("old-secondary pins"))?;
    fixture.file("secondary pins", b"")?;
    assert_eq!(resolved.revalidate(), Err(UNSUPPORTED));
    Ok(())
}

#[test]
fn quoted_trust_operands_do_not_bypass_syntax_or_path_checks() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let outside = Fixture::new()?;
    symlink(fixture.0.join("pins"), fixture.0.join("pin link"))?;
    let spaced_parent = fixture.0.join("home/trust folder");
    DirBuilder::new()
        .mode(0o700)
        .create(fixture.0.join("home"))?;
    DirBuilder::new().mode(0o700).create(&spaced_parent)?;
    fixture.file("home/trust folder/pins", b"")?;
    let pin = fixture.0.join("pins");
    for operand in [
        format!("'{}", pin.display()),
        format!("'{}'suffix", pin.display()),
        "''".to_owned(),
        format!("'none' '{}'", pin.display()),
        format!("'{}' 'none'", pin.display()),
        format!("'{}'", outside.0.join("pins").display()),
        format!("'{}'", fixture.0.join("pin link").display()),
        format!("'{}'", spaced_parent.join("pins").display()),
        format!("'{}/../pins'", fixture.0.display()),
        "'${HOME}/pins'".to_owned(),
    ] {
        fixture.write_config(&format!(
            "{ROUTE}UserKnownHostsFile {operand}\n{}",
            fixture.keys(),
        ))?;
        let result =
            resolve_with_diagnostic(&fixture.0.join("config"), None, "picker", Some("local"));
        assert!(
            matches!(result, Err(failure) if failure.code == UNSUPPORTED
            && failure.diagnostic.is_some_and(|entry| entry.directive == Directive::UserKnownHostsFile)),
            "{operand}"
        );
    }
    Ok(())
}
