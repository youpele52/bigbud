use super::*;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
#[test]
fn spawns_a_shell_and_replays_bounded_output() {
    let root = std::env::temp_dir().join(format!(
        "bigbud-pty-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let job = PtyHandle::spawn(
        "pty-1".to_owned(),
        &root,
        "sh",
        &["-c".to_owned(), "printf hello".to_owned()],
        80,
        24,
        &[("TERM".to_owned(), "xterm-256color".to_owned())],
    )
    .unwrap();
    let events = read_events(job.reader, job.handle.pid);
    let output = events
        .iter()
        .filter_map(|event| match event {
            PtyEvent::Output(bytes) => Some(bytes.as_slice()),
            PtyEvent::Exited { .. } => None,
        })
        .flatten()
        .copied()
        .collect::<Vec<_>>();
    let chunk = job.handle.append_output(output).unwrap();
    assert_eq!(chunk.bytes, b"hello");
    assert_eq!(job.handle.replay(0).unwrap().len(), 1);
    job.handle.close(false).unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn rejects_duplicate_and_gapped_input_sequences() {
    #[cfg(unix)]
    {
        let root = std::env::temp_dir();
        let job = PtyHandle::spawn(
            "pty-2".to_owned(),
            &root,
            "sh",
            &["-c".to_owned(), "sleep 1".to_owned()],
            80,
            24,
            &[],
        )
        .unwrap();
        assert!(job.handle.write_input(1, b"x").unwrap());
        assert!(!job.handle.write_input(1, b"x").unwrap());
        assert!(matches!(
            job.handle.write_input(3, b"x"),
            Err(PtyError::InputSequence { .. })
        ));
        job.handle.signal("SIGKILL").unwrap();
    }
}

#[cfg(unix)]
#[test]
fn preserves_remote_identity_environment_and_selects_a_safe_shell() {
    let result = super::environment::remote_environment(&[
        ("TERM".to_owned(), "xterm".to_owned()),
        ("HOME".to_owned(), "/untrusted".to_owned()),
        ("PATH".to_owned(), "/untrusted/bin".to_owned()),
        ("SHELL".to_owned(), "/untrusted/shell".to_owned()),
        ("USER".to_owned(), "untrusted-user".to_owned()),
        ("LOGNAME".to_owned(), "untrusted-logname".to_owned()),
    ])
    .unwrap();
    assert_eq!(
        result.iter().find(|(name, _)| name == "TERM").unwrap().1,
        "xterm"
    );
    for (name, untrusted) in [
        ("HOME", "/untrusted"),
        ("PATH", "/untrusted/bin"),
        ("USER", "untrusted-user"),
        ("LOGNAME", "untrusted-logname"),
    ] {
        assert_ne!(
            result.iter().find(|(key, _)| key == name).unwrap().1,
            untrusted
        );
    }
    let shell = result.iter().find(|(name, _)| name == "SHELL").unwrap();
    assert!(shell.1.starts_with('/'));
}

#[cfg(unix)]
#[test]
fn accepts_executable_shell_symlinks_and_rejects_non_executable_files() {
    let root = std::env::temp_dir().join(format!(
        "bigbud-pty-shell-validation-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let executable = root.join("executable");
    let non_executable = root.join("non-executable");
    let symlink = root.join("shell-link");
    std::fs::write(&executable, "#!/bin/sh\n").unwrap();
    std::fs::write(&non_executable, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(&non_executable, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::os::unix::fs::symlink(&executable, &symlink).unwrap();

    assert!(super::environment::is_executable_absolute(
        symlink.to_str().unwrap()
    ));
    assert!(!super::environment::is_executable_absolute(
        non_executable.to_str().unwrap()
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn pty_wrapper_executes_selected_shell_and_preserves_workspace_cwd() {
    let root = std::env::temp_dir().join(format!(
        "bigbud-pty-wrapper-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let workspace = root.join("workspace");
    let fixture_shell = root.join("fixture-shell");
    let success_marker = root.join("success");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(
        &fixture_shell,
        "#!/bin/sh\nprintf 'fixture-shell\\n%s\\n' \"$PWD\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&fixture_shell, std::fs::Permissions::from_mode(0o700)).unwrap();

    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("pty_wrapper_child_uses_selected_shell_and_workspace_cwd")
        .arg("--nocapture")
        .env("SHELL", &fixture_shell)
        .env("BIGBUD_PTY_WRAPPER_WORKSPACE", &workspace)
        .env("BIGBUD_PTY_WRAPPER_SUCCESS", &success_marker)
        .status()
        .unwrap();

    assert!(status.success());
    assert!(success_marker.is_file());
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn pty_wrapper_child_uses_selected_shell_and_workspace_cwd() {
    let Some(workspace) = std::env::var_os("BIGBUD_PTY_WRAPPER_WORKSPACE") else {
        return;
    };
    let success_marker = std::env::var_os("BIGBUD_PTY_WRAPPER_SUCCESS").unwrap();
    let workspace = std::path::PathBuf::from(workspace);
    let job = PtyHandle::spawn(
        "pty-wrapper-child".to_owned(),
        &workspace,
        "/bin/sh",
        &["-lc".to_owned(), "exec \"${SHELL:-/bin/sh}\" -l".to_owned()],
        80,
        24,
        &[],
    )
    .unwrap();
    let output = read_events(job.reader, job.handle.pid)
        .into_iter()
        .filter_map(|event| match event {
            PtyEvent::Output(bytes) => Some(bytes),
            PtyEvent::Exited { .. } => None,
        })
        .flatten()
        .collect::<Vec<_>>();
    let output = String::from_utf8_lossy(&output);
    assert!(output.contains("fixture-shell"));
    assert!(output.contains(workspace.to_str().unwrap()));
    std::fs::write(success_marker, "ok").unwrap();
}
