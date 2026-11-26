use super::{Kind, admits, executable_missing, remote_command};
use crate::v1::{ErrorCode, ProviderLeaseKind, ProviderLeaseScope};

fn scope(kind: ProviderLeaseKind, cwd: &str, thread: &str) -> ProviderLeaseScope {
    ProviderLeaseScope {
        kind: kind.into(),
        thread_id: thread.into(),
        session_epoch: 3,
        cwd: cwd.into(),
        default_mode_user_input: false,
        session_file: None,
        codex_home: None,
    }
}

#[test]
fn admits_only_a_known_kind_an_exact_cwd_and_a_bounded_thread() {
    let pi = scope(ProviderLeaseKind::Pi, "/srv/work", "thread-1");
    assert_eq!(admits(&pi, true), Ok(Kind::Pi));
    let codex = scope(ProviderLeaseKind::Codex, "/srv/work", "thread-1");
    assert_eq!(admits(&codex, false), Ok(Kind::Codex));
    for refused in [
        scope(ProviderLeaseKind::Unspecified, "/srv/work", "t"),
        scope(ProviderLeaseKind::Pi, "/", "t"),
        scope(ProviderLeaseKind::Pi, "srv/work", "t"),
        scope(ProviderLeaseKind::Pi, "/srv/../etc", "t"),
        scope(ProviderLeaseKind::Pi, "/srv//work", "t"),
        scope(ProviderLeaseKind::Pi, "/srv/work/", "t"),
        scope(ProviderLeaseKind::Pi, "/srv/wo\nrk", "t"),
        scope(ProviderLeaseKind::Pi, "/srv/work", ""),
        scope(ProviderLeaseKind::Pi, "/srv/work", "a b"),
        scope(ProviderLeaseKind::Pi, "/srv/work", &"t".repeat(129)),
        scope(
            ProviderLeaseKind::Pi,
            &format!("/{}", "a".repeat(1100)),
            "t",
        ),
    ] {
        assert_eq!(admits(&refused, false), Err(ErrorCode::InvalidOperands));
    }
    let mut unknown = pi.clone();
    unknown.kind = 9;
    assert_eq!(admits(&unknown, false), Err(ErrorCode::InvalidOperands));
}

#[test]
fn the_question_feature_is_codex_start_only() {
    let mut codex = scope(ProviderLeaseKind::Codex, "/srv/work", "t");
    codex.default_mode_user_input = true;
    assert_eq!(admits(&codex, false), Ok(Kind::Codex));
    assert_eq!(admits(&codex, true), Err(ErrorCode::InvalidOperands));
    let mut pi = scope(ProviderLeaseKind::Pi, "/srv/work", "t");
    pi.default_mode_user_input = true;
    assert_eq!(admits(&pi, false), Err(ErrorCode::InvalidOperands));
}

#[test]
fn remote_command_quotes_operands_and_selects_only_compiled_verbs() {
    let mut codex = scope(ProviderLeaseKind::Codex, "/srv/it's", "t");
    codex.default_mode_user_input = true;
    codex.codex_home = Some("/home/u/.codex".into());
    let command = remote_command(Kind::Codex, &codex, "ab12", true);
    assert!(command.starts_with("exec /usr/bin/env -i LC_ALL=C HOME=\"$HOME\""));
    assert!(command.contains("USER=\"$USER\""));
    assert!(command.contains("PATH=/usr/bin:/bin"));
    assert!(
        command.ends_with(" codex '/srv/it'\\''s' 'ab12' 536870912 start 1 '' '/home/u/.codex'")
    );
    assert!(command.contains("args+=(-c features.default_mode_request_user_input=true)"));
    assert!(command.contains("/bin/sh -lc"));
    assert!(command.contains("session_guard 0"));
    // A probe never carries the question feature.
    let probe = remote_command(Kind::Codex, &codex, "ab12", false);
    assert!(probe.ends_with(" probe 0 '' '/home/u/.codex'"));
    let mut pi = scope(ProviderLeaseKind::Pi, "/srv/work", "t");
    pi.session_file = Some("/home/u/.pi/agent/sessions/x/s.jsonl".into());
    let resume = remote_command(Kind::Pi, &pi, "ab12", true);
    assert!(resume.ends_with(" start 0 '/home/u/.pi/agent/sessions/x/s.jsonl' ''"));
}

