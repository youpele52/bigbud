use super::*;

fn fact(uid: u32, name: &str) -> io::Result<LocalAccountFact> {
    LocalAccountFact::new(uid, name).map_err(|error| io::Error::other(format!("{error:?}")))
}

fn resolve_route(fixture: &Fixture, facts: &RouteFacts) -> Result<ResolvedConfig, ConfigFailure> {
    resolve_with_facts(&fixture.0.join("config"), None, "picker", facts)
}

fn secure_home(fixture: &Fixture) -> io::Result<()> {
    DirBuilder::new().mode(0o700).create(fixture.0.join("home"))
}

#[test]
fn route_facts_win_from_first_include_through_final_path_expansion() -> io::Result<()> {
    let fixture = Fixture::new()?;
    secure_home(&fixture)?;
    for name in ["identity", "pins"] {
        fixture.file(&format!("home/{name}-override-2208"), b"fixture")?;
    }
    fixture.file(
        "route-127.0.0.2-picker-2208-override.cfg",
        b"Match localuser initiating user override host 127.0.0.2 originalhost picker\nHostKeyAlias exact-route\n",
    )?;
    fixture.write_config(
        "Host picker\nInclude route-%h-%n-%p-%r.cfg\n\
         Host 127.0.0.2\nGSSAPIAuthentication yes\n\
         Host *\nHostName 127.0.0.3\nUser from-config\nPort 2299\n\
         IdentityFile ~/identity-%r-%p\nUserKnownHostsFile ~/pins-%r-%p\n",
    )?;
    let overrides = RouteOverrides::new(
        Some(Ipv4Addr::new(127, 0, 0, 2).into()),
        Some("override"),
        NonZeroU16::new(2208),
    )
    .expect("valid private fixture override");
    let facts = RouteFacts::new(Some(fact(501, "initiating")?), overrides);
    let route = resolve_route(&fixture, &facts)
        .map_err(|failure| io::Error::other(format!("{failure:?}")))?;
    let root = fs::canonicalize(&fixture.0)?;
    assert_eq!(route.host, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)));
    assert_eq!((route.user.as_str(), route.port), ("override", 2208));
    assert_eq!(route.host_key_alias.as_deref(), Some("exact-route"));
    assert_eq!(route.identity, root.join("home/identity-override-2208"));
    assert_eq!(
        route.known_hosts,
        Some(root.join("home/pins-override-2208"))
    );
    drop(facts);
    assert_eq!(route.revalidate(), Ok(()));
    fs::write(
        root.join("route-127.0.0.2-picker-2208-override.cfg"),
        b"HostKeyAlias changed\n",
    )?;
    assert_eq!(route.revalidate(), Err(UNSUPPORTED));
    Ok(())
}

#[test]
fn route_facts_partially_override_config_but_do_not_suppress_policy_denial() -> io::Result<()> {
    let fixture = Fixture::new()?;
    let facts = RouteFacts::new(
        Some(fact(501, "initiating")?),
        RouteOverrides::new(None, Some("override"), None).expect("valid user override"),
    );
    fixture.write_config(&format!(
        "{ROUTE}User fallback\nPort 2203\n\
         Match user override localuser initiating\nHostKeyAlias from-match\n{}",
        fixture.keys()
    ))?;
    let route = resolve_route(&fixture, &facts)
        .map_err(|failure| io::Error::other(format!("{failure:?}")))?;
    assert_eq!((route.user.as_str(), route.port), ("override", 2201));
    assert_eq!(route.host_key_alias.as_deref(), Some("from-match"));
    let no_local_fact = RouteFacts::new(None, facts.overrides.clone());
    assert!(
        matches!(resolve_route(&fixture, &no_local_fact), Err(failure)
        if failure.diagnostic.is_some_and(|d| d.directive == Directive::Match))
    );

    let marker = fixture.0.join("should-not-run");
    for (policy, denied) in [
        ("User -invalid".to_owned(), Directive::User),
        (
            "Match user override\nGSSAPIKeyExchange yes".to_owned(),
            Directive::GSSAPIKeyExchange,
        ),
        ("Match unknown override".to_owned(), Directive::Match),
        (
            format!("Match user override exec \"touch {}\"", marker.display()),
            Directive::Match,
        ),
    ] {
        fixture.write_config(&format!("{ROUTE}{policy}\n{}", fixture.keys()))?;
        assert!(matches!(resolve_route(&fixture, &facts), Err(failure)
            if failure.diagnostic.is_some_and(|d| d.directive == denied)));
    }
    assert!(!marker.exists());
    Ok(())
}

#[test]
fn route_facts_fingerprint_distinguishes_uid_and_explicit_defaults() -> io::Result<()> {
    let fixture = Fixture::new()?;
    fixture.write_config("HostName 127.0.0.1\nUser remote\n")?;
    let scope = Scope::open(&fixture.0.join("config"))
        .map_err(|error| io::Error::other(format!("{error:?}")))?;
    let graph = |facts: &RouteFacts| {
        include::evaluate(&scope, None, "picker", facts)
            .map(|(_, sources)| sources)
            .map_err(|failure| io::Error::other(format!("{failure:?}")))
    };
    let base = RouteFacts::new(Some(fact(501, "initiating")?), RouteOverrides::default());
    assert!(graph(&base)? == graph(&base.clone())?);
    for changed in [
        RouteFacts::default(),
        RouteFacts::new(Some(fact(502, "initiating")?), RouteOverrides::default()),
        RouteFacts::new(Some(fact(501, "other")?), RouteOverrides::default()),
        RouteFacts::new(
            Some(fact(501, "initiating")?),
            RouteOverrides::new(Some(Ipv4Addr::LOCALHOST.into()), None, None).expect("loopback"),
        ),
        RouteFacts::new(
            Some(fact(501, "initiating")?),
            RouteOverrides::new(None, Some("remote"), None).expect("remote user"),
        ),
        RouteFacts::new(
            Some(fact(501, "initiating")?),
            RouteOverrides::new(None, None, NonZeroU16::new(22)).expect("default port"),
        ),
    ] {
        assert!(graph(&base)? != graph(&changed)?);
    }
    assert!(LocalAccountFact::new(501, "$USER").is_err());
    assert!(RouteOverrides::new(None, Some("-bad"), None).is_err());
    assert!(RouteOverrides::new(Some(Ipv4Addr::new(192, 0, 2, 42).into()), None, None).is_err());
    Ok(())
}
