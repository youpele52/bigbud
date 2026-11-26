use super::*;
use crate::config::{source::MAX_CONFIG, startup};
use serde_json::{Value, json};

fn capture(failure: ConfigFailure) -> io::Result<(Value, String)> {
    let mut bytes = Vec::new();
    assert_eq!(
        startup::report_rejection(failure, &mut bytes),
        ErrorCode::ConfigUnsupported
    );
    assert!(bytes.len() <= startup::MAX_RECORD_BYTES);
    assert_eq!(bytes.last(), Some(&b'\n'));
    assert_eq!(bytes.iter().filter(|&&byte| byte == b'\n').count(), 1);
    assert!(bytes.is_ascii());
    let fields: Value = serde_json::from_slice(&bytes)?;
    Ok((fields, String::from_utf8(bytes).map_err(io::Error::other)?))
}

#[test]
fn reports_one_stable_record_without_alias_include_path_or_directive_value() -> io::Result<()> {
    let user = Fixture::new()?;
    let system = Fixture::new()?;
    user.file("config", ROUTE.as_bytes())?;
    system.file("config", b"Include private-include-name\n")?;
    system.file(
        "private-include-name",
        b"Host private-host\npRoXyCoMmAnD \"/private/credential secret-value\"\n",
    )?;
    let result = resolve_with_diagnostic(
        &user.0.join("config"),
        Some(&system.0.join("config")),
        "private-host",
        Some("private-local-user"),
    );
    let Err(failure) = result else {
        return Err(io::Error::other("expected config rejection"));
    };
    let (fields, record) = capture(failure)?;
    assert_eq!(
        fields,
        json!({
            "event": "ssh_owner_alias_policy_rejected",
            "version": 1,
            "code": "config_unsupported",
            "location": {"directive": "ProxyCommand", "source": "system_include", "line": 2},
            "remedy": "Use ProxyCommand nc %h %p (or a qualified absolute nc with exactly %h %p), or a direct route.",
        })
    );
    for secret in [
        "private-host",
        "private-local-user",
        "private-include-name",
        "/private/credential",
        "secret-value",
        "pRoXyCoMmAnD",
        &user.0.to_string_lossy(),
        &system.0.to_string_lossy(),
    ] {
        assert!(!record.contains(secret));
    }
    Ok(())
}

#[test]
fn unknown_keywords_and_invalid_aliases_cannot_add_record_fields() -> io::Result<()> {
    let user = Fixture::new()?;
    let path = user.0.join("config");
    let keyword = "PRIVATE_KEYWORD".repeat(300);
    user.file(
        "config",
        format!("{ROUTE}{keyword} \"secret\\\" forged-event\"\n").as_bytes(),
    )?;
    let Err(failure) = resolve_with_diagnostic(&path, None, "picker", Some("local")) else {
        return Err(io::Error::other("expected unknown directive rejection"));
    };
    let (fields, record) = capture(failure)?;
    assert_eq!(
        fields.get("location"),
        Some(&json!({"directive": "unknown", "source": "user_config", "line": 5}))
    );
    assert!(!record.contains("PRIVATE_KEYWORD"));
    assert!(!record.contains("forged-event"));
    assert!(!record.contains("secret"));

    let Err(failure) = resolve_with_diagnostic(
        &path,
        None,
        "alias-secret\nforged-event\x1b[31m",
        Some("local"),
    ) else {
        return Err(io::Error::other("expected invalid alias rejection"));
    };
    let (fields, record) = capture(failure)?;
    assert_eq!(fields.get("location"), Some(&Value::Null));
    assert!(!record.contains("alias-secret"));
    assert!(!record.contains("forged-event"));
    assert!(!record.contains("[31m"));
    Ok(())
}

#[test]
fn reports_only_realistic_locations_for_all_source_classes() -> io::Result<()> {
    use crate::config::diagnostic::SourceClass;

    let failure = |source, line| {
        ConfigDiagnostic {
            directive: Directive::UserKnownHostsFile,
            source,
            line,
        }
        .reject(ErrorCode::ConfigUnsupported)
    };
    for (source, identifier) in [
        (SourceClass::UserConfig, "user_config"),
        (SourceClass::UserInclude, "user_include"),
        (SourceClass::SystemConfig, "system_config"),
        (SourceClass::SystemInclude, "system_include"),
    ] {
        let (fields, _) = capture(failure(source, MAX_CONFIG as usize))?;
        assert_eq!(
            fields.get("location"),
            Some(
                &json!({"directive": "UserKnownHostsFile", "source": identifier, "line": MAX_CONFIG})
            )
        );
    }
    for line in [0, MAX_CONFIG as usize + 1, usize::MAX] {
        let (fields, _) = capture(failure(SourceClass::UserInclude, line))?;
        assert_eq!(fields.get("location"), Some(&Value::Null));
    }
    Ok(())
}

#[test]
fn broken_stderr_does_not_mask_rejection_and_other_failures_are_not_reported() {
    struct Closed;
    impl Write for Closed {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    assert_eq!(
        startup::report_rejection(ErrorCode::ConfigUnsupported.into(), Closed),
        ErrorCode::ConfigUnsupported
    );
    let mut bytes = Vec::new();
    assert_eq!(
        startup::report_rejection(ErrorCode::OperationDenied.into(), &mut bytes),
        ErrorCode::OperationDenied
    );
    assert!(bytes.is_empty());
}
