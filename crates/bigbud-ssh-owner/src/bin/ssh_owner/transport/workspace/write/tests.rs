use super::super::super::TransportConfig;
use super::super::tests::Fixture;
use super::*;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, ExitStatus};

fn operand(root: &str, relative: &str, contents: Vec<u8>) -> v1::ProofWorkspaceWrite {
    v1::ProofWorkspaceWrite {
        workspace_root: root.into(),
        relative_path: relative.into(),
        contents,
    }
}

fn local_write(root: &str, relative: &str, contents: &[u8]) -> Result<(), ErrorCode> {
    let remote = command(
        Some(Path::new(root)),
        &operand(root, relative, contents.to_vec()),
    )?;
    local_run(&remote, contents)
}

fn local_run(remote: &str, input: &[u8]) -> Result<(), ErrorCode> {
    let mut child = Command::new("/bin/sh");
    child.args(["-c", remote]);
    decode(
        process::run_with_input(child, Instant::now() + WRITE_TIMEOUT, ACK_LIMIT, input)
            .map_err(process_failure)?,
    )
}

#[test]
fn bounds_content_and_validates_exact_scope_before_launch() {
    let root = "/fixtures/workspace";
    let configured = Some(Path::new(root));
    let mut request = operand(root, "file", vec![0xAB; MAX_CONTENT_BYTES]);
    assert!(command(configured, &request).is_ok());
    request.contents.push(0);
    assert_eq!(
        command(configured, &request),
        Err(ErrorCode::InvalidOperands)
    );
    for (requested, relative) in [
        ("/fixtures/other", "file"),
        ("/fixtures/workspace/", "file"),
        (root, ""),
        (root, "../other"),
        (root, "nested/../other"),
        (root, "/outside"),
        (root, "C:/outside"),
        (root, "\\outside"),
        (root, "file\0suffix"),
    ] {
        assert_eq!(
            command(configured, &operand(requested, relative, vec![])),
            Err(ErrorCode::WorkspacePathDenied)
        );
    }
    assert_eq!(
        command(None, &operand(root, "file", vec![])),
        Err(ErrorCode::WorkspacePathDenied)
    );
}

#[test]
fn creates_nested_paths_and_atomically_overwrites_with_binary_or_empty_stdin() {
    let fixture = Fixture::new();
    let relative = "-dir '$(exit 9)'\n/._file *\t雪";
    let contents: Vec<_> = (0..=255).cycle().take(MAX_CONTENT_BYTES).collect();
    local_write(fixture.root(), relative, &contents).expect("create nested file at limit");
    let target = fixture.0.join(relative);
    assert_eq!(fs::read(&target).unwrap(), contents);
    // An open file handle still sees the old bytes after the replacement.
    let mut old = fs::File::open(&target).unwrap();
    local_write(fixture.root(), relative, &[]).expect("overwrite with empty contents");
    assert!(fs::read(&target).unwrap().is_empty());
    let mut old_contents = Vec::new();
    std::io::Read::read_to_end(&mut old, &mut old_contents).unwrap();
    assert_eq!(old_contents, contents);
    assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn rejects_static_links_and_nonregular_paths_without_touching_their_targets() {
    let fixture = Fixture::new();
    let root = fixture.0.join("workspace");
    let outside = fixture.0.join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("file"), b"untouched").unwrap();
    fs::write(root.join("ordinary"), b"untouched").unwrap();
    symlink(&outside, root.join("escape")).unwrap();
    symlink(outside.join("file"), root.join("leaf")).unwrap();
    symlink("absent", root.join("dangling")).unwrap();
    symlink(&root, fixture.0.join("linked-root")).unwrap();
    symlink(&fixture.0, fixture.0.join("linked-ancestor")).unwrap();
    fs::create_dir(root.join("directory")).unwrap();
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(root.join("fifo"))
            .status()
            .unwrap()
            .success()
    );
    let root = root.to_str().unwrap();
    for (root, relative) in [
        (root, "escape/new/file"),
        (root, "leaf"),
        (root, "dangling"),
        (root, "ordinary/child"),
        (root, "directory"),
        (root, "fifo"),
        (&format!("{}/linked-root", fixture.root()), "file"),
        (
            &format!("{}/linked-ancestor/workspace", fixture.root()),
            "file",
        ),
    ] {
        assert_eq!(
            local_write(root, relative, &[1; MAX_CONTENT_BYTES]),
            Err(ErrorCode::WorkspacePathDenied),
            "{root:?} {relative:?}"
        );
    }
    assert_eq!(fs::read(outside.join("file")).unwrap(), b"untouched");
    assert!(!outside.join("new").exists());
    assert!(!Path::new(root).join("absent").exists());
}

#[test]
fn short_input_does_not_replace_the_destination_and_cleans_the_stage() {
    let fixture = Fixture::new();
    let target = fixture.0.join("file");
    fs::write(&target, b"original").unwrap();
    let remote = command(
        Some(&fixture.0),
        &operand(fixture.root(), "file", vec![1, 2, 3]),
    )
    .unwrap();
    assert_eq!(
        local_run(&remote, &[1, 2]),
        Err(ErrorCode::WorkspaceWriteFailed)
    );
    assert_eq!(fs::read(&target).unwrap(), b"original");
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
}

