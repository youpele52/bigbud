use super::*;

fn digest(fixture: &Fixture, config: &str) -> [u8; 32] {
    fixture.write_config(config).unwrap();
    match fixture.resolve() {
        Ok(resolved) => resolved.descriptor_digest(),
        Err(error) => panic!("{error:?}: {config}"),
    }
}

#[test]
fn alias_descriptor_tracks_route_and_trust_facts_but_not_identity_or_timers() {
    let fixture = Fixture::new().unwrap();
    fixture
        .file("second-identity", b"synthetic key material")
        .unwrap();
    fixture.file("other-pins", b"").unwrap();
    let keys = fixture.keys();
    let base = digest(&fixture, &format!("{ROUTE}{keys}"));
    assert_eq!(base, digest(&fixture, &format!("{ROUTE}{keys}")));
    // Comments, identities and timers do not change where or whom the owner trusts.
    let other_identity = fixture.0.join("second-identity");
    for unchanged in [
        format!("# reviewed\n{ROUTE}{keys}"),
        format!(
            "{ROUTE} ConnectTimeout 4\n{keys} IdentityFile {}\n",
            other_identity.display()
        ),
    ] {
        assert_eq!(base, digest(&fixture, &unchanged), "{unchanged}");
    }
    let changed = [
        ROUTE.replace("127.0.0.1", "127.0.0.2"),
        ROUTE.replace("2201", "2202"),
        ROUTE.replace("remote", "other"),
        format!("{ROUTE} HostKeyAlias renamed-key\n"),
    ];
    let mut seen = vec![base];
    for config in changed {
        let next = digest(&fixture, &format!("{config}{keys}"));
        assert!(!seen.contains(&next), "{config}");
        seen.push(next);
    }
    let other_pins = keys.replace(
        &fixture.0.join("pins").display().to_string(),
        &fixture.0.join("other-pins").display().to_string(),
    );
    assert!(!seen.contains(&digest(&fixture, &format!("{ROUTE}{other_pins}"))));
}

#[test]
fn the_exact_connector_is_admitted_as_policy_but_not_as_a_direct_route() {
    let fixture = Fixture::new().unwrap();
    let keys = fixture.keys();
    let direct = digest(&fixture, &format!("{ROUTE}{keys}"));
    fixture
        .write_config(&format!(
            "{ROUTE} ProxyCommand nc %h %p\n ProxyCommand none\n{keys}"
        ))
        .unwrap();
    let resolved = fixture.resolve().unwrap();
    // First value wins, and the connector is part of the saved-alias descriptor.
    assert_eq!(resolved.connector, Some(ConnectorProgram::Bare));
    assert_ne!(resolved.descriptor_digest(), direct);
    fixture
        .write_config(&format!(
            "{ROUTE} ProxyCommand none\n ProxyCommand nc %h %p\n{keys}"
        ))
        .unwrap();
    assert_eq!(fixture.resolve().unwrap().connector, None);
}
