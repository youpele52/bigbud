use super::*;

fn workspace(directory: &Directory) -> PathBuf {
    let root = directory
        .0
        .canonicalize()
        .expect("physical fixture directory")
        .join("workspace's $(false)");
    fs::create_dir(&root).expect("create workspace");
    root
}

#[test]
fn dev_interactive_runs_a_real_shell_in_the_workspace_and_keeps_the_final_output() {
    let directory = Directory::new();
    let root = workspace(&directory);
    let script = PAUSED_SSH.replace(
        "exec /bin/sh -c",
        "export ENV=/dev/null BIGBUD_TEST_INHERITED=unexpected\nexec /bin/sh -c",
    );
    let transport = directory.transport_with_workspace(&script, true, Some(root.clone()), true);
    let lease = transport
        .open_prepared_terminal(root.to_str().expect("fixture path"), 90, 30)
        .expect("interactive shell prompt");
    let started = lease.snapshot().expect("open status");
    assert!(started.live);
    assert!(started.sample.ends_with(DEV_PROMPT.as_bytes()));
    assert_eq!(directory.pins().len(), 1);
    lease
        .write_proof_input(
            1,
            b"printf 'CHECK:%s:%s:%s:%s\\n' \"$(pwd -P)\" \"$(stty size)\" \"${ENV-unset}\" \"${BIGBUD_TEST_INHERITED-unset}\"\n",
        )
        .expect("send shell input");
    wait_for_line(
        &lease,
        &format!("CHECK:{}:30 90:unset:unset", root.display()),
    );
    lease.resize_proof_terminal(100, 40).expect("resize PTY");
    lease
        .write_proof_input(2, b"stty size\n")
        .expect("send size check");
    wait_for_line(&lease, "40 100");
    lease
        .write_proof_input(3, b"printf 'FINAL:%s\\n' drained; exit 17\n")
        .expect("exit shell");
    let deadline = Instant::now() + Duration::from_secs(2);
    let exited = loop {
        let status = lease.snapshot().expect("status during exit");
        if !status.live {
            break status;
        }
        assert!(Instant::now() < deadline, "shell did not exit");
        thread::sleep(POLL);
    };
    assert_eq!(exited.pid, started.pid);
    assert!(lease.handle.child_reaped());
    assert_eq!(
        lease.handle.snapshot().expect("native exit").exit_code,
        Some(17)
    );
    let replay = lease.replay_proof_terminal(0).expect("replay after exit");
    let replayed = replay
        .chunks
        .into_iter()
        .flat_map(|(_, data)| data)
        .collect::<Vec<_>>();
    assert_eq!(replayed, exited.sample);
    assert!(
        String::from_utf8_lossy(&replayed)
            .lines()
            .any(|line| line == "FINAL:drained")
    );
    assert_eq!(
        lease.write_proof_input(4, b"after exit\n"),
        Err(ErrorCode::OperationDenied)
    );
    lease.revoke().expect("idempotent reap after natural exit");
}

#[test]
fn dev_interactive_refuses_unbound_cwd_unpinned_ssh_and_symlink_root() {
    let directory = Directory::new();
    let root = workspace(&directory);
    let cwd = root.to_str().expect("fixture path");
    let untrusted = directory.transport_with_workspace(PAUSED_SSH, false, Some(root.clone()), true);
    assert!(matches!(
        untrusted.open_prepared_terminal("/other", 80, 24),
        Err(ErrorCode::WorkspacePathDenied)
    ));
    assert!(matches!(
        untrusted.open_prepared_terminal(cwd, 80, 24),
        Err(ErrorCode::TrustRequired)
    ));

    let alias = root.with_file_name("alias");
    std::os::unix::fs::symlink(root, &alias).expect("symlink workspace");
    let transport = directory.transport_with_workspace(PAUSED_SSH, true, Some(alias.clone()), true);
    assert!(
        transport
            .open_prepared_terminal(alias.to_str().expect("alias path"), 80, 24)
            .is_err()
    );
    assert!(directory.pins().is_empty());
}

#[test]
fn bound_workspace_still_uses_literal_proof_echo_without_opt_in() {
    let directory = Directory::new();
    let root = workspace(&directory);
    let transport = directory.transport_with_workspace(PAUSED_SSH, true, Some(root.clone()), false);
    let lease = transport
        .open_prepared_terminal(root.to_str().expect("fixture path"), 80, 24)
        .expect("proof terminal");
    lease
        .write_proof_input(1, b"exit 17\n")
        .expect("send literal input");
    wait_for_line(&lease, "BIGBUD_SSH_OWNER_PROOF_PTY_ECHO:exit 17");
    assert!(lease.snapshot().expect("proof status").live);
}

#[test]
fn dev_interactive_does_not_accept_a_legacy_ready_marker_or_a_missing_tty() {
    let directory = Directory::new();
    let root = workspace(&directory);
    let no_tty = PAUSED_SSH.replace("-c \"$arg\"", "-c \"$arg\" </dev/null");
    for script in [
        "#!/bin/sh\nprintf '%s\\n' BIGBUD_SSH_OWNER_PROOF_PTY_READY\n",
        &no_tty,
    ] {
        let transport = directory.transport_with_workspace(script, true, Some(root.clone()), true);
        assert!(matches!(
            transport.open_prepared_terminal(root.to_str().expect("fixture path"), 80, 24),
            Err(ErrorCode::TransportLost)
        ));
        assert!(directory.pins().is_empty());
    }
}
