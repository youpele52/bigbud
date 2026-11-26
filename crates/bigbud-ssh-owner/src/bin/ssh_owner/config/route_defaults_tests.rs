use super::*;
use crate::transport::{Transport, TransportConfig};

fn resolved(result: Result<ResolvedConfig, ConfigFailure>) -> io::Result<ResolvedConfig> {
    result.map_err(|failure| io::Error::other(format!("{failure:?}")))
}

#[test]
fn route_defaults_port_and_login_use_only_known_profile_facts() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let path = fixture.0.join("config");
    let resolve = |initiator| resolve_with_diagnostic(&path, None, "picker", initiator);
    fixture.write_config(&format!("HostName 127.0.0.1\n{}", fixture.keys()))?;
    let route = resolved(resolve(Some("profile-user")))?;
    assert_eq!((route.port, route.user.as_str()), (22, "profile-user"));
    assert_eq!(route.revalidate(), Ok(()));
    assert!(matches!(resolve(None), Err(failure) if failure.code == UNSUPPORTED));

    fixture.write_config(&format!(
        "HostName 127.0.0.1\nUser remote\n{}",
        fixture.keys()
    ))?;
    let route = resolved(resolve(None))?;
    assert_eq!((route.port, route.user.as_str()), (22, "remote"));
    fixture.write_config(&format!(
        "{ROUTE}Port 22\nUser shadowed\n{}",
        fixture.keys()
    ))?;
    let route = resolved(resolve(Some("profile-user")))?;
    assert_eq!((route.port, route.user.as_str()), (2201, "remote"));
    fixture.write_config(&format!("{ROUTE}Port 0\n{}", fixture.keys()))?;
    assert!(matches!(resolve(None), Err(failure) if failure.code == UNSUPPORTED));
    Ok(())
}

#[test]
fn route_defaults_match_localuser_never_infers_the_remote_login() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let path = fixture.0.join("config");
    let resolve = |initiator| resolve_with_diagnostic(&path, None, "picker", initiator);
    fixture.write_config(&format!(
        "{ROUTE}Match localuser remote\nKnownHostsCommand forbidden\n\
         Match localuser profile-user user remote\nHostKeyAlias approved-route\n{}",
        fixture.keys(),
    ))?;
    let selected = resolved(resolve(Some("profile-user")))?;
    assert_eq!(selected.host_key_alias.as_deref(), Some("approved-route"));
    assert_eq!(selected.revalidate(), Ok(()));
    assert!(
        matches!(resolve(Some("remote")), Err(failure) if failure.diagnostic.is_some_and(|d| d.directive == Directive::KnownHostsCommand))
    );
    assert!(
        matches!(resolve(None), Err(failure) if failure.diagnostic.is_some_and(|d| d.directive == Directive::Match))
    );

    fixture.write_config(&format!(
        "{ROUTE}Match originalhost unrelated localuser remote\nKnownHostsCommand forbidden\n\
         Match user remote\nHostKeyAlias remote-ok\n{}",
        fixture.keys(),
    ))?;
    assert_eq!(
        resolved(resolve(None))?.host_key_alias.as_deref(),
        Some("remote-ok")
    );
    // The condition is potentially applicable, even if a later criterion
    // would not match. Do not grant access with incomplete facts.
    fixture.write_config(&format!(
        "{ROUTE}Match !localuser remote originalhost unrelated\nKnownHostsCommand forbidden\n{}",
        fixture.keys(),
    ))?;
    assert!(matches!(resolve(None), Err(failure) if failure.code == UNSUPPORTED));
    Ok(())
}

#[test]
fn route_defaults_native_transport_checks_port_binding_and_refuses_unknown_localuser()
-> io::Result<()> {
    let fixture = Fixture::new()?;
    let root = fs::canonicalize(&fixture.0)?;
    let start = |port| {
        Transport::new(TransportConfig {
            // Construction alone checks the policy; neither fake child exists.
            ssh: root.join("absent-ssh"),
            keyscan: root.join("absent-keyscan"),
            host: Ipv4Addr::LOCALHOST.into(),
            port,
            user: "remote".to_owned(),
            identity: root.join("identity"),
            known_hosts: root.join("pins"),
            alias_config: Some((fixture.0.join("config"), "picker".to_owned())),
            system_config: None,
            workspace_root: None,
            dev_interactive_terminal: false,
            host_identity: Default::default(),
        })
        .map(drop)
    };
    let route = "HostName 127.0.0.1\nUser remote\n";
    fixture.write_config(&format!("{route}{}", fixture.keys()))?;
    assert_eq!(start(22), Ok(()));
    assert_eq!(start(2201), Err(UNSUPPORTED));
    fixture.write_config(&format!("{ROUTE}{}", fixture.keys()))?;
    assert_eq!(start(2201), Ok(()));
    fixture.write_config(&format!(
        "{route}Match localuser remote\nHostKeyAlias would-bind-wrong-user\n{}",
        fixture.keys()
    ))?;
    assert_eq!(start(22), Err(UNSUPPORTED));
    Ok(())
}

#[test]
fn route_defaults_user_expansion_and_match_refuse_unknown_effective_user() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let path = fixture.0.join("config");
    fixture.file("profile-user.cfg", b"Port 2223\n")?;
    let resolve = |initiator| resolve_with_diagnostic(&path, None, "picker", initiator);
    fixture.write_config(&format!(
        "HostName 127.0.0.1\nInclude %r.cfg\nUser remote\n{}",
        fixture.keys()
    ))?;
    assert_eq!(resolved(resolve(Some("profile-user")))?.port, 2223);
    assert!(
        matches!(resolve(None), Err(failure) if failure.diagnostic.is_some_and(|d| d.directive == Directive::Include))
    );

    fixture.write_config(&format!(
        "HostName 127.0.0.1\nMatch user profile-user\nPort 2224\nMatch all\nUser remote\n{}",
        fixture.keys()
    ))?;
    assert_eq!(resolved(resolve(Some("profile-user")))?.port, 2224);
    assert!(
        matches!(resolve(None), Err(failure) if failure.diagnostic.is_some_and(|d| d.directive == Directive::Match))
    );
    Ok(())
}
