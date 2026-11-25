use super::{ProfileRefusal, parse};
use crate::{
    config::{RouteFacts, resolve_with_facts},
    startup_profile::{ProfileKind, digest},
};
use std::{
    ffi::OsString,
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "bigbud-production-startup-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    fs::canonicalize(&root).unwrap()
}

fn binding(root: &Path) -> String {
    let metadata = fs::symlink_metadata(root).unwrap();
    let digest = digest(
        ProfileKind::DesktopPackaged,
        root.to_str().unwrap(),
        &metadata.dev().to_string(),
        &metadata.ino().to_string(),
    );
    format!(
        "bbso1:desktop-packaged:{}",
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

fn args(root: &Path, extras: &[&str]) -> Vec<OsString> {
    let mut values = vec![
        "--profile".into(),
        binding(root).into(),
        "--state-dir".into(),
        root.as_os_str().into(),
        "ssh:fixture".into(),
        "/usr/bin/ssh".into(),
        "/usr/bin/ssh-keyscan".into(),
        "203.0.113.10".into(),
        "2222".into(),
        "tester".into(),
        "/tmp/identity".into(),
        "/tmp/known_hosts".into(),
    ];
    values.extend(extras.iter().map(|value| OsString::from(*value)));
    values
}

#[test]
fn requires_profile_and_state_directory_together() {
    let root = root();
    let mut missing = args(&root, &[]);
    missing.drain(0..4);
    assert_eq!(
        parse(missing.into_iter()).unwrap_err(),
        ProfileRefusal::MissingFlag
    );
    let mut no_state = args(&root, &[]);
    no_state.drain(2..4);
    assert_eq!(
        parse(no_state.into_iter()).unwrap_err(),
        ProfileRefusal::MissingFlag
    );
    let mut no_profile = args(&root, &[]);
    no_profile.drain(0..2);
    assert_eq!(
        parse(no_profile.into_iter()).unwrap_err(),
        ProfileRefusal::MissingFlag
    );
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn accepts_a_non_loopback_production_host_without_the_proof_environment() {
    let root = root();
    let parsed = parse(args(&root, &[]).into_iter()).expect("production args");
    assert_eq!(parsed.host.to_string(), "203.0.113.10");
    assert_eq!(parsed.port, 2222);
    assert_eq!(parsed.user, "tester");
    assert_eq!(parsed.state_directory, fs::canonicalize(&root).unwrap());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn rejects_every_fixture_flag() {
    let root = root();
    for flag in [
        "--posix-picker-master",
        "--posix-connector-picker",
        "--posix-cancellable-picker",
        "--posix-cancellable-mux-picker",
        "--posix-synthetic-password-picker",
        "--posix-cancellable-workspace-snapshot",
        "--dev-interactive-terminal",
        "--fixture-local-account",
        "--fixture-override-host",
        "--fixture-override-user",
        "--fixture-override-port",
        "--fixture-connector-image",
        "--fixture-connector-path",
        "--provider-service",
        "--opencode-service",
        "--agent-fixture",
        "--agent-sha256",
        "--installed-agent-state",
        "--client-relay-fixture",
        "--codex-fixture",
        "--pi-fixture",
        "--opencode-v1-fixture",
        "--paired-peer-fixture",
        "--git-advertisement-fixture",
        "--git-upload-fixture",
        "--git-tracked-push-fixture",
        "--deployment-stage-fixture",
        "--identity-agent-path",
    ] {
        assert_eq!(
            parse(args(&root, &[flag, "/tmp/value"]).into_iter()).unwrap_err(),
            ProfileRefusal::Conflict,
            "{flag}"
        );
    }
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn production_accepts_a_real_shaped_config_and_refuses_unsupported_policy() {
    let root = root();
    let identity = root.join("identity");
    let pins = root.join("pins");
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&identity)
        .unwrap()
        .write_all(b"synthetic key material")
        .unwrap();
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&pins)
        .unwrap();
    let config = root.join("config");
    fs::write(
        &config,
        format!(
            "Host picker\n HostName 203.0.113.10\n Port 2222\n User remote\n\
             IdentityFile {}\n UserKnownHostsFile {}\n",
            identity.display(),
            pins.display()
        ),
    )
    .unwrap();
    let facts = RouteFacts::default().with_production();
    let resolved =
        resolve_with_facts(&config, None, "picker", &facts, true).expect("real-shaped config");
    assert_eq!(resolved.host.to_string(), "203.0.113.10");
    assert_eq!(resolved.port, 2222);
    assert_eq!(resolved.user, "remote");
    assert_eq!(resolved.identity, fs::canonicalize(&identity).unwrap());

    fs::write(
        &config,
        format!(
            "Host picker\n HostName 203.0.113.10\n ProxyCommand /bin/false\n\
             IdentityFile {}\n UserKnownHostsFile {}\n",
            identity.display(),
            pins.display()
        ),
    )
    .unwrap();
    assert!(resolve_with_facts(&config, None, "picker", &facts, true).is_err());
    fs::remove_dir_all(&root).unwrap();
}
