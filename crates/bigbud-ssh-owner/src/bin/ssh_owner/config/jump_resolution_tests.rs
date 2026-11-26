use super::*;

#[test]
fn resolves_ordered_key_only_aliases_with_per_hop_overrides() {
    let fixture = Fixture::new().unwrap();
    fixture
        .write_config(&format!(
            "Host picker\nHostName 127.0.0.1\nUser target\nPort 2300\nProxyJump override@relay:2210,[::1]:2211\n\
             Host relay\nHostName 127.0.0.1\nUser configured\nPort 2299\n\
             Host ::1\nUser ipv6\n{}",
            fixture.keys()
        ))
        .unwrap();
    assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)));
    let chain = jump::resolve_chain(
        &fixture.0.join("config"),
        None,
        "picker",
        RouteFacts::default(),
    )
    .unwrap();
    let resolved = chain
        .iter()
        .map(|leg| (leg.host.to_string(), leg.port, leg.user.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        resolved,
        [
            ("127.0.0.1".into(), 2210, "override"),
            ("::1".into(), 2211, "ipv6"),
            ("127.0.0.1".into(), 2300, "target"),
        ]
    );
    for leg in &chain {
        leg.revalidate().unwrap();
    }
    fixture
        .write_config(
            "Host stale
HostName 127.0.0.1
",
        )
        .unwrap();
    for leg in &chain {
        assert_eq!(leg.revalidate(), Err(UNSUPPORTED));
    }
}

#[test]
fn refuses_resolved_cycles_nested_routes_and_mixed_proxy_policy() {
    let cases = [
        ("ProxyJump relay", "HostName 127.0.0.1\nPort 2300", Some(1)),
        (
            "ProxyJump relay",
            "HostName 127.0.0.1\nProxyJump nested",
            Some(1),
        ),
        (
            "ProxyJump relay\nProxyCommand none",
            "HostName 127.0.0.1",
            None,
        ),
    ];
    for (policy, relay, hop) in cases {
        let fixture = Fixture::new().unwrap();
        fixture
            .write_config(&format!(
                "Host picker\nHostName 127.0.0.1\nUser target\nPort 2300\n{policy}\n\
                 Host relay\nUser bastion\n{relay}\n{}",
                fixture.keys()
            ))
            .unwrap();
        let failure = jump::resolve_chain(
            &fixture.0.join("config"),
            None,
            "picker",
            RouteFacts::default(),
        )
        .err()
        .expect("policy rejected");
        assert_eq!(failure.code, UNSUPPORTED);
        assert_eq!(failure.jump_hop, hop);
    }
}
