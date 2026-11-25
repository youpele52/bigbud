#![allow(clippy::expect_used)]

use super::*;

#[test]
fn fixture_does_not_accept_extra_capabilities_or_nonlocal_lock_paths() {
    let args = [
        "aabb",
        "target",
        r"C:\proof\owner.lock",
        "2222",
        "fixture",
        r"C:\proof\id_ed25519",
        r"C:\proof\known_hosts",
    ];
    let fixture = Fixture::parse(args.map(OsString::from).into_iter()).expect("picker fixture");
    assert_eq!(
        fixture.config.host,
        std::net::IpAddr::V4(Ipv4Addr::LOCALHOST)
    );
    assert_eq!(fixture.config.port, 2222);
    assert_eq!(fixture.profile, vec![0xaa, 0xbb]);
    assert!(
        Fixture::parse(
            args.into_iter()
                .chain(["--attach-pipe"])
                .map(OsString::from)
        )
        .is_err()
    );
    for invalid in [
        r"C:owner.lock",
        r"\proof\owner.lock",
        r"\\localhost\proof\owner.lock",
        r"\\.\pipe\owner.lock",
        r"C:\proof\owner.lock:replacement",
        r"C:\proof\..\owner.lock",
    ] {
        assert!(!valid_lock_path(Path::new(invalid)), "{invalid:?}");
    }
}
