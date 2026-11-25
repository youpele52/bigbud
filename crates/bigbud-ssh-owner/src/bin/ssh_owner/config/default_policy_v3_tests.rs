//! Policy v3 (U1): admit the stock Debian 13 `GSSAPIAuthentication yes`
//! because the owner's private launch forces `GSSAPIAuthentication=no`, so
//! GSSAPI is provably inert. Every other GSSAPI directive stays refused.
use super::*;
use crate::config::diagnostic::{Directive, SourceClass};

// Stock Debian 13 `/etc/ssh/ssh_config` active lines (comments omitted), with
// the Include prefix made fixture-relative. The shipped line order is kept.
const DEBIAN_STOCK: &str = "Include ssh_config.d/*.conf\n\
    Host *\n\
    \x20   SendEnv LANG LC_*\n\
    \x20   HashKnownHosts yes\n\
    \x20   GSSAPIAuthentication yes\n";

// Packaged systemd 257 `20-systemd-ssh-proxy.conf`, active lines verbatim.
const SYSTEMD_PROXY: &str = "Host .host machine/.host\n\
    \x20       ProxyCommand /usr/lib/systemd/systemd-ssh-proxy unix/run/ssh-unix-local/socket %p\n\
    \x20       ProxyUseFdpass yes\n        CheckHostIP no\n\
    Host unix/* vsock/* machine/*\n\
    \x20       ProxyCommand /usr/lib/systemd/systemd-ssh-proxy %h %p\n\
    \x20       ProxyUseFdpass yes\n        CheckHostIP no\n\
    \x20       StrictHostKeyChecking no\n        UserKnownHostsFile /dev/null\n";

fn with_system(system_text: &str) -> Result<ResolvedConfig, ConfigFailure> {
    let user = Fixture::new().unwrap();
    let system = Fixture::new().unwrap();
    user.write_config(&format!("{}{}", ROUTE, user.keys()))
        .unwrap();
    DirBuilder::new()
        .mode(0o700)
        .create(system.0.join("ssh_config.d"))
        .unwrap();
    system
        .file(
            "ssh_config.d/20-systemd-ssh-proxy.conf",
            SYSTEMD_PROXY.as_bytes(),
        )
        .unwrap();
    system.file("config", system_text.as_bytes()).unwrap();
    resolve_with_diagnostic(
        &user.0.join("config"),
        Some(&system.0.join("config")),
        "picker",
        Some("local"),
    )
}

#[test]
fn stock_debian_config_is_admitted_unedited_with_inert_gssapi() {
    // The packaged systemd stanzas stay inert for the ordinary alias (v2).
    let resolved = with_system(DEBIAN_STOCK).unwrap_or_else(|failure| panic!("{failure:?}"));
    assert_eq!(resolved.connector, None);
    assert!(resolved.known_hosts.is_some());
    // GSSAPI is never offered: the launch forces the override after config.
    assert!(crate::transport::AUTH_METHOD_OPTIONS.contains(&GSSAPI_INERT_OVERRIDE));
    assert_eq!(
        crate::transport::AUTH_METHOD_OPTIONS
            .iter()
            .filter(|option| option
                .to_ascii_lowercase()
                .starts_with("preferredauthentications="))
            .copied()
            .collect::<Vec<_>>(),
        ["PreferredAuthentications=publickey"]
    );
    assert!(!is_fixed_policy(
        Directive::PreferredAuthentications,
        "gssapi-with-mic"
    ));
    assert!(
        !crate::transport::AUTH_METHOD_OPTIONS
            .iter()
            .any(|option| option.to_ascii_lowercase().contains("gssapi-with-mic"))
    );
}

#[test]
fn non_authentication_gssapi_directives_stay_refused_with_redacted_locations() {
    for (directive, expected) in [
        (
            "GSSAPIDelegateCredentials yes",
            Directive::GSSAPIDelegateCredentials,
        ),
        ("GSSAPIKeyExchange yes", Directive::GSSAPIKeyExchange),
        ("GSSAPITrustDNS yes", Directive::GSSAPITrustDNS),
    ] {
        let text = DEBIAN_STOCK.replace("GSSAPIAuthentication yes", directive);
        let failure = with_system(&text)
            .err()
            .unwrap_or_else(|| panic!("{directive} must be refused"));
        let diagnostic = failure
            .diagnostic
            .unwrap_or_else(|| panic!("{directive} location"));
        assert_eq!(failure.code, ErrorCode::ConfigUnsupported);
        assert_eq!(diagnostic.directive, expected);
        assert_eq!(diagnostic.source, SourceClass::SystemConfig);
        assert_eq!(diagnostic.line, 5);
        assert!(
            diagnostic
                .remedy()
                .contains("Remove other GSSAPI directives")
        );
        assert!(!format!("{failure:?}").contains("yes"));
    }
}

#[test]
fn gssapi_authentication_yes_and_no_are_the_only_admitted_values() {
    for value in ["yes", "no", "YES", "No"] {
        assert!(
            is_fixed_policy(Directive::GSSAPIAuthentication, value),
            "{value}"
        );
    }
    for value in ["", "maybe", "gssapi-with-mic", "yes extra"] {
        assert!(
            !is_fixed_policy(Directive::GSSAPIAuthentication, value),
            "{value}"
        );
    }
}
