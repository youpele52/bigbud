use super::*;
use crate::config::diagnostic::{ConfigDiagnostic, Directive, SourceClass};

fn rejected(
    user: &Fixture,
    system: Option<&Fixture>,
    expected: ConfigDiagnostic,
    private: &[&str],
) -> io::Result<()> {
    let path = user.0.join("config");
    let system_path = system.map(|fixture| fixture.0.join("config"));
    let result = resolve_with_diagnostic(&path, system_path.as_deref(), "picker", Some("local"));
    let Err(failure) = result else {
        return Err(io::Error::other("expected a config failure"));
    };
    assert_eq!(failure.code, ErrorCode::ConfigUnsupported);
    assert_eq!(failure.diagnostic, Some(expected));
    let rendered = format!(
        "{failure:?} {} {}",
        expected.directive.identifier(),
        expected.remedy()
    );
    assert!(rendered.len() < 384);
    assert!(!rendered.contains(&*user.0.to_string_lossy()));
    if let Some(system) = system {
        assert!(!rendered.contains(&*system.0.to_string_lossy()));
    }
    for secret in private {
        assert!(!rendered.contains(secret));
    }
    let legacy = match system_path {
        Some(system_path) => resolve_with_system(&path, &system_path, "picker", "local"),
        None => user.resolve(),
    };
    assert!(matches!(legacy, Err(ErrorCode::ConfigUnsupported)));
    Ok(())
}

#[test]
fn identifies_a_rejected_active_directive_without_its_sensitive_value() -> io::Result<()> {
    let user = Fixture::new()?;
    user.write_config(&format!(
        "Host other\n NestedSecretKeyword ignored\n ProxyJump \"unterminated\n\
         Host picker\n pRoXyCoMmAnD \"/private/token-path --secret secret-value\"\n{}",
        user.keys()
    ))?;
    let expected = ConfigDiagnostic {
        directive: Directive::ProxyCommand,
        source: SourceClass::UserConfig,
        line: 5,
    };
    assert_eq!(expected.directive.identifier(), "ProxyCommand");
    assert_eq!(
        expected.remedy(),
        "Use ProxyCommand nc %h %p (or a qualified absolute nc with exactly %h %p), or a direct route."
    );
    rejected(
        &user,
        None,
        expected,
        &["/private/token-path", "secret-value", "pRoXyCoMmAnD"],
    )
}

#[test]
fn malformed_unknown_and_oversized_keywords_never_escape() -> io::Result<()> {
    let user = Fixture::new()?;
    let oversized = "SensitiveKeyword".repeat(300);
    for keyword in [
        "SensitiveKeyword",
        "Sensitive!Keyword",
        "Sensitive\u{1b}Keyword",
        &oversized,
    ] {
        user.write_config(&format!("{ROUTE}{keyword} secret-value\n{}", user.keys()))?;
        let expected = ConfigDiagnostic {
            directive: Directive::Unknown,
            source: SourceClass::UserConfig,
            line: 5,
        };
        assert_eq!(expected.directive.identifier(), "unknown");
        rejected(&user, None, expected, &["Sensitive", "secret-value"])?;
    }
    Ok(())
}

#[test]
fn reports_deepest_include_line_and_its_root_class() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    for (fixture, source) in [
        (&user, SourceClass::UserInclude),
        (&system, SourceClass::SystemInclude),
    ] {
        fixture.file("private-outer", b"Include private-inner\n")?;
        fixture.file("private-inner", b"# ignored\n\nMatch exec sensitive-cmd\n")?;
        fixture.file("config", b"Include private-outer\n")?;
        rejected(
            &user,
            (source == SourceClass::SystemInclude).then_some(&system),
            ConfigDiagnostic {
                directive: Directive::Match,
                source,
                line: 3,
            },
            &["private-inner", "private-outer", "sensitive-cmd"],
        )?;
        user.write_config(&format!("{ROUTE}{}", user.keys()))?;
    }
    Ok(())
}

#[test]
fn reports_include_site_if_nested_source_cannot_be_read() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.write_config(&format!("{ROUTE}{}", user.keys()))?;
    system.file("config", b"# first\nInclude sensitive-missing-file\n")?;
    rejected(
        &user,
        Some(&system),
        ConfigDiagnostic {
            directive: Directive::Include,
            source: SourceClass::SystemConfig,
            line: 2,
        },
        &["sensitive-missing-file"],
    )
}

#[test]
fn deferred_policy_failures_report_the_effective_directive() -> io::Result<()> {
    let user = Fixture::new()?;
    user.write_config(&format!(
        "Host picker\nHostName private-destination\nHostName 127.0.0.1\nPort 2201\nUser remote\n{}",
        user.keys(),
    ))?;
    rejected(
        &user,
        None,
        ConfigDiagnostic {
            directive: Directive::HostName,
            source: SourceClass::UserConfig,
            line: 2,
        },
        &["private-destination"],
    )?;
    user.write_config(&format!("Port 0\n{ROUTE}{}", user.keys()))?;
    rejected(
        &user,
        None,
        ConfigDiagnostic {
            directive: Directive::Port,
            source: SourceClass::UserConfig,
            line: 1,
        },
        &[],
    )
}

#[test]
fn trust_remains_fail_closed_at_parse_and_binding() -> io::Result<()> {
    let user = Fixture::new()?;
    user.write_config(&format!(
        "{ROUTE}StrictHostKeyChecking yes\nStrictHostKeyChecking no\n{}",
        user.keys()
    ))?;
    rejected(
        &user,
        None,
        ConfigDiagnostic {
            directive: Directive::StrictHostKeyChecking,
            source: SourceClass::UserConfig,
            line: 6,
        },
        &[],
    )?;
    symlink(user.0.join("pins"), user.0.join("private-link"))?;
    user.write_config(&format!(
        "{ROUTE}IdentityFile {}\nUserKnownHostsFile {}\n",
        user.0.join("identity").display(),
        user.0.join("private-link").display(),
    ))?;
    rejected(
        &user,
        None,
        ConfigDiagnostic {
            directive: Directive::UserKnownHostsFile,
            source: SourceClass::UserConfig,
            line: 6,
        },
        &["private-link"],
    )
}

#[test]
fn reports_a_missing_global_trust_operand_without_disclosing_either_path() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.write_config(&format!("{ROUTE}{}", user.keys()))?;
    system.file("private-first", b"")?;
    system.file(
        "config",
        format!(
            "# trust policy\nGlobalKnownHostsFile {} {}\n",
            system.0.join("private-first").display(),
            system.0.join("private-missing").display(),
        )
        .as_bytes(),
    )?;
    rejected(
        &user,
        Some(&system),
        ConfigDiagnostic {
            directive: Directive::GlobalKnownHostsFile,
            source: SourceClass::SystemConfig,
            line: 2,
        },
        &["private-first", "private-missing"],
    )
}

#[test]
fn failures_without_a_directive_do_not_invent_a_location() -> io::Result<()> {
    let user = Fixture::new()?;
    let Err(failure) =
        resolve_with_diagnostic(&user.0.join("config"), None, "picker", Some("local"))
    else {
        return Err(io::Error::other("missing config unexpectedly resolved"));
    };
    assert_eq!(failure.code, ErrorCode::ConfigUnsupported);
    assert_eq!(failure.diagnostic, None);
    Ok(())
}
