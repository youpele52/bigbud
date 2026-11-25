use super::*;
use crate::transport::{TransportConfig, workspace::tests::Fixture, write_identity_fixture};
use std::{
    fs,
    net::Ipv4Addr,
    os::unix::{
        fs::{PermissionsExt, symlink},
        process::ExitStatusExt,
    },
    process::{Command, ExitStatus},
    time::Instant,
};

#[test]
fn accepts_only_known_uname_tokens_and_canonicalizes_case() {
    for (raw, os, architecture) in [
        (&b"Darwin\nARM64\n"[..], "darwin", "arm64"),
        (b"Linux\nx86_64\n", "linux", "x86_64"),
        (b"LINUX\nAMD64\n", "linux", "amd64"),
        (b"Linux\naarch64\n", "linux", "aarch64"),
    ] {
        assert_eq!(
            parse(raw),
            Ok(ProofWorkspaceReadinessResult {
                os: os.into(),
                architecture: architecture.into()
            })
        );
    }
    for raw in [
        &b""[..],
        b"Linux\n",
        b"Linux\narm64",
        b"Linux\narm64\n\n",
        b"Linux\narm64\nextra\n",
        b"banner\nLinux\narm64\n",
        b"Linux\r\narm64\r\n",
        b"Linux\n arm64\n",
        b"Linux\narm64\0\n",
        b"FreeBSD\nx86_64\n",
        b"Linux\ni686\n",
        b"Linux\n\xff\n",
    ] {
        assert_eq!(parse(raw), Err(ErrorCode::WorkspaceReadFailed), "{raw:?}");
    }
}

#[test]
fn rejects_failed_partial_noisy_and_truncated_execution() {
    let output = |code, stderr: &[u8], truncated| process::Output {
        status: ExitStatus::from_raw(code << 8),
        stdout: b"Linux\narm64\n".to_vec(),
        stderr: stderr.to_vec(),
        truncated,
    };
    assert_eq!(
        decode(output(0, b"", true)),
        Err(ErrorCode::WorkspaceReadFailed)
    );
    assert_eq!(
        decode(output(0, b"noise", false)),
        Err(ErrorCode::WorkspaceReadFailed)
    );
    assert_eq!(
        decode(output(1, b"", false)),
        Err(ErrorCode::WorkspaceReadFailed)
    );
    assert_eq!(
        decode(output(3, b"", false)),
        Err(ErrorCode::WorkspacePathDenied)
    );
    assert_eq!(
        decode(output(255, b"Host key verification failed.\n", false)),
        Err(ErrorCode::HostKeyChanged)
    );
}

#[test]
fn readiness_refuses_connector_routes_without_trying_direct_ssh() {
    let fixture = Fixture::new();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
    let mut transport = Transport::new(TransportConfig {
        ssh: "/test-no-ssh".into(),
        keyscan: "/test-no-keyscan".into(),
        host: Ipv4Addr::LOCALHOST.into(),
        port: 22222,
        user: "picker".into(),
        identity: write_identity_fixture(&fixture.0),
        known_hosts: fixture.0.join("known_hosts"),
        alias_config: None,
        system_config: None,
        workspace_root: Some(fixture.0.clone()),
        dev_interactive_terminal: false,
    })
    .unwrap();
    transport.connector = Some(Err(ErrorCode::RouteUnavailable));
    assert_eq!(
        transport.probe_workspace_readiness(&ProofWorkspaceReadiness {
            workspace_root: fixture.root().into()
        }),
        Err(ErrorCode::RouteUnavailable)
    );
}

fn run_recipe(root: &str) -> Result<ProofWorkspaceReadinessResult, ErrorCode> {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", &workspace_command(RECIPE, root, "")]);
    let output =
        process::run_with_combined_output_limit(command, Instant::now() + DEADLINE, OUTPUT_LIMIT)
            .map_err(|_| ErrorCode::WorkspaceReadFailed)?;
    decode(output)
}

#[test]
fn fixed_recipe_checks_the_literal_physical_root_then_reads_host_facts() {
    let fixture = Fixture::new();
    let workspace = fixture.0.join("picker's folders; literal");
    fs::create_dir(&workspace).unwrap();
    let readiness = run_recipe(workspace.to_str().unwrap()).unwrap();
    let expected_os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    assert_eq!(readiness.os, expected_os);
    let symlink_root = fixture.0.join("symlink");
    symlink(&workspace, &symlink_root).unwrap();
    let file_root = fixture.0.join("not-a-directory");
    fs::write(&file_root, b"fixture").unwrap();
    for root in [
        symlink_root.clone(),
        symlink_root.join("child"),
        file_root,
        fixture.0.join("missing"),
    ] {
        assert_eq!(
            run_recipe(root.to_str().unwrap()),
            Err(ErrorCode::WorkspacePathDenied)
        );
    }
}