#[test]
fn a_resume_file_is_pi_only_and_a_codex_home_is_codex_only() {
    let mut pi = scope(ProviderLeaseKind::Pi, "/srv/work", "t");
    pi.session_file = Some("/home/u/.pi/agent/sessions/s.jsonl".into());
    assert_eq!(admits(&pi, false), Ok(Kind::Pi));
    pi.codex_home = Some("/home/u/.codex".into());
    assert_eq!(admits(&pi, false), Err(ErrorCode::InvalidOperands));
    let mut codex = scope(ProviderLeaseKind::Codex, "/srv/work", "t");
    codex.codex_home = Some("/home/u/.codex".into());
    assert_eq!(admits(&codex, true), Ok(Kind::Codex));
    codex.session_file = Some("/home/u/.pi/agent/sessions/s.jsonl".into());
    assert_eq!(admits(&codex, false), Err(ErrorCode::InvalidOperands));
    for bad in [
        "relative/s.jsonl",
        "/",
        "/home/u/../etc/passwd",
        "/home/u/a\nb",
    ] {
        let mut pi = scope(ProviderLeaseKind::Pi, "/srv/work", "t");
        pi.session_file = Some(bad.into());
        assert_eq!(admits(&pi, false), Err(ErrorCode::InvalidOperands), "{bad}");
    }
}

#[test]
fn only_the_exact_nonce_receipt_reports_a_missing_executable() {
    assert!(executable_missing(
        b"\nbigbud-provider-lease ab12 missing\n",
        "ab12"
    ));
    assert!(!executable_missing(
        b"bigbud-provider-lease ff00 missing\n",
        "ab12"
    ));
    assert!(!executable_missing(
        b"x bigbud-provider-lease ab12 missing\n",
        "ab12"
    ));
    assert!(!executable_missing(b"", "ab12"));
}

/// Runs the exact remote command through a local shell (no SSH): discovery
/// in the account's known locations, the shared guard, and the compiled argv.
#[cfg(target_os = "linux")]
#[test]
fn the_launch_script_discovers_a_guarded_executable_and_reports_a_missing_one() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    struct Home(std::path::PathBuf);
    impl Home {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            let _cleanup = std::fs::remove_dir_all(&self.0);
        }
    }
    let token = crate::random_token().unwrap();
    let home = Home(std::path::PathBuf::from(format!(
        "/tmp/bigbud-provider-lease-{:02x}{:02x}{:02x}{:02x}",
        token[0], token[1], token[2], token[3]
    )));
    std::fs::create_dir(home.path()).unwrap();
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let work = home.path().join("work");
    std::fs::create_dir(&work).unwrap();
    let work = work.to_str().unwrap().to_owned();
    let run = |kind: Kind| {
        Command::new("/bin/sh")
            .arg("-c")
            .arg(remote_command(
                kind,
                &scope(ProviderLeaseKind::Pi, &work, "t"),
                "ab12",
                false,
            ))
            .env_clear()
            .env("HOME", home.path())
            .env("SHELL", "/bin/false")
            .output()
            .unwrap()
    };
    let missing = run(Kind::Pi);
    assert_eq!(missing.status.code(), Some(125));
    assert!(executable_missing(&missing.stderr, "ab12"));

    let bin = home.path().join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    for dir in [home.path().join(".local"), bin.clone()] {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::copy("/usr/bin/true", bin.join("pi")).unwrap();
    std::fs::set_permissions(bin.join("pi"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let found = run(Kind::Pi);
    assert_eq!(found.status.code(), Some(0), "{found:?}");
    assert!(String::from_utf8_lossy(&found.stdout).contains("coreutils"));

    // A group-writable executable fails the guard and is never run.
    std::fs::set_permissions(bin.join("pi"), std::fs::Permissions::from_mode(0o775)).unwrap();
    let refused = run(Kind::Pi);
    assert_eq!(refused.status.code(), Some(125));
    // A different provider name is never satisfied by another's executable.
    std::fs::set_permissions(bin.join("pi"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(run(Kind::Codex).status.code(), Some(125));
}
