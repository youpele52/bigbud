//! W2 T-alias: production alias admission over real-user-style configs.

use super::*;

fn production(fixture: &Fixture, alias: &str) -> Result<ResolvedConfig, ErrorCode> {
    resolve_with_facts(
        &fixture.0.join("config"),
        None,
        alias,
        &RouteFacts::default().with_production(),
        true,
    )
    .map_err(|_| UNSUPPORTED)
}

fn user_config(fixture: &Fixture, route: &str) -> io::Result<()> {
    DirBuilder::new()
        .mode(0o700)
        .create(fixture.0.join("config.d"))?;
    fixture.file("config.d/10-work.conf", route.as_bytes())?;
    fixture.write_config(&format!(
        "# personal defaults\nInclude config.d/*.conf\n\nHost *\n  IdentitiesOnly yes\n  \
         ServerAliveInterval 30\n{}",
        fixture.keys()
    ))
}

#[test]
fn included_multi_name_alias_defaults_to_port_22_on_a_real_destination() -> io::Result<()> {
    let fixture = Fixture::new()?;
    user_config(
        &fixture,
        "Host work-box work\n  HostName 10.20.0.7\n  User deploy\n",
    )?;
    for alias in ["work-box", "work"] {
        let resolved =
            production(&fixture, alias).map_err(|e| io::Error::other(format!("{e:?}")))?;
        assert_eq!(resolved.host, IpAddr::V4(Ipv4Addr::new(10, 20, 0, 7)));
        assert_eq!(resolved.port, 22);
        assert_eq!(resolved.user, "deploy");
    }
    Ok(())
}

#[test]
fn explicit_port_22_and_an_ipv6_host_name_are_admitted_in_production() -> io::Result<()> {
    let fixture = Fixture::new()?;
    user_config(
        &fixture,
        "Host v6\n  HostName 2001:db8::7\n  Port 22\n  User dev\n",
    )?;
    let resolved = production(&fixture, "v6").map_err(|e| io::Error::other(format!("{e:?}")))?;
    assert_eq!(
        resolved.host,
        "2001:db8::7".parse::<IpAddr>().map_err(io::Error::other)?
    );
    assert_eq!(resolved.port, 22);
    Ok(())
}

#[test]
fn an_applicable_exec_match_in_an_included_file_refuses_the_alias() -> io::Result<()> {
    let fixture = Fixture::new()?;
    user_config(
        &fixture,
        "Host plain build.corp\n  HostName 10.0.0.9\n  User dev\n\
         Match originalhost *.corp exec true\n  User other\n",
    )?;
    // The owner evaluates Match criteria in order: an exec that cannot apply is
    // never run and the alias stays admitted; an applicable exec refuses it.
    // (The server-side resolver is stricter and refuses any non-`all` Match.)
    assert!(production(&fixture, "plain").is_ok());
    assert_eq!(production(&fixture, "build.corp").err(), Some(UNSUPPORTED));
    Ok(())
}
