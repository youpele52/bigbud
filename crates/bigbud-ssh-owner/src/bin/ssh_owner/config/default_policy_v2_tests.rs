//! Policy v2 for shipped Debian 13 defaults: `/` in Host patterns and exact
//! terminal-colour SendEnv names. The GSSAPI case is policy v3, recorded in
//! `default_policy_v3_tests.rs`; it supersedes the v2 refusal here.
use super::*;
use crate::config::diagnostic::{Directive, SourceClass};
use std::process::Command;

// Packaged systemd 257 `20-systemd-ssh-proxy.conf`, active lines verbatim.
const SYSTEMD_PROXY: &str = "Host .host machine/.host\n\
    \x20       ProxyCommand /usr/lib/systemd/systemd-ssh-proxy unix/run/ssh-unix-local/socket %p\n\
    \x20       ProxyUseFdpass yes\n        CheckHostIP no\n\
    Host unix/* vsock/* machine/*\n\
    \x20       ProxyCommand /usr/lib/systemd/systemd-ssh-proxy %h %p\n\
    \x20       ProxyUseFdpass yes\n        CheckHostIP no\n\
    \x20       StrictHostKeyChecking no\n        UserKnownHostsFile /dev/null\n";

fn with_system(system_text: &str, alias: &str) -> Result<ResolvedConfig, ConfigFailure> {
    let user = Fixture::new().unwrap();
    let system = Fixture::new().unwrap();
    user.write_config(&format!(
        "{}{}",
        ROUTE.replace("picker", alias),
        user.keys()
    ))
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
    let path = user.0.join("config");
    resolve_with_diagnostic(&path, Some(&system.0.join("config")), alias, Some("local"))
}

#[test]
fn systemd_slash_stanzas_stay_inert_for_ordinary_aliases() {
    let debian = "Include ssh_config.d/*.conf\nHost *\n    SendEnv LANG LC_* COLORTERM NO_COLOR\n    \
                  HashKnownHosts yes\n    GSSAPIAuthentication no\n";
    for alias in ["picker", "unix", "machine", "vsock", "host", "localhost"] {
        let resolved = with_system(debian, alias).unwrap_or_else(|f| panic!("{alias}: {f:?}"));
        assert_eq!(resolved.connector, None, "{alias}");
        assert!(resolved.known_hosts.is_some(), "{alias}");
    }
    // A slash pattern that names the alias's own text still cannot match it.
    let user = Fixture::new().unwrap();
    user.write_config(&format!(
        "Host picker/* */picker picker/\n ProxyUseFdpass yes\n{ROUTE}{}",
        user.keys()
    ))
    .unwrap();
    assert!(user.resolve().is_ok());
}

#[test]
fn slash_does_not_widen_other_pattern_syntax_or_active_denials() {
    let user = Fixture::new().unwrap();
    for pattern in ["unix/[a]", "unix\\/x", "machine/{a,b}", "unix/ x/%h"] {
        user.write_config(&format!(
            "Host {pattern}\n ProxyUseFdpass yes\n{ROUTE}{}",
            user.keys()
        ))
        .unwrap();
        assert!(matches!(user.resolve(), Err(UNSUPPORTED)), "{pattern}");
    }
    // An active stanza is still policed: ProxyUseFdpass yes applies to `*`.
    user.write_config(&format!(
        "Host */* *\n ProxyUseFdpass yes\n{ROUTE}{}",
        user.keys()
    ))
    .unwrap();
    assert!(matches!(user.resolve(), Err(UNSUPPORTED)));
}

#[test]
fn gssapi_authentication_is_admitted_only_under_the_inert_override() {
    let debian = "Include ssh_config.d/*.conf\nHost *\n    SendEnv LANG LC_* COLORTERM NO_COLOR\n    \
                  HashKnownHosts yes\n    GSSAPIAuthentication yes\n";
    // Policy v3: the owner's private launch forces GSSAPIAuthentication=no,
    // so the authored value is inert and admitted. See default_policy_v3_tests.
    assert!(with_system(debian, "picker").is_ok());
    assert!(
        with_system(
            &debian.replace("GSSAPIAuthentication yes", "GSSAPIAuthentication no"),
            "picker"
        )
        .is_ok()
    );
    // Any other GSSAPI directive still has a located, redacted refusal.
    let failure = with_system(
        &debian.replace("GSSAPIAuthentication yes", "GSSAPIKeyExchange yes"),
        "picker",
    )
    .err()
    .expect("GSSAPI key exchange must be refused");
    let diagnostic = failure.diagnostic.expect("located rejection");
    assert_eq!(failure.code, ErrorCode::ConfigUnsupported);
    assert_eq!(diagnostic.directive, Directive::GSSAPIKeyExchange);
    assert_eq!(diagnostic.source, SourceClass::SystemConfig);
    assert_eq!(diagnostic.line, 5);
    assert!(!format!("{failure:?}").contains("yes"));
}

#[test]
fn only_exact_terminal_colour_names_join_the_locale_send_env_set() {
    let fixture = Fixture::new().unwrap();
    for operands in [
        "COLORTERM",
        "NO_COLOR",
        "LANG COLORTERM -COLORTERM NO_COLOR",
    ] {
        fixture
            .write_config(&format!("{ROUTE} SendEnv {operands}\n{}", fixture.keys()))
            .unwrap();
        assert!(fixture.resolve().is_ok(), "{operands}");
    }
    for denied in [
        "COLORTERM_X",
        "NO_COLORS",
        "COLOR*",
        "TERM",
        "colorterm",
        "-TERM",
        "NO_COLOR,LANG",
    ] {
        fixture
            .write_config(&format!("{ROUTE} SendEnv {denied}\n{}", fixture.keys()))
            .unwrap();
        assert!(matches!(fixture.resolve(), Err(UNSUPPORTED)), "{denied}");
    }
    fixture
        .write_config(&format!(
            "{ROUTE} SendEnv LC_* COLORTERM NO_COLOR\n{}",
            fixture.keys()
        ))
        .unwrap();
    let mut command = Command::new("/unused");
    let env = [
        ("COLORTERM", "truecolor"),
        ("NO_COLOR", "1"),
        ("TERM", "xterm"),
        ("LC_TIME", "C"),
    ];
    fixture
        .resolve()
        .unwrap()
        .send_env
        .apply_to(&mut command, || {
            env.iter()
                .map(|(name, value)| ((*name).into(), (*value).into()))
        })
        .unwrap();
    let args = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        args,
        [
            "-o",
            "SendEnv=COLORTERM",
            "-o",
            "SendEnv=LC_TIME",
            "-o",
            "SendEnv=NO_COLOR"
        ]
    );
    let envs = command
        .get_envs()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(!envs.contains(&"TERM".to_owned()));
}
