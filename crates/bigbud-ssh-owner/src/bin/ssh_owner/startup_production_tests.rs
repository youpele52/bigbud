use super::{ProfileRefusal, parse};
use std::{
    ffi::OsString,
    fs,
    os::unix::fs::{DirBuilderExt, MetadataExt},
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
    fs::canonicalize(root).unwrap()
}

fn binding(root: &Path) -> String {
    let metadata = fs::symlink_metadata(root).unwrap();
    let digest = crate::startup_profile::digest(
        crate::startup_profile::ProfileKind::DesktopPackaged,
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

/// The production shape: profile, state directory and OpenSSH images only.
/// No target, host, port, user, identity or known-hosts argument.
fn args(root: &Path, extras: &[&str]) -> Vec<OsString> {
    let mut values: Vec<OsString> = vec![
        "--profile".into(),
        binding(root).into(),
        "--state-dir".into(),
        root.as_os_str().into(),
        "--ssh".into(),
        "/usr/bin/ssh".into(),
        "--keyscan".into(),
        "/usr/bin/ssh-keyscan".into(),
    ];
    values.extend(extras.iter().map(|value| OsString::from(*value)));
    values
}

#[test]
fn requires_profile_state_directory_and_both_images() {
    let root = root();
    for (label, mut values) in [
        ("profile", args(&root, &[])),
        ("state", args(&root, &[])),
        ("ssh", args(&root, &[])),
        ("keyscan", args(&root, &[])),
    ] {
        let range = match label {
            "profile" => 0..2,
            "state" => 2..4,
            "ssh" => 4..6,
            _ => 6..8,
        };
        values.drain(range);
        assert_eq!(
            parse(values.into_iter()).unwrap_err(),
            ProfileRefusal::MissingFlag,
            "{label}"
        );
    }
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn parses_a_target_free_production_launch() {
    let root = root();
    let parsed = parse(args(&root, &[]).into_iter()).expect("production args");
    assert_eq!(parsed.state_directory, fs::canonicalize(&root).unwrap());
    assert_eq!(parsed.ssh, PathBuf::from("/usr/bin/ssh"));
    assert_eq!(parsed.keyscan, PathBuf::from("/usr/bin/ssh-keyscan"));
    assert!(parsed.system_config.is_none());
    assert!(parsed.alias_config.is_none());
    assert!(parsed.attach_path.is_none());
    assert!(parsed.workspace_root.is_none());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn refuses_target_positionals_from_the_fixture_shape() {
    let root = root();
    // `<target> <ssh> <keyscan> <host> <port> <user> <identity> <known-hosts>`
    // is fixture-only argv and a conflict in production mode.
    let values = args(
        &root,
        &[
            "ssh:fixture",
            "/usr/bin/ssh",
            "/usr/bin/ssh-keyscan",
            "203.0.113.10",
            "2222",
            "tester",
            "/tmp/identity",
            "/tmp/known_hosts",
        ],
    );
    assert_eq!(
        parse(values.into_iter()).unwrap_err(),
        ProfileRefusal::Conflict
    );
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
fn parses_owner_selected_provider_bindings() {
    let root = root();
    let state = std::path::Path::new("/tmp/bb-agent-state");
    let sha256 = "0".repeat(64);
    let parsed = parse(
        args(
            &root,
            &[
                "--agent-binary",
                "/opt/bigbud-agent",
                "--agent-sha256",
                &sha256,
                "--agent-state",
                state.to_str().unwrap(),
            ],
        )
        .into_iter(),
    )
    .expect("owner-selected agent binding");
    assert!(parsed.agent_service.is_some());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    assert!(parsed.opencode_v2.is_none());
    #[cfg(target_os = "linux")]
    {
        let workspace = root.join("workspace");
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&workspace)
            .unwrap();
        // The retired OpenCode v1 service flag is refused, never ignored.
        assert_eq!(
            parse(
                args(
                    &root,
                    &[
                        "--workspace-root",
                        workspace.to_str().unwrap(),
                        "--opencode-service",
                        "/opt/opencode",
                    ],
                )
                .into_iter(),
            )
            .unwrap_err(),
            ProfileRefusal::Conflict
        );
        // OpenCode v2 still requires the authorized workspace root.
        let parsed = parse(
            args(
                &root,
                &[
                    "--workspace-root",
                    workspace.to_str().unwrap(),
                    "--opencode-v2-service",
                    "/opt/opencode-v2",
                ],
            )
            .into_iter(),
        )
        .expect("owner-selected OpenCode v2 binding");
        assert!(parsed.opencode_v2.is_some());
        // Without a workspace root the production recipe serves each
        // request's own absolute remote cwd (many targets, many workspaces).
        assert!(
            parse(args(&root, &["--opencode-v2-service", "/opt/opencode-v2"]).into_iter())
                .expect("target-free v2 binding")
                .opencode_v2
                .is_some()
        );
        // Without a configured path the owner discovers the executable on each
        // target; a configured path and discovery together are a conflict.
        assert!(
            parse(args(&root, &["--opencode-v2-discover"]).into_iter())
                .expect("discovering v2 binding")
                .opencode_v2
                .is_some()
        );
        assert_eq!(
            parse(
                args(
                    &root,
                    &[
                        "--opencode-v2-discover",
                        "--opencode-v2-service",
                        "/opt/opencode-v2"
                    ],
                )
                .into_iter(),
            )
            .unwrap_err(),
            ProfileRefusal::Conflict
        );
    }
    // A partial triple is a conflict, never a silently ignored binding.
    assert_eq!(
        parse(args(&root, &["--agent-binary", "/opt/bigbud-agent"]).into_iter()).unwrap_err(),
        ProfileRefusal::Conflict
    );
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_system_config_requires_an_alias_scope() {
    let root = root();
    let system = root.join("ssh_config");
    fs::write(&system, "Host *\n User remote\n").unwrap();
    assert_eq!(
        parse(args(&root, &["--system-config", system.to_str().unwrap()]).into_iter()).unwrap_err(),
        ProfileRefusal::MalformedProfile
    );
    let parsed = parse(
        args(
            &root,
            &[
                "--system-config",
                system.to_str().unwrap(),
                "--alias-config",
                system.to_str().unwrap(),
            ],
        )
        .into_iter(),
    )
    .expect("alias scope admits a system config");
    assert!(parsed.system_config.is_some());
    assert!(parsed.alias_config.is_some());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn refuses_a_profile_binding_for_another_state_directory() {
    let root = root();
    let other = root.join("other");
    fs::DirBuilder::new().mode(0o700).create(&other).unwrap();
    let mut values = args(&root, &[]);
    values[1] = binding(&other).into();
    assert_eq!(
        parse(values.into_iter()).unwrap_err(),
        ProfileRefusal::ProfileMismatch
    );
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn refuses_a_relative_image_path() {
    let root = root();
    let mut values = args(&root, &[]);
    values[5] = "ssh".into();
    assert_eq!(
        parse(values.into_iter()).unwrap_err(),
        ProfileRefusal::MalformedProfile
    );
    fs::remove_dir_all(&root).unwrap();
}
