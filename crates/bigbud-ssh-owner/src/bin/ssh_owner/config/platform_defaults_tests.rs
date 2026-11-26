use super::*;
use crate::transport::{Transport, TransportConfig};

// Active lines observed in the S0 macOS and Debian Bookworm profiles, in order.
// The system Include operand is made fixture-relative; the match set is empty
// as observed. These are frozen inputs, not platform qualification tests.
const SYSTEM_INCLUDE_AND_HOST: &str = "Include ssh_config.d/*.conf\nHost *\n";
const SEND_ENV: &str = "SendEnv LANG LC_*\n";
const HASH_KNOWN_HOSTS: &str = "HashKnownHosts yes\n";
const GSSAPI_AUTHENTICATION: &str = "GSSAPIAuthentication yes\n";

fn construct_with_system(defaults: &str) -> io::Result<Result<(), ErrorCode>> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.write_config(&format!("{ROUTE}{}", user.keys()))?;
    DirBuilder::new()
        .mode(0o700)
        .create(system.0.join("ssh_config.d"))?;
    system.file("config", defaults.as_bytes())?;
    let root = fs::canonicalize(&user.0)?;

    // Exercise construction only: neither tool exists in the private fixture,
    // and no scan, network connection, or other transport operation is called.
    Ok(Transport::new(TransportConfig {
        ssh: root.join("absent-ssh"),
        keyscan: root.join("absent-keyscan"),
        host: Ipv4Addr::LOCALHOST.into(),
        port: 2201,
        user: "remote".to_owned(),
        identity: root.join("identity"),
        known_hosts: root.join("pins"),
        alias_config: Some((user.0.join("config"), "picker".to_owned())),
        system_config: Some(system.0.join("config")),
        workspace_root: None,
        dev_interactive_terminal: false,
        host_identity: Default::default(),
    })
    .map(drop))
}

#[test]
fn sanitized_macos_and_debian_policies_construct_with_inert_gssapi() -> io::Result<()> {
    let macos = format!("{SYSTEM_INCLUDE_AND_HOST}{SEND_ENV}");
    assert_eq!(construct_with_system(&macos)?, Ok(()));
    // Policy v3: the owner forces GSSAPIAuthentication=no at launch.
    let debian = format!("{macos}{HASH_KNOWN_HOSTS}{GSSAPI_AUTHENTICATION}");
    assert_eq!(construct_with_system(&debian)?, Ok(()));
    Ok(())
}

#[test]
fn active_hash_policy_and_gssapi_authentication_are_admitted_but_other_gssapi_is_not()
-> io::Result<()> {
    assert_eq!(
        construct_with_system(&format!("Host *\n{HASH_KNOWN_HOSTS}"))?,
        Ok(())
    );
    assert_eq!(
        construct_with_system(&format!(
            "Host *\nGSSAPIAuthentication no\n{GSSAPI_AUTHENTICATION}"
        ))?,
        Ok(())
    );
    assert_eq!(
        construct_with_system("Host *\nGSSAPIKeyExchange yes\n")?,
        Err(UNSUPPORTED)
    );
    Ok(())
}

#[test]
fn hash_policy_uses_first_active_boolean_value_across_sources() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    system.file("config", HASH_KNOWN_HOSTS.as_bytes())?;
    for (directives, expected) in [
        ("", Some(true)),
        ("HashKnownHosts no\nHashKnownHosts yes\n", Some(false)),
        ("HashKnownHosts YES\nHashKnownHosts no\n", Some(true)),
        ("HashKnownHosts no\nHashKnownHosts invalid\n", None),
    ] {
        user.write_config(&format!("{ROUTE}{directives}{}", user.keys()))?;
        let resolved = resolve_with_system(
            &user.0.join("config"),
            &system.0.join("config"),
            "picker",
            "local",
        );
        assert_eq!(
            resolved.map(|policy| policy.hash_known_hosts),
            expected.ok_or(UNSUPPORTED)
        );
    }
    Ok(())
}

#[test]
fn minimal_synthetic_system_controls_construct_without_processes() -> io::Result<()> {
    let inactive = format!("Host unrelated\n{SEND_ENV}{HASH_KNOWN_HOSTS}{GSSAPI_AUTHENTICATION}");
    for defaults in [
        "Host *\n",
        "Host *\nHashKnownHosts no\n",
        "Host *\nGSSAPIAuthentication no\n",
        &inactive,
    ] {
        assert_eq!(construct_with_system(defaults)?, Ok(()), "{defaults:?}");
    }
    Ok(())
}