#[test]
fn short_input_after_parent_creation_is_a_partial_outcome() {
    let fixture = Fixture::new();
    let remote = command(
        Some(&fixture.0),
        &operand(fixture.root(), "created/nested/file", vec![1, 2, 3]),
    )
    .unwrap();

    assert_eq!(local_run(&remote, &[1, 2]), Err(ErrorCode::OutcomeUnknown));
    let parent = fixture.0.join("created/nested");
    assert!(parent.is_dir());
    assert_eq!(fs::read_dir(parent).unwrap().count(), 0);
}

#[test]
fn missing_or_unreliable_acknowledgements_are_unknown() {
    for (raw_status, stdout, truncated) in [
        (0, &b""[..], false),
        (1 << 8, &b""[..], false),
        (3 << 8, &b""[..], false),
        (1 << 8, MARKER, false),
        (1 << 8, DENIED_MARKER, false),
        (3 << 8, DENIED_MARKER, true),
        (0, MARKER, true),
        (libc::SIGTERM, MARKER, false),
        (255 << 8, MARKER, false),
    ] {
        assert_eq!(
            decode(process::Output {
                status: ExitStatus::from_raw(raw_status),
                stdout: stdout.to_vec(),
                stderr: b"Permission denied (publickey).".to_vec(),
                truncated,
            }),
            Err(ErrorCode::OutcomeUnknown)
        );
    }
}

#[test]
fn blocked_stdin_respects_the_process_deadline() {
    let mut child = Command::new("/bin/sleep");
    child.arg("8");
    // Exercise the shared pump with more data than a pipe can buffer.
    let input = vec![0; 1024 * 1024];
    let start = Instant::now();
    let result = process::run_with_input(
        child,
        start + Duration::from_millis(100),
        MARKER.len(),
        &input,
    );
    assert!(matches!(result, Err(process::Failure::TimedOut)));
    assert_eq!(
        process_failure(process::Failure::TimedOut),
        ErrorCode::OutcomeUnknown
    );
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn pinned_launch_passes_binary_stdin_and_does_not_replay_a_lost_result() {
    let fixture = Fixture::new();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
    let ssh = fixture.0.join("ssh-fixture");
    let known_hosts = fixture.0.join("known_hosts");
    let pin = "[127.0.0.1]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    fs::write(&known_hosts, format!("{pin}\n")).unwrap();
    fs::set_permissions(&known_hosts, fs::Permissions::from_mode(0o600)).unwrap();
    let calls = fixture.0.join("calls");
    let status_path = fixture.0.join("ssh-exit-status");
    fs::write(
        &ssh,
        format!(
            r#"#!/bin/sh
[ "$1" = -4 ] && [ "$2" = -T ] && [ "$3" = -F ] && [ "$4" = /dev/null ] || exit 80
while [ "$1" != -- ]; do
  [ "$#" -gt 0 ] || exit 81
  case "$1" in
    StrictHostKeyChecking=yes) strict=yes ;;
    UserKnownHostsFile=*) IFS= read -r pin < "${{1#*=}}" || exit 82 ;;
  esac
  shift
done
[ "$strict" = yes ] && [ "$pin" = {} ] || exit 83
[ "$#" -eq 3 ] && [ "$2" = 127.0.0.1 ] || exit 84
printf x >> {} || exit 85
/bin/sh -c "$3" >/dev/null || exit 86
IFS= read -r status < {} || exit 87
exit "$status"
"#,
            super::super::quote(pin),
            super::super::quote(calls.to_str().unwrap()),
            super::super::quote(status_path.to_str().unwrap()),
        ),
    )
    .unwrap();
    fs::set_permissions(&ssh, fs::Permissions::from_mode(0o700)).unwrap();
    let transport = Transport::new(TransportConfig {
        ssh,
        keyscan: "/usr/bin/false".into(),
        host: "127.0.0.1".parse().unwrap(),
        port: 2200,
        user: "fixture".into(),
        identity: crate::transport::write_identity_fixture(&fixture.0),
        known_hosts,
        alias_config: None,
        system_config: None,
        workspace_root: Some(fixture.0.clone()),
        dev_interactive_terminal: false,
        host_identity: Default::default(),
    })
    .unwrap();
    let mut contents = "é".repeat(MAX_CONTENT_BYTES / 2).into_bytes();
    contents.push(b'x');
    let mut request = operand(fixture.root(), "written", contents);
    assert_eq!(write(&transport, &request), Err(ErrorCode::InvalidOperands));
    assert!(!calls.exists());
    assert!(!fixture.0.join("written").exists());

    assert_eq!(request.contents.pop(), Some(b'x'));
    // The recorder commits each overwrite but withholds the script's marker.
    // Neither a transport error nor an uncorroborated status 1/3 can settle it.
    for (index, status) in [255, 1, 3].into_iter().enumerate() {
        fs::write(&status_path, format!("{status}\n")).unwrap();
        request.contents[0] = u8::try_from(status).unwrap();
        assert_eq!(write(&transport, &request), Err(ErrorCode::OutcomeUnknown));
        assert_eq!(
            fs::read(fixture.0.join("written")).unwrap(),
            request.contents
        );
        assert_eq!(fs::read(&calls).unwrap().len(), index + 1);
    }
}
